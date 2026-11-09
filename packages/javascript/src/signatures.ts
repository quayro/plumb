import { basename, dirname, relative, resolve } from "node:path";

import ts from "typescript";

import type { Project } from "../../../src/config.ts";
import { asError, errorMessage } from "../../../src/errors.ts";
import { canonical, digest } from "../../../src/files.ts";
import { isRecord } from "../../../src/schema.ts";
import { strictCompilerOptions } from "../eslint/typed-policy.ts";
import { type Analysis, AnalysisError } from "./analysis.ts";
import { signatureGraph } from "./signature-graph.ts";
import { inside, owned, slash } from "./signature-nodes.ts";
import {
  type ExportTarget,
  type SignatureSnapshot,
  signatureSnapshotIsValid,
} from "./signature-snapshot.ts";
import { isScript } from "./source-syntax.ts";

type Observations = Map<string, string | undefined>;

function declarationHost(
  analysis: Analysis,
  options: ts.CompilerOptions,
  emitted: Map<string, string> | undefined,
  observations: Observations,
): ts.CompilerHost {
  const host = analysis.compilerHost(options);
  const originalRead = host.readFile.bind(host);
  host.readFile = (file): string | undefined => {
    const path = resolve(file);
    if (emitted?.has(path)) {
      return emitted.get(path);
    }
    const value = originalRead(file);
    if (observations.has(path) && observations.get(path) !== value) {
      throw new AnalysisError(
        "plumb.json",
        "A compiler input changed while constructing API signatures.",
      );
    }
    observations.set(path, value);
    return value;
  };
  host.getCurrentDirectory = () => analysis.root;
  host.getSourceFile = (file, languageVersion, onError): ts.SourceFile | undefined => {
    const path = resolve(file),
      virtual = emitted?.has(path);
    if (owned(analysis, path) && isScript(path)) {
      const name = analysis.relative(path);
      if (!analysis.inventory.has(name)) {
        throw new AnalysisError(
          name,
          "A public signature dependency is outside the checked inventory.",
        );
      }
      analysis.absolute(name);
      if (!virtual) {
        analysis.source(name);
      }
    }
    let text: string | undefined;
    try {
      text = host.readFile(path);
    } catch (error) {
      onError?.(errorMessage(error));
      throw asError(error);
    }
    if (text === undefined) {
      return undefined;
    }
    const source = ts.createSourceFile(
      virtual ? path.replace(/\.[cm]?[jt]sx?$/, ".d.ts") : path,
      text,
      languageVersion,
      true,
      virtual ? ts.ScriptKind.TS : undefined,
    );
    if (virtual) {
      source.isDeclarationFile = true;
      source.fileName = path;
    }
    if (emitted && isScript(path) && !source.isDeclarationFile) {
      throw new AnalysisError(
        owned(analysis, path) ? analysis.relative(path) : "plumb.json",
        "A public dependency has no declaration output; provide its prepared declarations before snapshotting.",
      );
    }
    return source;
  };
  host.writeFile = () => {
    throw new AnalysisError(
      "plumb.json",
      "Signature construction cannot write compiler output to the project.",
    );
  };
  return host;
}

function diagnostics(analysis: Analysis, values: readonly ts.Diagnostic[]): void {
  const errors = values.filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (!errors.length) {
    return;
  }
  const first = errors.find((item) => item.file && owned(analysis, item.file.fileName));
  const path = first?.file ? analysis.relative(first.file.fileName) : "plumb.json";
  const message = errors
    .map((item) => `TS${item.code}: ${ts.flattenDiagnosticMessageText(item.messageText, " ")}`)
    .join("; ")
    .replaceAll(analysis.root, ".")
    .replaceAll(slash(analysis.root), ".");
  throw new AnalysisError(
    path,
    `Cannot construct complete public declarations: ${message}`,
    "Resolve compiler errors, missing declarations or ambiguous public types before proposing an API contract.",
  );
}

function moduleLabels(
  analysis: Analysis,
  project: Project,
  host: ts.CompilerHost,
  libraries: Set<string>,
): (file: string) => string {
  const projectRoot = resolve(analysis.root, project.root),
    cache = new Map<string, string>();
  return (file) => {
    const path = resolve(file);
    const cached = cache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    let result: string | undefined;
    if (owned(analysis, path)) {
      result = inside(projectRoot, path)
        ? `./${slash(relative(projectRoot, path))}`
        : `workspace:${analysis.relative(path)}`;
    } else if (libraries.has(path) && /^lib(?:\.[\w.-]+)?\.d\.ts$/.test(basename(path))) {
      result = `typescript:${basename(path)}`;
    } else {
      let folder = dirname(path);
      while (true) {
        const source = host.readFile(resolve(folder, "package.json"));
        if (source !== undefined) {
          let manifest: unknown;
          try {
            manifest = JSON.parse(source);
          } catch {
            throw new AnalysisError(
              "plumb.json",
              "A signature type provider has an invalid package manifest.",
            );
          }
          if (
            isRecord(manifest) &&
            typeof manifest.name === "string" &&
            /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(manifest.name) &&
            typeof manifest.version === "string" &&
            /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)
          ) {
            result = `package:${manifest.name}@${manifest.version}/${slash(relative(folder, path))}`;
            break;
          }
        }
        const parent = dirname(folder);
        if (parent === folder) {
          throw new AnalysisError(
            "plumb.json",
            "An external signature dependency has no stable package identity; materialize its reviewed declarations inside the checked project.",
          );
        }
        folder = parent;
      }
    }
    cache.set(path, result);
    return result;
  };
}

