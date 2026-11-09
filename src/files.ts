import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Config } from "./config.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { errorCode, errorMessage } from "./errors.ts";

export const normalize = (value: string): string =>
  value
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "")
    .split("/")
    .filter((part) => part !== ".")
    .join("/") || ".";

export const isWithin = (parent: string, path: string): boolean =>
  path === parent || path.startsWith(`${parent}/`) || parent === ".";

export const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );

export function safePath(
  root: string,
  path: unknown,
  { allowMissing = false, allowDependencies = false } = {},
): string {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\0") ||
    isAbsolute(path) ||
    /^[a-z]:/i.test(path)
  ) {
    throw new Error(`Expected a repository-relative path: ${path}`);
  }
  const clean = normalize(path);
  if (clean.split("/").includes("..")) {
    throw new Error(`Path escapes the repository: ${path}`);
  }
  if (
    clean
      .split("/")
      .some(
        (part) =>
          [".git", ".hg", ".svn"].includes(part) || (part === "node_modules" && !allowDependencies),
      )
  ) {
    throw new Error(`Reserved repository path: ${path}`);
  }
  const base = realpathSync(root);
  const target = resolve(base, clean);
  const local = relative(base, target);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`Path escapes the repository: ${path}`);
  }
  let cursor = base;
  for (const part of local.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`Symbolic links are not followed: ${path}`);
      }
    } catch (error) {
      if (allowMissing && errorCode(error) === "ENOENT") {
        return target;
      }
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }
  }
  return target;
}

const patterns = new Map<string, RegExp[]>();

function expand(pattern: string): string[] {
  if (pattern.length > 1024) {
    throw new Error("Glob is too long");
  }
  const pending = [pattern],
    result: string[] = [];
  while (pending.length) {
    const current = pending.pop() ?? "",
      match = /\{([^{}]*)\}/.exec(current);
    if (!match) {
      result.push(current);
      continue;
    }
    const choices = (match[1] ?? "").split(",");
    if (choices.length + pending.length + result.length > 256) {
      throw new Error("Glob expansion exceeds 256 alternatives");
    }
    pending.push(...choices.map((part) => current.replace(match[0], part)));
  }
  return result;
}

function compile(pattern: string): RegExp {
  const raw = pattern.replaceAll("\\", "/");
  let clean = normalize(raw);
  if (clean === ".") {
    clean = "**";
  } else if (raw.endsWith("/")) {
    clean += "/**";
  }
  if (clean.split("/").includes("..") || clean.startsWith("/") || clean.startsWith("!")) {
    throw new Error(`Invalid repository glob: ${pattern}`);
  }
  let source = "";
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (char === "*" && clean[i + 1] === "*") {
      const slash = clean[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function globMatches(pattern: string | readonly string[], path: string): boolean {
  const list: readonly string[] = typeof pattern === "string" ? [pattern] : pattern;
  return list.some((entry) => {
    let compiled = patterns.get(entry);
    if (!compiled) {
      compiled = expand(entry).map(compile);
      patterns.set(entry, compiled);
    }
    return compiled.some((regex) => regex.test(normalize(path)));
  });
}

const omitted = new Set([".git", ".hg", ".svn", "node_modules"]);

// a git work tree is listed by git, so ignored files stay out and a nested node_modules that is not
// ignored is inventoried
const gitFiles = (base: string): string[] | undefined => {
  const top = spawnSync("git", ["-C", base, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    shell: false,
  });
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== base) {
    return undefined;
  }
  const listed = spawnSync(
    "git",
    ["-C", base, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", shell: false, maxBuffer: 1024 * 1024 * 1024 },
  );
  return listed.status === 0 ? listed.stdout.split("\0").filter(Boolean) : undefined;
};

export function inventory(root: string): { root: string; files: string[]; problems: Diagnostic[] } {
  const base = realpathSync(root),
    listed = gitFiles(base);
  const walk = (folder: string): string[] =>
    readdirSync(join(base, folder), { withFileTypes: true }).flatMap((entry) => {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        return omitted.has(entry.name) ? [] : walk(path);
      }
      return [path];
    });
  const files: string[] = [],
    problems: Diagnostic[] = [];
  for (const file of [...new Set((listed ?? walk("")).map(normalize))].sort()) {
    if (!listed && file.split("/").some((part) => omitted.has(part))) {
      continue;
    }
    try {
      const target = safePath(base, file, { allowDependencies: listed !== undefined });
      const stat = lstatSync(target);
      if (stat.isFile()) {
        files.push(file);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        problems.push({
          rule: "inventory.unsafe",
          path: file,
          status: "incomplete",
          suppressible: false,
          message: errorMessage(error),
          remedy: "Use regular repository files; check linked repositories separately.",
        });
      }
    }
  }
  return { root: base, files, problems };
}

export function snapshot(root: string, files: Iterable<string>): string {
  const hash = createHash("sha256");
  for (const path of [...files].sort()) {
    const target = safePath(root, path);
    const content = createHash("sha256"),
      buffer = Buffer.allocUnsafe(65536),
      file = openSync(target, "r");
    try {
      for (let length; (length = readSync(file, buffer, 0, buffer.length, null));) {
        content.update(buffer.subarray(0, length));
      }
    } finally {
      closeSync(file);
    }
    hash.update(canonical([path, lstatSync(target).mode & 0o111, content.digest("hex")]) + "\n");
  }
  return hash.digest("hex");
}

export const protectedPolicyFiles = [
  "**/plumb.json",
  "**/plumb.ratchet.json",
  "**/plumb.config.*",
  "**/eslint.config.*",
  "**/.eslintrc*",
  "**/tsconfig*.json",
  "**/package.json",
  "**/*lock*",
  "**/Gemfile*",
  "**/.rubocop*",
  "**/.clang-*",
  "**/knip*",
  "**/.knip*",
  "**/*.config.*",
  ".github/workflows/**",
  ".github/actions/**",
  ".github/CODEOWNERS",
  ".githooks/**",
  ".husky/**",
  "**/.gitignore",
  "**/.prettier*",
  "**/.editorconfig",
  "**/.gitattributes",
];

export function isPolicyFile(
  config: Pick<Config, "projects" | "policy">,
  path: string,
  configFile = "plumb.json",
): boolean {
  const snapshots = config.projects.flatMap((project) =>
    project.surface
      ? [`${project.root === "." ? "" : `${project.root}/`}${project.surface.snapshot}`]
      : [],
  );
  return globMatches(
    [...protectedPolicyFiles, configFile, ...snapshots, ...(config.policy?.protected ?? [])],
    path,
  );
}
