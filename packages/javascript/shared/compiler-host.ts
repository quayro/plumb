import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type TypeScript from "typescript";

import type { DirectoryEntry, ReadOptions } from "../../../src/context.ts";
import { asError, errorCode } from "../../../src/errors.ts";
import { isRecord } from "../../../src/schema.ts";

type Ts = typeof TypeScript;

export interface CompilerContext {
  readCompilerDirectory?: (path: string, options?: ReadOptions) => DirectoryEntry[] | null;
  readCompilerInput?: (path: string, options?: ReadOptions) => string | null;
  read?: (path: string, options?: ReadOptions) => string | null;
}

export interface CompilerIO extends TypeScript.ParseConfigHost, TypeScript.ModuleResolutionHost {
  readFile: (file: string) => string | undefined;
  fileExists: (file: string) => boolean;
  directoryExists: (directory: string) => boolean;
  getDirectories: (directory: string) => string[];
  realpath: (file: string) => string;
  getCurrentDirectory: () => string;
  useCaseSensitiveFileNames: boolean;
  readDirectory: (
    ...parameters: Parameters<TypeScript.ParseConfigHost["readDirectory"]>
  ) => string[];
}

// the internal matcher is a function; its signature is TypeScript's own, pinned with the compiler
// release
const isMatchFiles = (value: unknown): value is MatchFiles => typeof value === "function";

// matchFiles is TypeScript's internal directory matcher; it takes the host's listing callback
type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => {
    files: string[];
    directories: string[];
  },
  realpath: (path: string) => string,
) => string[];

const metadata = new Set([".git", ".hg", ".svn"]);

const inside = (root: string, path: string): boolean => {
  const name = relative(root, path);
  return name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name);
};

const slash = (path: string): string => path.split(sep).join("/");

// the core records bytes, absence and directory listings. This fallback serves standalone API users.
function ordinary(root: string, name: string, allowMissing: boolean): string {
  const path = resolve(root, name);
  if (!inside(root, path) || name.split(/[\\/]/).some((part) => metadata.has(part))) {
    throw new Error(`Unsafe compiler input: ${name}`);
  }
  let cursor = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`Compiler inputs cannot follow symbolic links: ${name}`);
      }
    } catch (error) {
      if (allowMissing && errorCode(error) === "ENOENT") {
        return path;
      }
      throw asError(error);
    }
  }
  return path;
}