export function signatureSurface(
  analysis: Analysis,
  project: Project,
  compiler: ts.ParsedCommandLine,
  targets: ExportTarget[],
  exported: Record<string, string[]>,
  routing: string,
): SignatureSnapshot {
  const observations: Observations = new Map(),
    emitted = new Map<string, string>();
  const output = resolve(analysis.root, ".plumb-signature-output");
  for (const [key, value] of Object.entries(strictCompilerOptions)) {
    if (compiler.options[key] !== undefined && compiler.options[key] !== value) {
      throw new AnalysisError(
        "plumb.json",
        `${key} conflicts with Plumb's strict signature policy.`,
      );
    }
  }
  const options: ts.CompilerOptions = {
    ...compiler.options,
    ...strictCompilerOptions,
    noEmit: false,
    noEmitOnError: true,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
    outFile: undefined,
    outDir: output,
    declarationDir: output,
    rootDir: analysis.root,
    stripInternal: false,
    removeComments: true,
    allowJs: true,
    checkJs: true,
    skipLibCheck: false,
    skipDefaultLibCheck: false,
    isolatedDeclarations: false,
  };
  const roots = [
    ...new Set([...compiler.fileNames, ...targets.map((target) => analysis.absolute(target.file))]),
  ].sort();
  const host = declarationHost(analysis, options, undefined, observations);
  const program = ts.createProgram({
    rootNames: roots,
    options,
    host,
    projectReferences: compiler.projectReferences,
  });
  diagnostics(analysis, ts.getPreEmitDiagnostics(program));
  const result = program.emit(
    undefined,
    (file, text, _bom, _error, sources) => {
      const [only] = sources ?? [];
      if (!/\.d\.[cm]?ts$/.test(file) || sources?.length !== 1 || !only) {
        throw new AnalysisError(
          "plumb.json",
          "The compiler did not produce one complete declaration module per source file.",
        );
      }
      const source = resolve(only.fileName);
      if (emitted.has(source)) {
        throw new AnalysisError(
          "plumb.json",
          "The compiler produced duplicate declaration modules.",
        );
      }
      emitted.set(source, text);
    },
    undefined,
    true,
  );
  diagnostics(analysis, result.diagnostics);
  if (result.emitSkipped && roots.some((file) => !program.getSourceFile(file)?.isDeclarationFile)) {
    throw new AnalysisError("plumb.json", "The compiler skipped public declaration emission.");
  }
  const virtualOptions = { ...options, noEmit: true };
  const virtualHost = declarationHost(analysis, virtualOptions, emitted, observations);
  const declarations = ts.createProgram({
    rootNames: roots,
    options: virtualOptions,
    host: virtualHost,
    projectReferences: compiler.projectReferences,
  });
  diagnostics(analysis, ts.getPreEmitDiagnostics(declarations));
  const libraryFiles = declarations
    .getSourceFiles()
    .filter((file) => declarations.isSourceFileDefaultLibrary(file));
  const libraries = new Set(libraryFiles.map((file) => resolve(file.fileName)));
  const nameOf = moduleLabels(analysis, project, virtualHost, libraries);
  const graph = signatureGraph(
    analysis,
    declarations,
    virtualHost,
    targets,
    nameOf,
    libraries,
    program,
  );
  const libraryIdentity = digest(
    canonical(
      libraryFiles
        .map((file) => [nameOf(file.fileName), digest(file.text)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
  for (const [file, text] of observations) {
    if (host.readFile(file) !== text) {
      throw new AnalysisError(
        "plumb.json",
        "A compiler input changed while constructing API signatures.",
      );
    }
  }
  const interpretation = {
    strictNullChecks: true,
    strictFunctionTypes: true,
    exactOptionalPropertyTypes: options.exactOptionalPropertyTypes ?? false,
    noUncheckedIndexedAccess: options.noUncheckedIndexedAccess ?? false,
  };
  const snapshot = {
    schemaVersion: 2,
    exports: exported,
    routing,
    ...graph,
    compiler: {
      typescript: ts.version,
      libraries: libraryIdentity,
      options: interpretation,
    },
  };
  if (!signatureSnapshotIsValid(snapshot)) {
    throw new AnalysisError(
      "plumb.json",
      "The compiler did not produce a complete closed public declaration graph.",
    );
  }
  return snapshot;
}
