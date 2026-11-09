import { lstatSync } from "node:fs";
import { posix } from "node:path";

import type { Context } from "./context.ts";
import { type Conventions, CONVENTIONS_SCHEMA } from "./convention-schema.ts";
import { expand, fail, substitutes, validateTemplate, valuesFor } from "./convention-templates.ts";
import type { Diagnostic, Rule } from "./diagnostics.ts";
import { asError, errorCode, errorMessage } from "./errors.ts";
import { globMatches, isPolicyFile, normalize, safePath } from "./files.ts";
import { validateSchema } from "./schema.ts";

export const RULES: Rule[] = (
  [
    [
      "conventions.scope",
      "Every declared convention scope contains readable selected inputs.",
      false,
    ],
    ["conventions.role", "Every governed source has exactly one architectural role.", false],
    ["conventions.name", "Role filenames follow their declared naming pattern.", true],
    ["conventions.companion", "Role files have their required selected companion files.", true],
  ] as const
).map(([id, description, suppressible]): Rule => ({
  id,
  description,
  suppressible,
  remedy:
    "Correct the source layout to satisfy its declared role; review policy changes separately.",
}));

type Role = Conventions["roles"][number];

type ConventionContext = Pick<Context, "root" | "files" | "config" | "configFile"> &
  Partial<Pick<Context, "allFiles" | "safePath" | "ownedFiles" | "protectedFiles">>;

export interface ConventionPlan {
  files: { path: string; roles: string[]; role?: string; excluded: boolean; reasons: string[] }[];
  roles: { id: string; files: string[] }[];
  diagnostics: Diagnostic[];
}

