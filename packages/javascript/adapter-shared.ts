import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

import { ESLint } from "eslint";
import prettier from "prettier";
import ts from "typescript";

import type { CoverageRecord } from "../../src/adapter-native.ts";
import type { Project } from "../../src/config.ts";
import type { Context } from "../../src/context.ts";
import type { Diagnostic } from "../../src/diagnostics.ts";
import { isWithin } from "../../src/files.ts";
import type { CheckStatus } from "../../src/process.ts";
import { isRecord } from "../../src/schema.ts";

const require = createRequire(import.meta.url);

export const scripts = /\.[cm]?[jt]sx?$/;

export interface Coverage extends CoverageRecord {
  status: CheckRow["status"];
  notApplicable?: { path: string; reason: string }[];
}

// a check row also records a scope that had nothing to check
export interface CheckRow {
  id: string;
  status: CheckStatus["status"] | "not-applicable";
}

export interface TypedCoverage {
  root: string;
  typedFiles: string[];
  syntaxOnlyFiles: string[];
}

interface PackageInfo {
  root: string;
  name: string;
  version: string;
  bin?: string | Record<string, string>;
}

export const owned = (ctx: Context, project: Project, file: string): boolean =>
  isWithin(project.root, file) &&
  !ctx.config.projects.some(
    (other) =>
      ["typescript", "react"].includes(other.profile) &&
      other.root !== project.root &&
      isWithin(project.root, other.root) &&
      isWithin(other.root, file),
  );

export const diagnostic = (
  rule: string,
  path: string,
  message: string,
  remedy: string,
  incomplete = false,
): Diagnostic => ({
  rule,
  path,
  message,
  remedy,
  ...(incomplete ? { status: "incomplete", suppressible: false } : {}),
});

export function location(ctx: Pick<Context, "root">, path: string): string {
  return relative(ctx.root, path).replaceAll("\\", "/") || ".";
}

function packageInfo(name: string): PackageInfo {
  let folder = dirname(require.resolve(name));
  for (;;) {
    const path = join(folder, "package.json");
    if (existsSync(path)) {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(value) && value.name === name) {
        const { version, bin } = value;
        return {
          root: folder,
          name,
          version: typeof version === "string" ? version : "",
          ...(typeof bin === "string" || isRecord(bin) ? { bin: stringRecord(bin) } : {}),
        };
      }
    }
    const parent = dirname(folder);
    if (parent === folder) {
      throw new Error(`Cannot find metadata for ${name}`);
    }
    folder = parent;
  }
}

// a manifest bin is a path, or a map of command names to paths; anything else names no command
function stringRecord(value: string | Record<string, unknown>): string | Record<string, string> {
  return typeof value === "string"
    ? value
    : Object.fromEntries(
        Object.entries(value).flatMap(([key, entry]) =>
          typeof entry === "string" ? [[key, entry]] : [],
        ),
      );
}

export function toolVersions(): Record<string, string> {
  const versions: Record<string, string> = {
    eslint: ESLint.version,
    typescript: ts.version,
    prettier: prettier.version,
  };
  for (const name of [
    "@eslint/js",
    "typescript-eslint",
    "eslint-plugin-react-hooks",
    "eslint-plugin-simple-import-sort",
    "globals",
  ]) {
    versions[name] = packageInfo(name).version;
  }
  return versions;
}

export function knipConfiguration(
  ctx: Context,
  project: Project,
): { cwd: string; configPath: string; info: PackageInfo; bin: string } {
  const cwd = ctx.safePath(project.root);
  const executableConfigs = [
    "knip.ts",
    "knip.js",
    "knip.mjs",
    "knip.cjs",
    "knip.config.ts",
    "knip.config.js",
  ];
  if (executableConfigs.some((path) => existsSync(join(cwd, path)))) {
    throw new Error("Use data-only knip.json; executable Knip configs are not accepted");
  }
  const configPath = ctx.safePath(location(ctx, join(cwd, "knip.json")));
  const config: unknown = JSON.parse(ctx.read(location(ctx, configPath)) ?? "null");
  if (!isRecord(config) || ["preprocessor", "compilers", "reporter"].some((key) => key in config)) {
    throw new Error(
      "knip.json must be a data object without preprocessors, compilers or custom reporters",
    );
  }
  const info = packageInfo("knip"),
    bin = typeof info.bin === "string" ? info.bin : info.bin?.knip;
  if (!bin) {
    throw new Error("The installed knip package declares no knip command");
  }
  return { cwd, configPath, info, bin };
}
