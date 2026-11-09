import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import type { AdapterRegistry } from "./adapter-registry.ts";
import { loadAdapterRegistry } from "./adapter-registry.ts";
import type { JavascriptPack } from "./adapters.ts";
import * as assets from "./assets.ts";
import { loadConfig } from "./config.ts";
import type { Context, DirectoryEntry, ReadOptions } from "./context.ts";
import { asError, errorCode } from "./errors.ts";
import { canonical, digest, globMatches, inventory, normalize, safePath } from "./files.ts";
import type { LoadedInputs, MaterializedInputs } from "./inputs.ts";
import { isPolicyFile } from "./policy.ts";
import type { Execute } from "./process.ts";
import type { LoadedTask } from "./task.ts";
import type { Workspace } from "./workspace.ts";

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const FIXTURE_RUN: unique symbol = Symbol("policy fixture invocation");

export interface EngineOptions {
  root?: string;
  configFile?: string;
  policy?: string;
  registry?: AdapterRegistry;
  adapters?: string;
  originalRoot?: string;
  mode?: string;
  cache?: string;
  date?: string;
  base?: string;
  task?: string;
  loadedTask?: LoadedTask;
  inputManifest?: string;
  inputBundle?: LoadedInputs;
  inputOverlay?: MaterializedInputs;
  subjectContext?: { subject: unknown; verify?: () => void };
  workspace?: Workspace;
  execute?: Execute;
  loadJavascript?: () => Promise<JavascriptPack>;
  temporaryRoot?: string;
  role?: string;
  name?: string;
  dryRun?: boolean;
  file?: string;
  [FIXTURE_RUN]?: boolean;
}

export function context(options: EngineOptions = {}): Context {
  const configFile = normalize(options.configFile ?? "plumb.json");
  const found = inventory(options.root ?? process.cwd());
  const loaded = loadConfig(found.root, configFile, options.policy);
  const registry =
    options.registry ?? loadAdapterRegistry(options.adapters, options.originalRoot ?? found.root);
  const protectedFiles = loaded.policyInputs
    .map((input) => relative(found.root, input.path).replaceAll("\\", "/"))
    .filter((path) => path !== ".." && !path.startsWith("../") && !isAbsolute(path));
  const publicOrigin = <T extends { path: string }>(
    origin: T,
  ): T & { source: "repository" | "external" } => {
    const path = relative(found.root, origin.path).replaceAll("\\", "/");
    return path !== ".." && !path.startsWith("../") && !isAbsolute(path)
      ? { ...origin, path, source: "repository" as const }
      : { ...origin, source: "external" as const };
  };
  const origins = Object.fromEntries(
    Object.entries(loaded.origins).map(([pointer, entries]) => [
      pointer,
      entries.map(publicOrigin),
    ]),
  );
  const policySources = loaded.policyInputs.map(publicOrigin);
  if ((loaded.config.generated ?? []).some((entry) => entry.path === configFile)) {
    throw new Error("Sync cannot generate its own policy file");
  }
  const ownedFiles = assets.assetsFor(loaded.config).map((file) => file.path);
  const databases = loaded.config.projects
    .filter((project) => project.profile === "cpp")
    .map((project) => `${project.compileCommands}/compile_commands.json`);
  const explicit = [
    ...ownedFiles,
    ...databases,
    ...protectedFiles,
    ...(loaded.config.files?.required ?? []),
    ...(loaded.config.docs?.index ? [loaded.config.docs.index] : []),
    ...(loaded.config.preset === "ozmikhail" ? ["AGENTS.md"] : []),
  ];
  const allFiles = [
    ...new Set([
      ...found.files,
      ...explicit.filter((path) => {
        try {
          return existsSync(safePath(found.root, path));
        } catch {
          return false;
        }
      }),
    ]),
  ].sort();
  const files = found.files.filter(
    (path) => !loaded.config.exclude.some((entry) => globMatches(entry.files, path)),
  );
  const inputs = new Map<string, string | null>(),
    compilerInputs = new Map<string, string | null>(),
    compilerDirectories = new Map<string, string | null>();
  const remember = (map: Map<string, string | null>, path: string, hash: string | null): void => {
    if (map.has(path) && map.get(path) !== hash) {
      throw new Error(`Input changed while checking: ${path}`);
    }
    map.set(path, hash);
  };
  const readBytes = (path: string, { allowMissing = false }: ReadOptions = {}): Buffer | null => {
    let value: Buffer | null;
    try {
      value = readFileSync(safePath(found.root, path));
    } catch (error) {
      if (!allowMissing || errorCode(error) !== "ENOENT") {
        throw asError(error);
      }
      value = null;
    }
    const hash = value === null ? null : digest(value);
    remember(inputs, path, hash);
    return value;
  };
  const readCompilerInput = (
    input: string,
    { allowMissing = false }: ReadOptions = {},
  ): string | null => {
    const path = normalize(input);
    let bytes: Buffer | null;
    try {
      const target = safePath(found.root, path, { allowMissing, allowDependencies: true }),
        stat = lstatSync(target);
      if (stat.isDirectory() && allowMissing) {
        bytes = null;
      } else {
        if (!stat.isFile()) {
          throw new Error(`Compiler inputs must be regular files: ${path}`);
        }
        bytes = readFileSync(target);
      }
    } catch (error) {
      if (!allowMissing || !["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) {
        throw asError(error);
      }
      bytes = null;
    }
    remember(compilerInputs, path, bytes === null ? null : digest(bytes));
    return bytes?.toString("utf8") ?? null;
  };
  const readCompilerDirectory = (
    input: string,
    { allowMissing = false }: ReadOptions = {},
  ): DirectoryEntry[] | null => {
    const path = normalize(input);
    let entries: DirectoryEntry[] | null;
    try {
      const target = safePath(found.root, path, { allowMissing, allowDependencies: true });
      entries = readdirSync(target, { withFileTypes: true })
        .map((item): DirectoryEntry => ({
          name: item.name,
          kind: item.isFile()
            ? "file"
            : item.isDirectory()
              ? "directory"
              : item.isSymbolicLink()
                ? "symlink"
                : "other",
        }))
        .sort((a, b) => compare(a.name, b.name));
    } catch (error) {
      if (!allowMissing || !["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) {
        throw asError(error);
      }
      entries = null;
    }
    remember(compilerDirectories, path, entries === null ? null : digest(canonical(entries)));
    return entries;
  };
  return {
    ...found,
    ...loaded,
    origins,
    policySources,
    allFiles,
    files,
    ownedFiles,
    inputs,
    compilerInputs,
    compilerDirectories,
    registry,
    protectedFiles,
    readBytes,
    readCompilerInput,
    readCompilerDirectory,
    read: (path, options) => readBytes(path, options)?.toString("utf8") ?? null,
    safePath: (path, options) => safePath(found.root, path, options),
    matches: globMatches,
    writableFiles: files.filter(
      (path) => !protectedFiles.includes(path) && !isPolicyFile(loaded.config, path, configFile),
    ),
    mode: options.mode ?? "check",
    configFile,
  };
}