export function createCompilerIO(
  repository: string,
  context: CompilerContext,
  compiler: Ts | (() => Ts),
): CompilerIO {
  const root = resolve(repository),
    ts = typeof compiler === "function" ? compiler : (): Ts => compiler;
  let library: string | undefined;
  const libraryRoot = () => (library ??= realpathSync(dirname(ts().getDefaultLibFilePath({}))));
  const nameOf = (file: string): string => slash(relative(root, resolve(file))) || ".";
  const candidate = (file: string): boolean => inside(root, resolve(file));
  const standard = (file: string, directory = false): boolean => {
    const path = resolve(file),
      folder = libraryRoot();
    return directory
      ? path === folder
      : dirname(path) === folder && /^lib(?:\.[a-z0-9-]+)*\.d\.ts$/i.test(basename(path));
  };
  const listing = (directory: string): DirectoryEntry[] | null => {
    const path = resolve(directory);
    if (!candidate(path)) {
      if (!standard(path, true)) {
        return null;
      }
      return readdirSync(path, { withFileTypes: true }).map((entry): DirectoryEntry => ({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : "other",
      }));
    }
    const name = nameOf(path);
    if (context.readCompilerDirectory) {
      return context.readCompilerDirectory(name, { allowMissing: true });
    }
    try {
      const target = ordinary(root, name, true);
      if (!lstatSync(target).isDirectory()) {
        return null;
      }
      return readdirSync(target, { withFileTypes: true })
        .map((entry): DirectoryEntry => ({
          name: entry.name,
          kind: entry.isSymbolicLink()
            ? "symlink"
            : entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : "other",
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) {
        return null;
      }
      throw asError(error);
    }
  };
  const kind = (file: string): DirectoryEntry["kind"] | undefined => {
    const path = resolve(file);
    if (path === root || standard(path, true)) {
      return "directory";
    }
    if (!candidate(path) && !standard(path)) {
      return undefined;
    }
    const entry = listing(dirname(path))?.find((entry) => entry.name === basename(path));
    if (entry && ["symlink", "other"].includes(entry.kind)) {
      throw new Error(`Unsupported compiler input: ${file}`);
    }
    return entry?.kind;
  };
  const readFile = (file: string): string | undefined => {
    const path = resolve(file);
    if (!candidate(path)) {
      if (!standard(path)) {
        throw new Error(`Compiler input escapes the checked root: ${file}`);
      }
      return ts().sys.readFile(path);
    }
    const name = nameOf(path),
      entry = kind(path);
    if (entry === "directory") {
      return undefined;
    }
    let value: string | null | undefined;
    try {
      value = context.readCompilerInput
        ? context.readCompilerInput(name, { allowMissing: true })
        : !name.split("/").includes("node_modules") && context.read
          ? context.read(name, { allowMissing: true })
          : readFileSync(ordinary(root, name, true), "utf8");
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) {
        return undefined;
      }
      throw asError(error);
    }
    return value === null || value === undefined ? undefined : value.replace(/^\uFEFF/, "");
  };
  const io: CompilerIO = {
    readFile,
    useCaseSensitiveFileNames: false,
    fileExists(file) {
      if (!candidate(file) && !standard(file)) {
        return false;
      }
      if (kind(file) === "directory") {
        return false;
      }
      return readFile(file) !== undefined;
    },
    directoryExists(directory) {
      if (kind(directory) !== "directory") {
        return false;
      }
      return listing(directory) !== null;
    },
    getDirectories(directory) {
      return (listing(directory) ?? [])
        .filter((entry) => entry.kind === "directory" && !metadata.has(entry.name))
        .map((entry) => entry.name);
    },
    readDirectory(directory, extensions, excludes, includes, depth) {
      if (!candidate(directory) && !standard(directory, true)) {
        throw new Error(`Compiler directory escapes the checked root: ${directory}`);
      }
      const api: unknown = ts();
      const matchFiles = isRecord(api) ? api.matchFiles : undefined;
      if (!isMatchFiles(matchFiles)) {
        throw new Error(
          "This TypeScript release does not provide the required guarded directory matcher",
        );
      }
      return matchFiles(
        directory,
        extensions,
        excludes,
        includes,
        ts().sys.useCaseSensitiveFileNames,
        root,
        depth,
        (folder: string) => {
          const entries = listing(folder) ?? [];
          return {
            files: entries
              .filter((entry) => entry.kind === "file" && !metadata.has(entry.name))
              .map((entry) => entry.name),
            directories: entries
              .filter((entry) => entry.kind === "directory" && !metadata.has(entry.name))
              .map((entry) => entry.name),
          };
        },
        io.realpath,
      );
    },
    realpath(file) {
      if (!candidate(file) && !standard(file) && !standard(file, true)) {
        throw new Error(`Compiler resolution escapes the checked root: ${file}`);
      }
      if (candidate(file)) {
        ordinary(root, nameOf(file), true);
      }
      try {
        const path = realpathSync(file);
        if (!candidate(path) && !standard(path) && !standard(path, true)) {
          throw new Error(`Compiler resolution escapes the checked root: ${file}`);
        }
        return path;
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return resolve(file);
        }
        throw asError(error);
      }
    },
    getCurrentDirectory: () => root,
  };
  Object.defineProperty(io, "useCaseSensitiveFileNames", {
    enumerable: true,
    get: () => ts().sys.useCaseSensitiveFileNames,
  });
  return io;
}
