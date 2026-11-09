import type { AdapterRegistry } from "./adapter-registry.ts";
import type { PolicyInput } from "./bundles.ts";
import type { Config } from "./config.ts";
import type { Diagnostic, Origins } from "./diagnostics.ts";
import type { globMatches } from "./files.ts";

export interface ReadOptions {
  allowMissing?: boolean;
}

export interface DirectoryEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}

interface PolicySource extends PolicyInput {
  source: "repository" | "external";
}

// everything a check reads about the repository it checks, built once by engine.context
export interface Context {
  root: string;
  files: string[];
  allFiles: string[];
  problems: Diagnostic[];
  config: Config;
  source: string;
  path: string;
  origins: Origins;
  policyInputs: PolicyInput[];
  policySources: PolicySource[];
  ownedFiles: string[];
  protectedFiles: string[];
  writableFiles: string[];
  inputs: Map<string, string | null>;
  compilerInputs: Map<string, string | null>;
  compilerDirectories: Map<string, string | null>;
  registry: AdapterRegistry | undefined;
  mode: string;
  configFile: string;
  readBytes: (path: string, options?: ReadOptions) => Buffer | null;
  readCompilerInput: (path: string, options?: ReadOptions) => string | null;
  readCompilerDirectory: (path: string, options?: ReadOptions) => DirectoryEntry[] | null;
  read: (path: string, options?: ReadOptions) => string | null;
  safePath: (
    path: unknown,
    options?: { allowMissing?: boolean; allowDependencies?: boolean },
  ) => string;
  matches: typeof globMatches;
}
