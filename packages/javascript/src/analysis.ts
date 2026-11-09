import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";

import ts from "typescript";

import type { Config } from "../../../src/config.ts";
import type { Context } from "../../../src/context.ts";
import type { Diagnostic } from "../../../src/diagnostics.ts";
import { asError, errorCode } from "../../../src/errors.ts";
import { isRecord } from "../../../src/schema.ts";
import { type CompilerIO, createCompilerIO } from "../shared/compiler-host.ts";
import { createModuleResolver, type ModuleResolver } from "../shared/module-resolver.ts";
import { isScript } from "./source-syntax.ts";

export type AnalysisContext = Pick<Context, "root" | "files" | "config"> &
  Partial<
    Pick<Context, "read" | "safePath" | "matches" | "readCompilerInput" | "readCompilerDirectory">
  >;

export type Contracts = NonNullable<Config["contracts"]>;

export type Contract<K extends keyof Contracts> = NonNullable<Contracts[K]>[number];

const isDiagnostic = (value: unknown): value is ts.Diagnostic =>
  isRecord(value) && (typeof value.messageText === "string" || isRecord(value.messageText));

const slash = (path: string): string => path.split(sep).join("/");

const pattern = (value: string): string => {
  const clean = value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return clean === "." || clean === "" ? "**" : clean.endsWith("/") ? `${clean}**` : clean;
};

export class AnalysisError extends Error {
  path: string;
  remedy: string;

  constructor(
    path: string,
    message: string,
    remedy = "Correct the source or configuration so this contract can be fully checked.",
  ) {
    super(message);
    this.name = "AnalysisError";
    this.path = path;
    this.remedy = remedy;
  }
}

// contract scopes share one inventory; source trees and compiler programs are cached per run.
export class Analysis {
  context: AnalysisContext;
  root: string;
  files: string[];
  inventory: Set<string>;
  sources = new Map<string, ts.SourceFile>();
  configs = new Map<string, ts.ParsedCommandLine>();
  configStack = new Set<string>();
  programs = new Map<string, ts.Program>();
  resolver: ModuleResolver;
  compilerIO: CompilerIO;

  constructor(context: AnalysisContext) {
    this.context = context;
    this.root = resolve(context.root);
    this.files = [...new Set(context.files.map((file) => this.relative(file)))].sort();
    this.inventory = new Set(this.files);
    this.compilerIO = createCompilerIO(this.root, context, ts);
    this.resolver = createModuleResolver(this.root, this.compilerIO);
  }

  relative(file: string): string {
    const absolute = isAbsolute(file) ? file : resolve(this.root, file.replace(/\\/g, "/"));
    const name = slash(relative(this.root, absolute));
    if (name === ".." || name.startsWith("../") || isAbsolute(name)) {
      throw new AnalysisError("plumb.json", "A semantic input escapes the project root.");
    }
    return name || ".";
  }