export interface Proposal {
  path: string;
  content: string;
  role?: string;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort(compare);

const issue = (rule: string, path: string, message: string, incomplete = false): Diagnostic => ({
  rule,
  path,
  message,
  remedy: "Restore the required source or correct its declared role and scope.",
  status: incomplete ? "incomplete" : "violation",
  suppressible: !incomplete && ["conventions.name", "conventions.companion"].includes(rule),
});

// the same definition drives runtime validation, generated JSON Schema and scaffolding.
export function validateConventions(value: unknown): Conventions | undefined {
  if (value === undefined) {
    return value;
  }
  validateSchema(value, CONVENTIONS_SCHEMA, "conventions");
  if (value.roles.length > 256) {
    fail("at most 256 roles may be declared");
  }
  const ids = new Set<string>();
  for (const role of value.roles) {
    if (ids.has(role.id)) {
      fail(`duplicate role ${role.id}`);
    }
    ids.add(role.id);
    if (role.imports && role.imports.allow === undefined && !role.imports.deny?.length) {
      fail(`${role.id}: imports must constrain allow or deny`);
    }
    if (
      role.exports &&
      role.exports.allow === undefined &&
      !role.exports.require?.length &&
      !role.exports.name
    ) {
      fail(`${role.id}: exports must constrain names`);
    }
    const { exports } = role;
    if (
      exports?.require?.some(
        (name) =>
          (exports.allow && !exports.allow.includes(name)) ||
          (exports.name && !new RegExp(exports.name).test(name)),
      )
    ) {
      fail(`${role.id}: required exports conflict with allowed names`);
    }
    if (role.javascript && !Object.keys(role.javascript).length) {
      fail(`${role.id}: javascript cannot be empty`);
    }
    if (role.javascript?.budgets && !Object.keys(role.javascript.budgets).length) {
      fail(`${role.id}: budgets cannot be empty`);
    }
    const assertions = new Set<string>();
    const declared: { id: string; count?: { min?: number; max?: number } }[] = [
      ...(role.javascript?.nodes ?? []),
      ...(role.javascript?.assignable ?? []),
    ];
    for (const assertion of declared) {
      if (assertions.has(assertion.id)) {
        fail(`${role.id}: duplicate assertion ${assertion.id}`);
      }
      assertions.add(assertion.id);
      if (
        assertion.count &&
        ((!((assertion.count.min ?? 0) > 0) && assertion.count.max === undefined) ||
          (assertion.count.min ?? 0) > (assertion.count.max ?? Infinity))
      ) {
        fail(
          `${role.id}/${assertion.id}: count must define a meaningful, ordered minimum or maximum`,
        );
      }
    }
    for (const companion of role.companions ?? []) {
      validateTemplate(companion, substitutes);
    }
    if (role.scaffold) {
      validateTemplate(role.scaffold, ["name"]);
      if ((role.scaffold.companions?.length ?? 0) > 63) {
        fail("a scaffold can create at most 64 source files");
      }
      for (const companion of role.scaffold.companions ?? []) {
        validateTemplate(companion, substitutes);
      }
    }
  }
  for (const role of value.roles) {
    for (const companion of role.companions ?? []) {
      if (companion.role && !ids.has(companion.role)) {
        fail(`${role.id}: unknown companion role ${companion.role}`);
      }
    }
  }
  return value;
}

export function planConventions(ctx: ConventionContext): ConventionPlan {
  const value = ctx.config.conventions;
  const plan: ConventionPlan = { files: [], roles: [], diagnostics: [] };
  if (!value) {
    return plan;
  }
  try {
    validateConventions(value);
  } catch (error) {
    plan.diagnostics.push(issue("conventions.scope", ctx.configFile, errorMessage(error), true));
    return plan;
  }
  const reasons = (path: string): string[] =>
    (ctx.config.exclude ?? [])
      .filter((entry) => globMatches(entry.files, path))
      .map((entry) => entry.reason);
  const selected = new Set(ctx.files.filter((path) => !reasons(path).length).map(normalize));
  const governed = unique([...(ctx.allFiles ?? ctx.files), ...ctx.files].map(normalize)).filter(
    (path) => globMatches(value.files, path),
  );
  const files = governed.filter((path) => selected.has(path));
  const scope = (patterns: readonly string[], label: string): void => {
    for (const pattern of patterns) {
      if (!files.some((path) => globMatches(pattern, path))) {
        plan.diagnostics.push(
          issue(
            "conventions.scope",
            ctx.configFile,
            `${label}: no selected governed files match ${pattern}.`,
            true,
          ),
        );
      }
    }
  };
  scope(value.files, "Governed source");
  for (const role of value.roles) {
    scope(role.files, `Role ${role.id}`);
  }
  for (const path of governed) {
    const roles = value.roles
      .filter((role) => globMatches(role.files, path))
      .map((role) => role.id)
      .sort(compare);
    const excluded = !selected.has(path),
      why = reasons(path);
    plan.files.push({
      path,
      roles,
      ...(roles.length === 1 && { role: roles[0] }),
      excluded,
      reasons: why,
    });
    if (excluded) {
      if (!why.length) {
        plan.diagnostics.push(
          issue(
            "conventions.scope",
            path,
            "Governed source is absent from the selected inventory without a declared exclusion.",
            true,
          ),
        );
      }
    } else if (roles.length !== 1) {
      plan.diagnostics.push(
        issue(
          "conventions.role",
          path,
          roles.length
            ? `Source matches multiple roles: ${roles.join(", ")}.`
            : "Source has no declared architectural role.",
        ),
      );
    }
  }
  plan.roles = value.roles.map(({ id }) => ({
    id,
    files: plan.files.filter((file) => !file.excluded && file.role === id).map((file) => file.path),
  }));
  return plan;
}

const guarded = (
  ctx: ConventionContext,
  path: string,
  options?: { allowMissing?: boolean },
): string => (ctx.safePath ? ctx.safePath(path, options) : safePath(ctx.root, path, options));

const regular = (ctx: ConventionContext, path: string): void => {
  if (!lstatSync(guarded(ctx, path)).isFile()) {
    throw new Error("The selected input is not a regular file");
  }
};

export function checkConventions(
  ctx: ConventionContext,
  plan: ConventionPlan = planConventions(ctx),
): Diagnostic[] {
  const diagnostics = [...plan.diagnostics];
  if (!ctx.config.conventions || diagnostics.some((item) => item.status === "incomplete")) {
    return diagnostics;
  }
  const selected = new Set(
    ctx.files.filter(
      (path) => !(ctx.config.exclude ?? []).some((entry) => globMatches(entry.files, path)),
    ),
  );
  const roles = new Map<string, Role>(ctx.config.conventions.roles.map((role) => [role.id, role]));
  for (const file of plan.files.filter((file) => !file.excluded && file.role)) {
    const role = roles.get(file.role ?? "");
    if (!role) {
      continue;
    }
    try {
      regular(ctx, file.path);
    } catch (error) {
      diagnostics.push(issue("conventions.scope", file.path, errorMessage(error), true));
      continue;
    }
    if (role.name && !new RegExp(role.name).test(posix.basename(file.path))) {
      diagnostics.push(
        issue(
          "conventions.name",
          file.path,
          `Role ${role.id} requires a filename matching ${role.name}.`,
        ),
      );
    }
    for (const companion of role.companions ?? []) {
      let target: string | undefined;
      try {
        target = expand(companion.path, valuesFor(file.path), true);
        if (target === file.path) {
          throw new Error("A required companion must be a different file");
        }
        regular(ctx, target);
        if (!selected.has(target)) {
          throw new Error(`Companion ${target} is outside the selected inventory`);
        }
        if (
          companion.role &&
          plan.files.find((item) => item.path === target && !item.excluded)?.role !== companion.role
        ) {
          diagnostics.push(
            issue(
              "conventions.companion",
              file.path,
              `Companion ${target} must have role ${companion.role}.`,
            ),
          );
        }
      } catch (error) {
        diagnostics.push(
          issue(
            "conventions.companion",
            file.path,
            `Role ${role.id} needs companion ${target ?? companion.path}: ${errorMessage(error)}`,
            errorCode(error) !== "ENOENT",
          ),
        );
      }
    }
  }
  return diagnostics;
}

// proposals are literal data. The caller checks an isolated candidate before transactional creation.
export function scaffoldProposals(
  ctx: ConventionContext,
  { role: roleId, name }: { role: string; name: unknown },
): Proposal[] {
  const value = validateConventions(ctx.config.conventions);
  const role = value?.roles.find((entry) => entry.id === roleId);
  if (!value || !role?.scaffold) {
    return fail(`role ${roleId} has no scaffold`);
  }
  const { scaffold } = role;
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) {
    return fail("scaffold name must be one identifier-like path segment of at most 64 characters");
  }
  const first: Proposal = {
    path: expand(scaffold.path, { name }, true),
    content: expand(scaffold.content, { name }),
  };
  const values = valuesFor(first.path, name);
  const proposals: Proposal[] = [
    first,
    ...(scaffold.companions ?? []).map((entry) => ({
      path: expand(entry.path, values, true),
      content: expand(entry.content, values),
    })),
  ];
  const seen = new Set<string>(),
    existing = new Set((ctx.allFiles ?? ctx.files).map((path) => normalize(path).toLowerCase()));
  for (const proposal of proposals) {
    const key = proposal.path.toLowerCase();
    if (seen.has(key)) {
      fail(`duplicate scaffold target ${proposal.path}`);
    }
    seen.add(key);
    const absolute = guarded(ctx, proposal.path, { allowMissing: true });
    try {
      lstatSync(absolute);
      fail(`scaffold cannot overwrite ${proposal.path}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw asError(error);
      }
    }
    if (existing.has(key)) {
      fail(`scaffold target conflicts with an existing input: ${proposal.path}`);
    }
    if (
      isPolicyFile(ctx.config, proposal.path, ctx.configFile) ||
      proposal.path.endsWith(".surface.json") ||
      [
        ...(ctx.ownedFiles ?? []),
        ...(ctx.protectedFiles ?? []),
        ...(ctx.config.generated ?? []).map((entry) => entry.path),
      ].includes(proposal.path)
    ) {
      fail(`scaffold cannot create protected policy, generated or API input ${proposal.path}`);
    }
    if (
      (ctx.config.exclude ?? []).some((entry) => globMatches(entry.files, proposal.path)) ||
      !globMatches(value.files, proposal.path)
    ) {
      fail(`scaffold target ${proposal.path} is outside the governed source scope`);
    }
    const matches = value.roles.filter((entry) => globMatches(entry.files, proposal.path));
    const [match] = matches;
    if (!match || matches.length !== 1 || (proposal === first && match.id !== role.id)) {
      return fail(`scaffold target ${proposal.path} must have exactly its intended role`);
    }
    proposal.role = match.id;
    if (match.name && !new RegExp(match.name).test(posix.basename(proposal.path))) {
      fail(`scaffold target ${proposal.path} violates role ${proposal.role}'s filename pattern`);
    }
  }
  return proposals.sort((left, right) => compare(left.path, right.path));
}
