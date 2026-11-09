import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { type Config, loadConfig } from "./config.ts";
import type { Context } from "./context.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { errorMessage } from "./errors.ts";
import { canonical, globMatches, normalize } from "./files.ts";
import { KEY_COLUMNS } from "./formatting.ts";
import { run, type RunResult } from "./process.ts";
import { at, isArray, isRecord } from "./schema.ts";

type Classification = "tighten" | "neutral" | "weaken";

type Kind = "added" | "removed" | "changed";

export interface PolicyDelta {
  pointer: string;
  kind: Kind;
  classification: Classification;
  before?: unknown;
  after?: unknown;
}

type ExceptionEntry = Config["exceptions"][number];

// both policies were schema-validated, so an exceptions list holds identified entries
const isExceptionList = (value: unknown): value is ExceptionEntry[] =>
  isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.id === "string");

// allowances widen what is skipped: removing one tightens, adding one weakens.
const ALLOWANCES = new Set([
  "/exclude",
  "/format/ignore",
  "/commits/types",
  "/commits/scopes",
  "/javascript/source",
  "/javascript/words",
  "/javascript/lines",
  "/javascript/errorFactory/allowIn",
]);
const ALLOWANCE_FIELD: Record<string, string> = { "/exclude": "files", "/format/ignore": "path" };
// protective lists tighten when they gain entries; every other added entry weakens.
const ADDITIONS_TIGHTEN = new Set([
  "/files/required",
  "/files/forbidden",
  "/files/names",
  "/policy/protected",
  "/policy/owners",
  "/projects",
  "/verification",
  "/policyTests",
  "/rules",
  "/format/tools",
  "/format/sortKeys",
  "/format/keyColumns",
  "/docs/sections",
  "/docs/kinds",
  "/docs/generated",
  ...["boundaries", "manifests", "registrations", "lazyModules", "writtenOnce", "importGraphs"].map(
    (key) => `/contracts/${key}`,
  ),
]);
const NEUTRAL = ["/tools/versions", "/tools/timeout", "/generated", "/$schema"];
const SECTIONS = new Set([
  "/ci",
  "/commits",
  "/hooks",
  "/docs",
  "/comments",
  "/policy/owners",
  "/verification",
  "/policyTests",
]);
const LOWER_IS_TIGHTER = new Set(["/files/maxLines", "/commits/maxLength"]);

const escape = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");

const plain = isRecord;

const short = (value: unknown): string => JSON.stringify(value).slice(0, 160);

const isNeutral = (path: string): boolean =>
  NEUTRAL.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

const change = (
  pointer: string,
  kind: Kind,
  before: unknown,
  after: unknown,
  classification: Classification,
): PolicyDelta => ({
  pointer,
  kind,
  classification,
  ...(before !== undefined ? { before } : {}),
  ...(after !== undefined ? { after } : {}),
});

const kindOf = (before: unknown, after: unknown): Kind =>
  before === undefined ? "added" : after === undefined ? "removed" : "changed";

function itemize(path: string, before: unknown[], after: unknown[], out: PolicyDelta[]): void {
  const field = ALLOWANCE_FIELD[path];
  const index = (items: unknown[]): Map<unknown, { position: number; value: unknown }> =>
    new Map(
      items.flatMap((item, position) =>
        (field ? [at(item, field)].flat() : [canonical(item)]).map(
          (key): [unknown, { position: number; value: unknown }] => [
            key,
            { position, value: field ? key : item },
          ],
        ),
      ),
    );
  const prior = index(before),
    next = index(after);
  for (const [key, { position, value }] of prior) {
    if (!next.has(key)) {
      out.push(
        change(
          `${path}/${position}`,
          "removed",
          value,
          undefined,
          ALLOWANCES.has(path) ? "tighten" : "weaken",
        ),
      );
    }
  }
  for (const [key, { position, value }] of next) {
    if (!prior.has(key)) {
      out.push(
        change(
          `${path}/${position}`,
          "added",
          undefined,
          value,
          ADDITIONS_TIGHTEN.has(path) ? "tighten" : "weaken",
        ),
      );
    }
  }
}

