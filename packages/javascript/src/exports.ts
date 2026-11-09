import { isAbsolute, resolve } from "node:path";

import ts from "typescript";

import type { Project } from "../../../src/config.ts";
import type { Diagnostic } from "../../../src/diagnostics.ts";
import { canonical } from "../../../src/files.ts";
import { isRecord } from "../../../src/schema.ts";
import { type Analysis, AnalysisError } from "./analysis.ts";
import { exportTargets } from "./export-targets.ts";
import { type SignatureSnapshot, signatureSnapshotIsValid } from "./signature-snapshot.ts";
import { signatureSurface } from "./signatures.ts";
import { literal } from "./source-syntax.ts";

interface NameSnapshot {
  schemaVersion: 1;
  exports: Record<string, string[]>;
}

export type SurfaceSnapshot = NameSnapshot | SignatureSnapshot;

const namedExports = (source: ts.SourceFile): { name: string; node: ts.Node }[] => {
  const names: { name: string; node: ts.Node }[] = [];
  const take = (node: ts.BindingName | ts.ModuleExportName | ts.ModuleName | undefined): void => {
    if (!node) {
      return;
    }
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
      if (node.text !== "default") {
        names.push({ name: node.text, node });
      }
    } else {
      for (const item of node.elements) {
        if (ts.isBindingElement(item)) {
          take(item.name);
        }
      }
    }
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const item of statement.exportClause.elements) {
          if (
            !statement.moduleSpecifier ||
            (item.propertyName && item.name.text !== item.propertyName.text)
          ) {
            take(item.name);
          }
        }
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        take(statement.exportClause.name);
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (
      !modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword) ||
      modifiers.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const item of statement.declarationList.declarations) {
        take(item.name);
      }
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      take(statement.name);
    }
  }
  return names;
};

export const uniqueExports = (analysis: Analysis, files: readonly string[]): Diagnostic[] => {
  const owners = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];
  for (const file of files) {
    for (const { name, node } of namedExports(analysis.source(file))) {
      const owner = owners.get(name);
      if (owner && owner !== file) {
        diagnostics.push(
          analysis.issue(
            "exports.unique",
            file,
            `${name} is already exported by ${owner}.`,
            "Give each owned exported name a unique name within this project's configured folders.",
            node,
          ),
        );
      } else {
        owners.set(name, file);
      }
    }
  }
  return diagnostics;
};

const aliasIsTypeOnly = (symbol: ts.Symbol): boolean =>
  Boolean(
    symbol.declarations?.length &&
    symbol.declarations.every((declaration) => {
      if (ts.isExportDeclaration(declaration)) {
        return declaration.isTypeOnly;
      }
      if (ts.isExportSpecifier(declaration)) {
        return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
      }
      if (ts.isNamespaceExport(declaration)) {
        return declaration.parent.isTypeOnly;
      }
      return false;
    }),
  );

const surface = (analysis: Analysis, project: Project): SurfaceSnapshot => {
  if (!project.surface) {
    throw new AnalysisError("plumb.json", "No surface contract is configured for this project.");
  }
  const configPath = analysis.relative(
    resolve(analysis.root, project.root, project.surface.tsconfig ?? "tsconfig.json"),
  );
  const compiler = analysis.compilerConfig(configPath);
  const { targets, routing } = exportTargets(analysis, project);
  for (const target of targets) {
    analysis.source(target.file);
  }
  const [first] = targets;
  if (!first) {
    throw new AnalysisError(configPath, "The surface contract selects no export targets.");
  }
  const program = analysis.program(
    first.file,
    targets.map((target) => target.file),
    { ...compiler.options, allowJs: true },
    undefined,
    compiler.projectReferences,
  );
  const checker = program.getTypeChecker();
  const typeOnlyThroughStars = (
    module: ts.Symbol,
    name: string,
    seen = new Set<ts.Symbol>(),
  ): boolean => {
    if (seen.has(module)) {
      return true;
    }
    const next = new Set([...seen, module]);
    const symbol = checker.getExportsOfModule(module).find((item) => item.name === name);
    if (!symbol || aliasIsTypeOnly(symbol)) {
      return true;
    }
    const owners = new Set<ts.Node>(module.declarations ?? []);
    if (
      symbol.declarations?.some((declaration) => {
        for (let parent: ts.Node | undefined = declaration; parent; parent = parent.parent) {
          if (owners.has(parent)) {
            return true;
          }
        }
        return false;
      })
    ) {
      return false;
    }
    let throughStar = false;
    for (const owner of owners) {
      let body: ts.Node = owner;
      while (ts.isModuleDeclaration(body) && body.body) {
        body = body.body;
      }
      if (!ts.isSourceFile(body) && !ts.isModuleBlock(body)) {
        continue;
      }
      for (const statement of body.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          statement.exportClause ||
          !statement.moduleSpecifier
        ) {
          continue;
        }
        const target = checker.getSymbolAtLocation(statement.moduleSpecifier);
        if (!target || !checker.getExportsOfModule(target).some((item) => item.name === name)) {
          continue;
        }
        throughStar = true;
        if (!statement.isTypeOnly && !typeOnlyThroughStars(target, name, next)) {
          return false;
        }
      }
    }
    return throughStar;
  };
  const visited = new Set<string>();
  const verify = (file: string): void => {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    analysis.source(file);
    const source = program.getSourceFile(analysis.absolute(file));
    if (!source) {
      throw new AnalysisError(file, "The compiler omitted an exported module.");
    }
    for (const statement of source.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        !statement.moduleSpecifier ||
        !literal(statement.moduleSpecifier)
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      const target = analysis.target(file, specifier, compiler.options);
      if (!checker.getSymbolAtLocation(statement.moduleSpecifier)) {
        throw new AnalysisError(file, `The reexported module ${specifier} could not be resolved.`);
      }
      if (target && /\.[cm]?[jt]sx?$/.test(target)) {
        verify(target);
      }
    }
  };
  const exported: Record<string, string[]> = {};
  for (const { key, file } of targets) {
    verify(file);
    const source = program.getSourceFile(analysis.absolute(file));
    const module = source && checker.getSymbolAtLocation(source);
    if (!source || !module) {
      throw new AnalysisError(file, "The package export target is not an analyzable module.");
    }
    exported[key] = checker
      .getExportsOfModule(module)
      .map((symbol) => {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        if (!target.declarations?.length) {
          throw new AnalysisError(
            file,
            `The exported symbol ${symbol.name} could not be resolved.`,
          );
        }
        const typeOnly = typeOnlyThroughStars(module, symbol.name);
        return `${symbol.name}${typeOnly || !(target.flags & ts.SymbolFlags.Value) ? " (type)" : ""}`;
      })
      .sort();
  }
  return project.surface.signatures
    ? signatureSurface(analysis, project, compiler, targets, exported, routing)
    : { schemaVersion: 1, exports: exported };
};

