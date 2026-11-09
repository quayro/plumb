import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { Context } from "./context.ts";
import type { Report } from "./diagnostics.ts";
import { errorCode, errorMessage } from "./errors.ts";
import { canonical, digest, globMatches, inventory, safePath, snapshot } from "./files.ts";
import { at, isArray } from "./schema.ts";

const inside = (root: string, path: string): boolean => {
  const local = relative(root, path);
  return (
    !isAbsolute(local) &&
    local !== ".." &&
    !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
};

const fullSnapshot = (root: string): string => {
  const found = inventory(root);
  if (found.problems.length) {
    throw new Error("Unsafe inputs prevent cache reuse");
  }
  const directories: [string, number][] = [];
  const walk = (path: string): void => {
    const absolute = safePath(root, path);
    directories.push([path, lstatSync(absolute).mode & 0o7777]);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && ![".git", ".hg", ".svn", "node_modules"].includes(entry.name)) {
        walk(path === "." ? entry.name : `${path}/${entry.name}`);
      }
    }
  };
  // markdown links can name an empty directory, including an ignored directory.
  walk(".");
  return digest(
    canonical({
      files: snapshot(root, found.files),
      directories: directories.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    }),
  );
};

const mutation = (message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code: "PLUMB_CACHE_MUTATED" });

const disabled = (reason: string): CacheMemo => ({ info: { enabled: false, hit: false, reason } });

function validResult(
  value: unknown,
  checker: unknown,
  policy: string,
  source: string,
  files: readonly string[],
): value is Report {
  const list = (key: string): unknown[] | undefined => {
    const entries = at(value, key);
    return isArray(entries) ? entries : undefined;
  };
  if (
    at(value, "schemaVersion") !== 1 ||
    at(value, "command") !== "check" ||
    at(value, "status") !== "pass" ||
    at(value, "exitCode") !== 0 ||
    list("diagnostics")?.length !== 0
  ) {
    return false;
  }
  if (
    canonical(at(value, "identity", "checker")) !== canonical(checker) ||
    at(value, "identity", "snapshot") !== source ||
    at(value, "identity", "policy") !== policy ||
    at(value, "identity", "subject", "kind") !== "worktree" ||
    at(value, "identity", "subject", "snapshot") !== source
  ) {
    return false;
  }
  const checks = list("checks"),
    coverage = list("coverage"),
    reported = list("files");
  if (!checks || !coverage || !reported || !list("suppressed") || list("tests")?.length !== 0) {
    return false;
  }
  const ids = (entries: unknown[]): unknown[] => entries.map((entry) => at(entry, "id")).sort();
  const settled = (entry: unknown): boolean =>
    ["pass", "not-applicable"].includes(String(at(entry, "status")));
  if (
    canonical(ids(checks)) !==
      canonical([
        "comments",
        "files",
        "format-tools",
        "formatting",
        "generated",
        "javascript",
        "native",
      ]) ||
    !checks.every(settled)
  ) {
    return false;
  }
  if (
    canonical(ids(coverage)) !==
      canonical(["comments", "files", "format-tools", "formatting", "generated"]) ||
    coverage.some(
      (row) =>
        !Array.isArray(at(row, "checkedFiles")) ||
        !settled(row) ||
        at(row, "completed") !== (at(row, "status") === "pass"),
    )
  ) {
    return false;
  }
  return (
    canonical(reported.map((file) => at(file, "path")).sort()) === canonical([...files].sort())
  );
}

interface CacheInfo {
  enabled: boolean;
  hit: boolean;
  key?: string;
  scope?: string;
  reason?: string;
}

export interface CacheMemo {
  info: CacheInfo;
  result?: Report;
  verify?: () => void;
  save?: (value: unknown) => void;
}

export interface CacheOptions {
  cache?: string;
  date?: string;
  adapters?: unknown;
  registry?: unknown;
  loadedTask?: unknown;
  task?: unknown;
  inputBundle?: unknown;
  inputManifest?: unknown;
  workspace?: unknown;
  subjectContext?: { verify?: () => void };
}