  absolute(file: string, allowMissing = false): string {
    const name = this.relative(file);
    if (this.context.safePath) {
      return this.context.safePath(name, { allowMissing });
    }
    const absolute = resolve(this.root, name);
    try {
      const real = realpathSync(absolute);
      const offset = relative(realpathSync(this.root), real);
      if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
        throw new AnalysisError(
          name,
          "A semantic input follows a symbolic link outside the project root.",
        );
      }
    } catch (error) {
      if (!(allowMissing && errorCode(error) === "ENOENT")) {
        throw asError(error);
      }
      if (dirname(absolute) !== this.root) {
        this.absolute(dirname(absolute), true);
      }
    }
    return absolute;
  }

  read(file: string): string {
    const name = this.relative(file);
    let text: string | null;
    try {
      text = this.context.read
        ? this.context.read(name)
        : readFileSync(this.absolute(name), "utf8");
    } catch (error) {
      if (error instanceof AnalysisError) {
        throw error;
      }
      throw new AnalysisError(
        name,
        `Cannot read ${name}.`,
        "Restore the file and include it in the checked inventory.",
      );
    }
    if (text === null) {
      throw new AnalysisError(
        name,
        `Cannot read ${name}.`,
        "Restore the file and include it in the checked inventory.",
      );
    }
    return text;
  }

  matches(patterns: string | readonly string[], file: string): boolean {
    const list = (typeof patterns === "string" ? [patterns] : patterns).map(pattern);
    const name = this.relative(file);
    return this.context.matches
      ? this.context.matches(list, name)
      : list.some((glob) => matchesGlob(name, glob));
  }

  select(patterns: string | readonly string[], scripts = true): string[] {
    return this.files.filter(
      (file) => (!scripts || isScript(file)) && this.matches(patterns, file),
    );
  }

  scope(folder: string, file: string): boolean {
    const prefix = this.relative(folder);
    const name = this.relative(file);
    return prefix === "." || name === prefix || name.startsWith(`${prefix}/`);
  }

  required(patterns: string | readonly string[]): string[] {
    const files = this.select(patterns);
    if (!files.length) {
      throw new AnalysisError("plumb.json", `No script files match ${JSON.stringify(patterns)}.`);
    }
    return files;
  }

  source(file: string): ts.SourceFile {
    const name = this.relative(file);
    if (!this.inventory.has(name)) {
      throw new AnalysisError(
        name,
        `${name} is absent from the checked inventory.`,
        "Restore the file or correct the contract and its scope; an excluded input cannot prove this contract.",
      );
    }
    let source = this.sources.get(name);
    if (!source) {
      source = ts.createSourceFile(
        this.absolute(name),
        this.read(name),
        ts.ScriptTarget.Latest,
        true,
      );
      // parseDiagnostics is internal to the compiler; it is the only syntax report a lone source
      // file carries
      const reported: unknown = "parseDiagnostics" in source ? source.parseDiagnostics : undefined;
      const error = Array.isArray(reported) ? reported.find(isDiagnostic) : undefined;
      if (error) {
        throw new AnalysisError(
          name,
          `Cannot analyze invalid syntax: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`,
        );
      }
      this.sources.set(name, source);
    }
    return source;
  }

  compilerConfig(file: string): ts.ParsedCommandLine {
    const name = this.relative(file);
    let parsed = this.configs.get(name);
    if (!parsed) {
      if (this.configStack.has(name)) {
        throw new AnalysisError(name, "TypeScript project references contain a cycle.");
      }
      this.configStack.add(name);
      try {
        const path = this.absolute(name);
        const loaded = ts.parseConfigFileTextToJson(path, this.read(name));
        if (loaded.error) {
          throw new AnalysisError(
            name,
            ts.flattenDiagnosticMessageText(loaded.error.messageText, " "),
          );
        }
        const config = ts.parseJsonConfigFileContent(
          loaded.config,
          this.compilerIO,
          dirname(path),
          undefined,
          path,
        );
        if (config.errors.length) {
          throw new AnalysisError(
            name,
            config.errors
              .map((error) => ts.flattenDiagnosticMessageText(error.messageText, " "))
              .join("; "),
          );
        }
        for (const reference of config.projectReferences ?? []) {
          this.compilerConfig(ts.resolveProjectReferencePath(reference));
        }
        this.configs.set(name, config);
        parsed = config;
      } finally {
        this.configStack.delete(name);
      }
    }
    return parsed;
  }

  options(file: string): ts.CompilerOptions {
    const project = this.context.config.projects
      .filter(
        (item) => ["typescript", "react"].includes(item.profile) && this.scope(item.root, file),
      )
      .sort((a, b) => Number(this.scope(a.root, b.root)) - Number(this.scope(b.root, a.root)))[0];
    if (!project) {
      return this.resolver.optionsFor(this.absolute(file));
    }
    const configs = (project.tsconfigs ?? ["tsconfig.json"]).map((name) =>
      this.compilerConfig(resolve(this.root, project.root, name)),
    );
    const [first] = configs;
    return (
      (configs.find((config) => config.fileNames.includes(this.absolute(file))) ?? first)
        ?.options ?? {}
    );
  }

  target(
    file: string,
    specifier: string,
    compilerOptions?: ts.CompilerOptions,
    runtime = false,
  ): string | undefined {
    const from = this.absolute(file);
    const options = compilerOptions ?? this.options(file);
    const target = this.resolver.resolve(from, specifier, options);
    if (target) {
      let offset = slash(relative(this.root, target));
      if (offset.split("/").includes("node_modules")) {
        return undefined;
      }
      if (offset === ".." || offset.startsWith("../") || isAbsolute(offset)) {
        throw new AnalysisError(
          this.relative(file),
          `The dependency ${specifier} leaves the checked root.`,
        );
      }
      if (runtime && /\.d\.[cm]?ts$/.test(offset)) {
        const implementation = this.resolver.runtime(from, specifier, options);
        if (!implementation) {
          throw new AnalysisError(
            this.relative(file),
            `The runtime dependency ${specifier} resolves only to declarations (${offset}).`,
            "Include its runtime implementation or correct the resolution settings; declarations cannot prove a runtime dependency graph.",
          );
        }
        offset = this.relative(implementation);
      }
      if (!this.inventory.has(offset)) {
        throw new AnalysisError(
          this.relative(file),
          `The dependency ${specifier} resolves to ${offset}, outside the checked inventory.`,
        );
      }
      this.absolute(offset);
      return offset;
    }
    if (specifier.startsWith(".")) {
      const exact = this.relative(resolve(dirname(from), specifier));
      if (this.inventory.has(exact)) {
        return exact;
      }
    }
    if (this.resolver.isLocal(from, specifier, options)) {
      throw new AnalysisError(
        this.relative(file),
        `Cannot resolve local dependency ${specifier}.`,
        "Correct the import or tsconfig resolution settings; unresolved local edges are never skipped.",
      );
    }
    return undefined;
  }

  program(
    file: string,
    extra: readonly string[] = [],
    compilerOptions?: ts.CompilerOptions,
    rootNames?: readonly string[],
    projectReferences?: readonly ts.ProjectReference[],
  ): ts.Program {
    const options: ts.CompilerOptions = {
      ...(compilerOptions ?? { ...this.options(file), allowJs: true }),
      noEmit: true,
    };
    const roots = [
      ...new Set(
        [...(rootNames ?? this.files.filter(isScript)), ...extra].map((name) =>
          this.absolute(name),
        ),
      ),
    ].sort();
    const key = JSON.stringify([options, roots, projectReferences ?? []]);
    let program = this.programs.get(key);
    if (!program) {
      program = ts.createProgram({
        rootNames: roots,
        options,
        projectReferences,
        host: this.compilerHost(options),
      });
      this.programs.set(key, program);
    }
    return program;
  }

  compilerHost(
    options: ts.CompilerOptions,
    overrides: Partial<ts.CompilerHost> = {},
  ): ts.CompilerHost {
    const host: ts.CompilerHost = {
      ...ts.createCompilerHost(options, true),
      ...this.compilerIO,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      writeFile() {
        throw new AnalysisError("plumb.json", "A checking compiler cannot write files.");
      },
      ...overrides,
    };
    if (!overrides.getSourceFile) {
      host.getSourceFile = (file, languageVersion): ts.SourceFile | undefined => {
        const text = host.readFile(file);
        return text === undefined
          ? undefined
          : ts.createSourceFile(file, text, languageVersion, true);
      };
    }
    return host;
  }

  issue(rule: string, file: string, message: string, remedy: string, node?: ts.Node): Diagnostic {
    const location = node?.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    return {
      rule,
      path: this.relative(file),
      message,
      remedy,
      ...(location && {
        line: location.line + 1,
        column: location.character + 1,
      }),
    };
  }
}