export const surfaceSnapshotIsValid = (value: unknown): value is SurfaceSnapshot =>
  signatureSnapshotIsValid(value) ||
  (isRecord(value) &&
    value.schemaVersion === 1 &&
    Object.keys(value).every((key) => ["schemaVersion", "exports"].includes(key)) &&
    isRecord(value.exports) &&
    Object.values(value.exports).every(
      (names) =>
        Array.isArray(names) &&
        names.every((name) => typeof name === "string") &&
        new Set(names).size === names.length,
    ));

const snapshotPath = (analysis: Analysis, project: Project): string => {
  const name = project.surface?.snapshot;
  if (
    typeof name !== "string" ||
    !name.endsWith(".surface.json") ||
    isAbsolute(name) ||
    name.replaceAll("\\", "/").split("/").includes("..")
  ) {
    throw new AnalysisError(
      "plumb.json",
      "A surface snapshot must be a project-relative *.surface.json data file.",
    );
  }
  const path = analysis.relative(resolve(analysis.root, project.root, name));
  analysis.absolute(path, true);
  return path;
};

export const surfaceProblems = (analysis: Analysis, project: Project): Diagnostic[] => {
  const path = snapshotPath(analysis, project);
  const current = surface(analysis, project);
  let before: unknown;
  try {
    before = JSON.parse(analysis.read(path));
  } catch {
    return [
      analysis.issue(
        "exports.surface",
        path,
        "The public API snapshot is missing or unreadable.",
        "Run plumb snapshot explicitly, review its proposal and accept the intended API contract.",
      ),
    ];
  }
  if (!surfaceSnapshotIsValid(before)) {
    throw new AnalysisError(
      path,
      "The public API snapshot must be a valid schemaVersion 1 name contract or schemaVersion 2 signature contract.",
    );
  }
  if (before.schemaVersion !== current.schemaVersion) {
    throw new AnalysisError(
      path,
      `This surface mode requires schemaVersion ${current.schemaVersion}; explicitly migrate the dedicated snapshot with plumb snapshot and review it.`,
    );
  }
  const changes: string[] = [];
  for (const key of new Set([...Object.keys(before.exports), ...Object.keys(current.exports)])) {
    const was = new Set(before.exports[key] ?? []);
    const now = new Set(current.exports[key] ?? []);
    if (!(key in before.exports)) {
      changes.push(`+ entry ${key}`);
    }
    if (!(key in current.exports)) {
      changes.push(`- entry ${key}`);
    }
    changes.push(...[...now].filter((name) => !was.has(name)).map((name) => `+ ${name} at ${key}`));
    changes.push(...[...was].filter((name) => !now.has(name)).map((name) => `- ${name} at ${key}`));
  }
  if (current.schemaVersion === 2 && before.schemaVersion === 2) {
    if (before.routing !== current.routing) {
      changes.push("~ ordered package export routing, including blocked and non-script branches");
    }
    for (const key of new Set([...Object.keys(before.targets), ...Object.keys(current.targets)])) {
      if (canonical(before.targets[key]) !== canonical(current.targets[key])) {
        changes.push(`~ export target ${key}`);
      }
    }
    for (const file of new Set([
      ...Object.keys(before.signatures),
      ...Object.keys(current.signatures),
    ])) {
      if (canonical(before.signatures[file]) !== canonical(current.signatures[file])) {
        changes.push(
          `${file in before.signatures ? (file in current.signatures ? "~" : "-") : "+"} declarations ${file}`,
        );
      }
    }
    if (canonical(before.compiler) !== canonical(current.compiler)) {
      changes.push("~ TypeScript compiler or standard-library evidence");
    }
  }
  return changes.length
    ? [
        analysis.issue(
          "exports.surface",
          path,
          `The public ${current.schemaVersion === 2 ? "API signature contract" : "names"} changed: ${changes.sort().join("; ")}.`,
          "Review the API change and run plumb snapshot explicitly; fix never updates this contract. Exact signature agreement does not prove behavioral or backward compatibility.",
        ),
      ]
    : [];
};

export const surfaceProposal = (
  analysis: Analysis,
  project: Project,
): { path: string; content: string } => ({
  path: snapshotPath(analysis, project),
  content: `${JSON.stringify(surface(analysis, project), null, 2)}\n`,
});