// exception identity is its id: moving files to a new id, splitting or renaming all count as
// weakening.
function exceptionChanges(
  before: readonly ExceptionEntry[],
  after: readonly ExceptionEntry[],
  out: PolicyDelta[],
): void {
  const prior = new Map(before.map((entry) => [entry.id, entry])),
    next = new Map(after.map((entry) => [entry.id, entry]));
  for (const [id, entry] of prior) {
    if (!next.has(id)) {
      out.push(change(`/exceptions/${id}`, "removed", entry, undefined, "tighten"));
    }
  }
  for (const [id, entry] of next) {
    const pointer = `/exceptions/${id}`,
      old = prior.get(id);
    if (!old) {
      out.push(change(pointer, "added", undefined, entry, "weaken"));
      continue;
    }
    if (entry.max !== old.max) {
      out.push(
        change(
          `${pointer}/max`,
          "changed",
          old.max,
          entry.max,
          entry.max > old.max ? "weaken" : "tighten",
        ),
      );
    }
    for (const field of ["rules", "files"] as const) {
      for (const item of entry[field].filter((value) => !old[field].includes(value))) {
        out.push(change(`${pointer}/${field}`, "added", undefined, item, "weaken"));
      }
      for (const item of old[field].filter((value) => !entry[field].includes(value))) {
        out.push(change(`${pointer}/${field}`, "removed", item, undefined, "tighten"));
      }
    }
    if (old.expires !== entry.expires) {
      const classification =
        entry.expires === undefined
          ? "weaken"
          : old.expires === undefined
            ? "tighten"
            : entry.expires > old.expires
              ? "weaken"
              : "tighten";
      out.push(
        change(
          `${pointer}/expires`,
          kindOf(old.expires, entry.expires),
          old.expires,
          entry.expires,
          classification,
        ),
      );
    }
    const rest = (exception: ExceptionEntry): string =>
      canonical(
        Object.fromEntries(
          Object.entries(exception).filter(
            ([key]) => !["max", "rules", "files", "expires"].includes(key),
          ),
        ),
      );
    if (rest(old) !== rest(entry)) {
      out.push(change(pointer, "changed", old, entry, "weaken"));
    }
  }
}

function scalarClass(path: string, kind: Kind, before: unknown, after: unknown): Classification {
  if (path === "/preset") {
    return after === "ozmikhail" ? "tighten" : "weaken";
  }
  if (
    LOWER_IS_TIGHTER.has(path) &&
    (kind === "added" || (kind === "changed" && Number(after) < Number(before)))
  ) {
    return "tighten";
  }
  return "weaken";
}

function walk(before: unknown, after: unknown, path: string, out: PolicyDelta[]): void {
  if (canonical(before) === canonical(after)) {
    return;
  }
  if (isNeutral(path)) {
    out.push(change(path, kindOf(before, after), before, after, "neutral"));
    return;
  }
  if (
    path === "/exceptions" &&
    (before === undefined || isExceptionList(before)) &&
    (after === undefined || isExceptionList(after))
  ) {
    exceptionChanges(before ?? [], after ?? [], out);
    return;
  }
  // opting into a whole new contract section adds checks; later edits inside it are classified
  // field by field.
  if (before === undefined && SECTIONS.has(path)) {
    out.push(change(path, "added", undefined, after, "tighten"));
    return;
  }
  if (after === undefined && /^\/(javascript|contracts)(\/|$)/.test(path)) {
    out.push(change(path, "removed", before, undefined, "weaken"));
    return;
  }
  if ((before === undefined || isArray(before)) && (after === undefined || isArray(after))) {
    itemize(path, before ?? [], after ?? [], out);
    return;
  }
  if ((before === undefined || plain(before)) && (after === undefined || plain(after))) {
    for (const key of [
      ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
    ].sort()) {
      walk(before?.[key], after?.[key], `${path}/${escape(key)}`, out);
    }
    return;
  }
  const kind = kindOf(before, after);
  out.push(change(path, kind, before, after, scalarClass(path, kind, before, after)));
}

// an unset keyColumns means the default globs, so setting it is compared against what it replaces
const withDefaultKeyColumns = (policy: unknown): unknown =>
  plain(policy) && at(policy, "format", "keyColumns") === undefined
    ? {
        ...policy,
        format: { ...(plain(policy.format) ? policy.format : {}), keyColumns: KEY_COLUMNS },
      }
    : policy;

// every changed JSON pointer between two effective policies, classified tighten, neutral or weaken.
// anything not explicitly listed is weaken.
export function comparePolicies(before: unknown, after: unknown): PolicyDelta[] {
  const out: PolicyDelta[] = [];
  walk(withDefaultKeyColumns(before), withDefaultKeyColumns(after), "", out);
  return out.sort((a, b) => (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0));
}

const describe = (item: PolicyDelta): string =>
  item.kind === "changed"
    ? `changed from ${short(item.before)} to ${short(item.after)}`
    : item.kind === "added"
      ? `added ${short(item.after)}`
      : `removed ${short(item.before)}`;

const git = (cwd: string, args: string[]): Promise<RunResult> =>
  run(["git", "-C", cwd, ...args], { timeout: 60000 });

// repository top-level for a directory, or undefined outside git.
export async function gitTop(dir: string): Promise<string | undefined> {
  const result = await git(dir, ["rev-parse", "--show-toplevel"]);
  return result.code === 0 && !result.error ? realpathSync(result.stdout.trim()) : undefined;
}