// only deterministic core checks are reusable. Tool and behavioral checks always execute.
export function prepareCache(
  ctx: Pick<Context, "root" | "config" | "files" | "allFiles" | "configFile" | "policyInputs"> &
    Partial<Pick<Context, "registry">>,
  options: CacheOptions,
  checker: unknown,
): CacheMemo | undefined {
  if (!options.cache) {
    return undefined;
  }
  if (ctx.config.policyTests?.length || ctx.config.conventions) {
    return disabled("Convention and policy acceptance checks execute afresh.");
  }
  if (process.env.CI && !/^(?:false|0)$/i.test(process.env.CI)) {
    return disabled("CI checks always execute; local caching is disabled when CI is truthy.");
  }
  const unsupported =
    ctx.config.projects.length ||
    ctx.config.javascript !== undefined ||
    Object.values(ctx.config.contracts ?? {}).some((rows) => rows.length) ||
    ctx.config.verification?.length ||
    ctx.config.format?.tools?.length ||
    ctx.registry ||
    options.adapters ||
    options.registry ||
    options.loadedTask ||
    options.task ||
    options.inputBundle ||
    options.inputManifest ||
    options.subjectContext ||
    options.workspace;
  if (unsupported) {
    return disabled(
      "Language, behavioral, task and approved-input checks always execute; caching currently covers deterministic core checks only.",
    );
  }
  const root = realpathSync(ctx.root),
    destination = resolve(options.cache);
  let ancestor = destination;
  while (!existsSync(ancestor)) {
    ancestor = dirname(ancestor);
  }
  const actual = resolve(realpathSync(ancestor), relative(ancestor, destination));
  if (inside(root, actual)) {
    throw new Error("The cache must be outside the candidate repository");
  }
  const scope = inventory(root);
  const selected = scope.files.filter(
    (path) => !ctx.config.exclude.some((entry) => globMatches(entry.files, path)),
  );
  if (
    canonical(selected) !== canonical(ctx.files) ||
    scope.files.some((path) => !ctx.allFiles.includes(path))
  ) {
    throw mutation("Repository inventory changed before cache validation");
  }
  let source: string, selectedSource: string;
  try {
    source = fullSnapshot(root);
    selectedSource = snapshot(root, ctx.allFiles);
  } catch (error) {
    return disabled(errorMessage(error));
  }
  const date = ctx.config.exceptions.some((entry) => entry.expires)
    ? (options.date ?? new Date().toISOString().slice(0, 10))
    : undefined;
  const policy = digest(canonical(ctx.config)),
    scopeIdentity = canonical(scope);
  const key = digest(
    canonical({
      schemaVersion: 1,
      root,
      source,
      scope,
      selected: ctx.files,
      allFiles: ctx.allFiles,
      configFile: ctx.configFile,
      policy,
      policyInputs: ctx.policyInputs,
      checker,
      runtime: { node: process.versions.node, bun: process.versions.bun },
      platform: process.platform,
      date,
    }),
  );
  const path = join(actual, `${key}.json`),
    info: CacheInfo = { enabled: true, hit: false, key, scope: "deterministic-core" };
  const verify = (): void => {
    try {
      if (canonical(inventory(root)) !== scopeIdentity || fullSnapshot(root) !== source) {
        throw new Error("Cache source inputs or selected inventory changed during the run");
      }
      for (const item of ctx.policyInputs) {
        if (
          !lstatSync(item.path).isFile() ||
          realpathSync(item.path) !== item.path ||
          digest(readFileSync(item.path)) !== item.sha256
        ) {
          throw new Error("Cache policy input changed during the run");
        }
      }
      options.subjectContext?.verify?.();
    } catch (error) {
      throw mutation(errorMessage(error));
    }
  };
  let result: Report | undefined;
  if (existsSync(path)) {
    try {
      if (!lstatSync(path).isFile() || realpathSync(path) !== path) {
        throw new Error("Cache receipts must be regular files at their approved path");
      }
      if (lstatSync(path).size > 16 * 1024 * 1024) {
        throw new Error("Oversized cache receipt");
      }
      const bytes = readFileSync(path);
      const receipt: unknown = JSON.parse(bytes.toString("utf8")),
        stored = at(receipt, "result");
      if (
        at(receipt, "schemaVersion") !== 1 ||
        at(receipt, "key") !== key ||
        !validResult(stored, checker, policy, selectedSource, ctx.allFiles) ||
        at(receipt, "sha256") !== digest(canonical(stored))
      ) {
        throw new Error("Cache receipt is invalid");
      }
      verify();
      result = stored;
      info.hit = true;
    } catch (error) {
      if (errorCode(error) === "PLUMB_CACHE_MUTATED") {
        throw error instanceof Error ? error : mutation(errorMessage(error));
      }
      info.reason = `Receipt was not reused: ${errorMessage(error)}`;
    }
  }
  return {
    info,
    result,
    verify,
    save(value: unknown): void {
      if (!validResult(value, checker, policy, selectedSource, ctx.allFiles)) {
        return;
      }
      verify();
      mkdirSync(actual, { recursive: true });
      if (realpathSync(actual) !== actual || inside(root, realpathSync(actual))) {
        throw new Error("Cache destination changed from its approved external path");
      }
      const temporary = join(actual, `.${key}.${randomUUID()}.tmp`);
      try {
        writeFileSync(
          temporary,
          JSON.stringify({
            schemaVersion: 1,
            key,
            sha256: digest(canonical(value)),
            result: value,
          }),
          { mode: 0o600, flag: "wx" },
        );
        renameSync(temporary, path);
        verify();
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}
