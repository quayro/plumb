import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type TypeScript from "typescript";

import { isRecord } from "../../../src/schema.ts";
import { type CompilerIO, createCompilerIO } from "./compiler-host.ts";

type Ts = typeof TypeScript;

type Options = TypeScript.CompilerOptions;

export interface ModuleResolver {
  optionsFor: (from: string) => Options;
  isLocal: (from: string, specifier: string, compilerOptions?: Options) => boolean;
  resolve: (from: string, specifier: string, compilerOptions?: Options) => string | undefined;
  runtime: (from: string, specifier: string, compilerOptions?: Options) => string | undefined;
}

const require = createRequire(import.meta.url);

const inside = (root: string, file: string): boolean => {
  const name = relative(root, file);
  return (
    name !== ".." &&
    !name.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(name)
  );
};

const diagnosticText = (ts: Ts, diagnostic: TypeScript.Diagnostic): string => {
  const location =
    diagnostic.file && diagnostic.start !== undefined
      ? `${diagnostic.file.fileName}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}: `
      : "";
  return `${location}${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
};

// the compiler is loaded only when a resolution needs it; its module API carries these entry points
const isTypescript = (value: unknown): value is Ts =>
  isRecord(value) &&
  typeof value.resolveModuleName === "function" &&
  typeof value.parseJsonConfigFileContent === "function";

// a resolver belongs to one analysis run; changing a config cannot reuse a previous run's cache
export const createModuleResolver = (
  repository: string,
  suppliedIO?: CompilerIO,
): ModuleResolver => {
  const root = resolve(repository);
  const options = new Map<string, Options>();
  const resolutions = new Map<Options, TypeScript.ModuleResolutionCache>();
  let compiler: Ts | undefined;
  const ts = (): Ts => {
    if (!compiler) {
      const loaded: unknown = require("typescript");
      if (!isTypescript(loaded)) {
        throw new Error(
          "plumb: the installed typescript package is not the TypeScript compiler API",
        );
      }
      compiler = loaded;
    }
    return compiler;
  };
  const io = suppliedIO ?? createCompilerIO(root, {}, ts);
  const optionsFor = (from: string): Options => {
    const source = resolve(from);
    if (!inside(root, source)) {
      throw new Error(`Module is outside the project root: ${from}`);
    }
    let folder = dirname(source);
    const visited: string[] = [];
    while (inside(root, folder)) {
      const found = options.get(folder);
      if (found) {
        for (const directory of visited) {
          options.set(directory, found);
        }
        return found;
      }
      visited.push(folder);
      const config = join(folder, "tsconfig.json");
      if (io.fileExists(config)) {
        const typescript = ts();
        const read = typescript.readConfigFile(config, io.readFile);
        if (read.error) {
          throw new Error(diagnosticText(typescript, read.error));
        }
        const parsed = typescript.parseJsonConfigFileContent(
          read.config,
          io,
          folder,
          undefined,
          config,
        );
        if (parsed.errors.length) {
          throw new Error(
            parsed.errors.map((error) => diagnosticText(typescript, error)).join("\n"),
          );
        }
        for (const reference of parsed.projectReferences ?? []) {
          const target = reference.path.endsWith(".json")
            ? reference.path
            : join(reference.path, "tsconfig.json");
          if (!io.fileExists(target)) {
            throw new Error(`${config}: referenced configuration is missing: ${target}`);
          }
        }
        for (const directory of visited) {
          options.set(directory, parsed.options);
        }
        return parsed.options;
      }
      if (folder === root) {
        break;
      }
      folder = dirname(folder);
    }
    const typescript = ts();
    const defaults: Options = {
      module: typescript.ModuleKind.ESNext,
      moduleResolution: typescript.ModuleResolutionKind.Bundler,
      allowJs: true,
      resolveJsonModule: true,
    };
    for (const directory of visited) {
      options.set(directory, defaults);
    }
    return defaults;
  };
  const resolver: ModuleResolver = {
    optionsFor,
    isLocal(from, specifier, compilerOptions) {
      if (specifier.startsWith(".") || specifier.startsWith("#") || isAbsolute(specifier)) {
        return true;
      }
      const selected = compilerOptions ?? optionsFor(from);
      return Object.keys(selected.paths ?? {}).some((pattern) => {
        const star = pattern.indexOf("*");
        return star === -1
          ? pattern === specifier
          : specifier.startsWith(pattern.slice(0, star)) &&
              specifier.endsWith(pattern.slice(star + 1));
      });
    },
    resolve(from, specifier, compilerOptions) {
      const typescript = ts();
      const selected = compilerOptions ?? optionsFor(from);
      let cache = resolutions.get(selected);
      if (!cache) {
        cache = typescript.createModuleResolutionCache(
          root,
          (file) => (typescript.sys.useCaseSensitiveFileNames ? file : file.toLowerCase()),
          selected,
        );
        resolutions.set(selected, cache);
      }
      const target = typescript.resolveModuleName(
        specifier,
        resolve(from),
        selected,
        io,
        cache,
      ).resolvedModule;
      return target ? resolve(target.resolvedFileName) : undefined;
    },
    runtime(from, specifier, compilerOptions) {
      const target = resolver.resolve(from, specifier, compilerOptions);
      if (
        !target ||
        !inside(root, target) ||
        relative(root, target).replaceAll("\\", "/").split("/").includes("node_modules") ||
        !/\.d\.[cm]?ts$/.test(target)
      ) {
        return target;
      }
      const implementation = target.replace(/\.d\.(cts|mts|ts)$/, (_match, extension) =>
        extension === "cts" ? ".cjs" : extension === "mts" ? ".mjs" : ".js",
      );
      return io.fileExists(implementation) ? implementation : undefined;
    },
  };
  return resolver;
};