const REVISION = /^[^-\s\0][^\s\0]*$/;

// paths under gitRoot that differ from the merge base with a revision, untracked files included
export async function changedFiles(gitRoot: string, base: string): Promise<string[]> {
  if (!REVISION.test(base)) {
    throw new Error(`--base ${base} is not a git revision.`);
  }
  const results = await Promise.all([
    git(gitRoot, ["diff", "--name-only", "--relative", "-z", "--merge-base", base]),
    git(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  if (results.some((result) => result.code !== 0 || result.error)) {
    throw new Error(`The files changed since ${base} cannot be listed.`);
  }
  return results.flatMap((result) => result.stdout.split("\0").filter(Boolean));
}

// materializes the base policy and its pinned bundles from git, then classifies the effective change.
export async function checkPolicyBase(
  ctx: Pick<Context, "root" | "configFile" | "config">,
  base: unknown,
  gitRoot = ctx.root,
): Promise<{ diagnostics: Diagnostic[]; changes: PolicyDelta[] }> {
  const file = ctx.configFile;
  const incomplete = (message: string): { diagnostics: Diagnostic[]; changes: PolicyDelta[] } => ({
    diagnostics: [
      {
        rule: "policy.base",
        path: file,
        message,
        remedy:
          "Fetch the base ref or pass the revision that contains this policy file, then retry.",
        status: "incomplete",
        suppressible: false,
      },
    ],
    changes: [],
  });
  if (typeof base !== "string" || !REVISION.test(base)) {
    return incomplete(`--base ${String(base)} is not a git revision.`);
  }
  const verify = await git(gitRoot, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  if (verify.code !== 0 || verify.error) {
    return incomplete(`Base revision ${base} is not available in this repository.`);
  }
  const prefix = (await git(gitRoot, ["rev-parse", "--show-prefix"])).stdout.trim();
  const temporary = mkdtempSync(join(tmpdir(), "plumb-base-"));
  try {
    const queue = [file],
      seen = new Set<string>();
    while (queue.length) {
      const path = queue.pop() ?? file;
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      const shown = await git(gitRoot, ["show", `${base}:${prefix}${path}`]);
      if (shown.code !== 0 || shown.error) {
        throw new Error(`Base policy ${path} is missing at ${base}.`);
      }
      const target = join(temporary, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, shown.stdout);
      let references: unknown = [];
      try {
        references = at(JSON.parse(shown.stdout), "bundles") ?? [];
      } catch {
        // an unreadable base policy has no bundles to follow; loadConfig reports the JSON error
        references = [];
      }
      for (const reference of isArray(references) ? references : []) {
        const bundle = at(reference, "path");
        if (typeof bundle !== "string" || posix.isAbsolute(bundle)) {
          throw new Error(`Base bundle ${String(bundle)} must be a repository-relative path.`);
        }
        const next = normalize(posix.join(posix.dirname(path), bundle));
        if (next.split("/").includes("..")) {
          throw new Error(`Base bundle ${bundle} escapes the repository.`);
        }
        queue.push(next);
      }
    }
    const baseConfig = loadConfig(temporary, file).config;
    const changes = comparePolicies(baseConfig, ctx.config);
    const diagnostics = changes
      .filter((item) => item.classification === "weaken")
      .map((item): Diagnostic => ({
        rule: "policy.weakened",
        path: file,
        message: `${item.pointer} ${describe(item)}; this weakens enforcement against the base.`,
        remedy:
          "Restore the base value, or move the weakening into a separately reviewed policy change.",
        status: "violation",
        suppressible: false,
      }));
    return { diagnostics, changes };
  } catch (error) {
    return incomplete(errorMessage(error));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// a git checkout is governed only by its root policy; other plumb.json files must be pinned bundles.
export async function nestedPolicyDiagnostics(
  ctx: Pick<Context, "root" | "configFile" | "policySources" | "allFiles" | "config">,
  gitRoot = ctx.root,
): Promise<Diagnostic[]> {
  const top = await gitTop(gitRoot);
  if (!top || top !== realpathSync(gitRoot)) {
    return [];
  }
  const governing = new Set([ctx.configFile, ...ctx.policySources.map((source) => source.path)]);
  return ctx.allFiles
    .filter(
      (path) =>
        posix.basename(path) === posix.basename(ctx.configFile) &&
        !governing.has(path) &&
        !ctx.config.exclude.some((entry) => globMatches(entry.files, path)),
    )
    .map((path): Diagnostic => ({
      rule: "policy.nested",
      path,
      message: `${path} is a nested policy that Plumb does not apply to this checkout.`,
      remedy: "Move its rules into the root policy or reference the file as a pinned bundle.",
      status: "violation",
      suppressible: false,
    }));
}
