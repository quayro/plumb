import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as adapters from "./adapters.ts";
import * as assets from "./assets.ts";
import * as comments from "./comments.ts";
import * as commits from "./commits.ts";
import * as conformance from "./conformance.ts";
import type { Context } from "./context.ts";
import * as contracts from "./contracts.ts";
import * as conventions from "./conventions.ts";
import * as customRules from "./custom-rules.ts";
import type { Diagnostic, Report, ReportCheck, Rule, Status } from "./diagnostics.ts";
import { enrichDiagnostics } from "./diagnostics.ts";
import * as docs from "./docs.ts";
import { type EngineOptions, FIXTURE_RUN } from "./engine-context.ts";
import { errorMessage } from "./errors.ts";
import { digest, inventory, isWithin, normalize, snapshot } from "./files.ts";
import * as formatTools from "./format-tools.ts";
import * as formatting from "./formatting.ts";
import * as hooks from "./hooks.ts";
import * as install from "./install.ts";
import * as native from "./native.ts";
import { RULES as POLICY_RULES } from "./policy.ts";
import * as policyTests from "./policy-tests.ts";
import * as tasks from "./task.ts";
import * as verification from "./verification.ts";

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const ENGINE_RULES: Rule[] = (
  [
    ["config.invalid", "Policy must be valid, data-only configuration."],
    ["inventory.unsafe", "Inputs must remain inside the repository and cannot be symlinks."],
    ["projects.scope", "Every configured project must have a readable source scope."],
    [
      "projects.uncovered",
      "The ozmikhail preset requires a profile for every supported source file.",
    ],
    [
      "projects.unsupported",
      "The ozmikhail preset refuses recognized source files that no configured project or adapter covers.",
    ],
    ["tools.missing", "A configured tool must be installed."],
    ["tools.version", "Pinned tool versions must match the active toolchain."],
    ["run.failed", "A check that cannot finish is incomplete."],
    ["run.mutated", "Check must leave source and policy files unchanged."],
    ["run.subject", "The exact source subject and approved inputs must be readable and stable."],
    ["native.scope", "Native profiles need complete source and build inputs."],
  ] as const
).map(([id, description]): Rule => ({
  id,
  description,
  remedy: "Resolve the reported configuration or tool failure and run the full check again.",
  suppressible: false,
}));

export const coreRules = (): Rule[] => [
  ...ENGINE_RULES,
  ...POLICY_RULES,
  ...[
    contracts,
    docs,
    assets,
    native,
    comments,
    formatting,
    formatTools,
    adapters,
    verification,
    tasks,
    policyTests,
    conventions,
    conformance,
    customRules,
    commits,
    hooks,
    install,
  ].flatMap((module): Rule[] => module.RULES),
];

export const failure = (
  rule: string,
  path: string,
  message: string,
  remedy = "Resolve the error and rerun the full check.",
): Diagnostic => ({
  rule,
  path,
  message,
  remedy,
  status: "incomplete",
  suppressible: false,
});

export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const sortDiagnostics = (list: Diagnostic[]): Diagnostic[] =>
  list.sort(
    (a, b) =>
      compare(a.path ?? ".", b.path ?? ".") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      compare(a.rule, b.rule) ||
      compare(a.message, b.message),
  );

export function report(
  diagnostics: readonly Diagnostic[],
  extra: Record<string, unknown> = {},
): Report {
  const normalized = sortDiagnostics(
    diagnostics.map((item): Diagnostic => ({
      ...item,
      status: item.status ?? "violation",
      path: normalize(item.path ?? "."),
    })),
  );
  const status: Status = normalized.some((item) => item.status === "incomplete")
    ? "incomplete"
    : normalized.length
      ? "violation"
      : "pass";
  return {
    ...extra,
    schemaVersion: 1,
    status,
    exitCode: status === "incomplete" ? 2 : status === "violation" ? 1 : 0,
    diagnostics: enrichDiagnostics(normalized),
  };
}

export const statusOf = (items: readonly Diagnostic[]): Status =>
  items.some((item) => item.status === "incomplete")
    ? "incomplete"
    : items.length
      ? "violation"
      : "pass";

export const governedComments = (ctx: Pick<Context, "files" | "config">): string[] =>
  ctx.files.filter((file) => {
    const language = comments.commentsLanguageOf(file);
    return (
      language &&
      (ctx.config.preset === "ozmikhail" ||
        ctx.config.projects.some(
          (project) =>
            project.profile === language &&
            (language === "python" || language === "rust") &&
            isWithin(project.root, file),
        ))
    );
  });

export interface ExecutionPlan {
  schemaVersion: 1;
  complete: false;
  checks: PlannedEntry[];
  files: Record<string, unknown>[];
  diagnostics: Diagnostic[];
  adapterPlan: ReturnType<typeof adapters.planAdapters>;
  conventions: ReturnType<typeof conventions.planConventions>;
}

export interface PlannedEntry {
  id: string;
  adapter: string;
  root: string;
  capability: string;
  files: string[];
  evidence: string;
  scope?: string;
  allowNotApplicable?: boolean;
  suite?: string;
  cases?: { id: string; expect: unknown }[];
}

export function executionPlan(ctx: Context, options: EngineOptions = {}): ExecutionPlan {
  const languages = adapters.planAdapters(ctx, { registry: ctx.registry });
  const roles = conventions.planConventions(ctx);
  const core: PlannedEntry[] = [
    {
      id: "files",
      adapter: "core",
      root: ".",
      capability: "files",
      files: [...new Set([...ctx.files, ...(ctx.config.files?.required ?? [])])].sort(),
      evidence: "inventory",
    },
    {
      id: "generated",
      adapter: "core",
      root: ".",
      capability: "generated",
      files: ctx.ownedFiles,
      evidence: "content-and-mode",
    },
    {
      id: "comments",
      adapter: "core",
      root: ".",
      capability: "comments",
      files: governedComments(ctx),
      evidence: "source-scanner",
    },
    {
      id: "formatting",
      adapter: "core",
      root: ".",
      capability: "formatting",
      files: formatting.formattingFiles(ctx),
      evidence: "content",
    },
    {
      id: "format-tools",
      adapter: "core",
      root: ".",
      capability: "format-tools",
      files: formatTools.formatToolFiles(ctx),
      evidence: "pinned-tool",
    },
  ];
  if (ctx.config.conventions) {
    core.push({
      id: "conventions",
      adapter: "core",
      root: ".",
      capability: "conventions",
      files: roles.files.filter((file) => !file.excluded).map((file) => file.path),
      evidence: "role-inventory",
    });
  }
  if (ctx.config.rules) {
    core.push({
      id: "rules",
      adapter: "core",
      root: ".",
      capability: "rules",
      files: customRules.customRuleFiles(ctx),
      evidence: "content",
    });
  }
  const suites = (ctx.config.verification ?? []).map((suite) => ({
    id: `test:${suite.id}`,
    adapter: "verification",
    root: suite.cwd ?? ".",
    capability: "tests",
    files: ctx.files.filter((file) => isWithin(suite.cwd ?? ".", file)),
    evidence: "test-report",
    suite: suite.id,
  }));
  const examples = options[FIXTURE_RUN]
    ? []
    : (ctx.config.policyTests ?? []).map((group) => ({
        id: `policy-test:${group.id}`,
        adapter: "core",
        root: ".",
        capability: "policy-tests",
        files: [],
        evidence: "actual-checker-fixtures",
        cases: group.cases.map(({ id, expect }) => ({ id, expect })),
      }));
  const checks: PlannedEntry[] = [...core, ...languages.checks, ...suites, ...examples];
  const files = languages.files.map((file) => {
    const role = roles.files.find((entry) => entry.path === file.path);
    return {
      ...file,
      ...(role ? { roles: role.roles, ...(role.role ? { role: role.role } : {}) } : {}),
      checks: checks.filter((check) => check.files.includes(file.path)).map((check) => check.id),
      policyOrigins: ctx.origins["/projects"] ?? ctx.origins[""] ?? [],
    };
  });
  return {
    schemaVersion: 1,
    complete: false,
    checks,
    files,
    diagnostics: [...ctx.problems, ...languages.diagnostics, ...roles.diagnostics],
    adapterPlan: languages,
    conventions: roles,
  };
}

export type EngineCheck = ReportCheck & {
  suppressed?: number;
  adapter?: string;
  root?: string;
  files?: string[];
  evidence?: string;
};

export function validateInputs(
  ctx: Context,
  before: string,
  options: Pick<EngineOptions, "subjectContext" | "inputBundle" | "inputOverlay" | "workspace">,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  try {
    const after = inventory(ctx.root);
    diagnostics.push(...after.problems);
    const afterFiles = [...new Set([...after.files, ...ctx.allFiles])].sort();
    if (snapshot(ctx.root, afterFiles) !== before) {
      throw new Error("Repository files changed while checking");
    }
    for (const input of ctx.policyInputs) {
      if (digest(readFileSync(input.path)) !== input.sha256) {
        throw new Error(`Loaded policy input changed: ${input.path}`);
      }
    }
    for (const path of ctx.inputs.keys()) {
      ctx.read(path, { allowMissing: true });
    }
    for (const path of ctx.compilerInputs.keys()) {
      ctx.readCompilerInput(path, { allowMissing: true });
    }
    for (const path of ctx.compilerDirectories.keys()) {
      ctx.readCompilerDirectory(path, { allowMissing: true });
    }
    options.subjectContext?.verify?.();
    options.inputBundle?.verify();
    options.inputOverlay?.verify?.();
    options.workspace?.verify?.();
  } catch (error) {
    diagnostics.push(failure("run.mutated", ".", errorMessage(error)));
  }
  return diagnostics;
}

export function reconcile(
  checks: EngineCheck[],
  before: readonly Diagnostic[],
  after: readonly Diagnostic[],
  suppressed: readonly Diagnostic[],
): void {
  for (const check of checks) {
    const original = before.filter((item) => item.check === check.id);
    if (!original.length) {
      continue;
    }
    const visible = after.filter((item) => item.check === check.id);
    check.status = statusOf(visible);
    const count = suppressed.filter((item) => item.check === check.id).length;
    if (count) {
      check.suppressed = count;
    }
  }
}
