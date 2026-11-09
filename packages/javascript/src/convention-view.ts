import { isAbsolute, relative } from "node:path";

import ts from "typescript";

import type { Conventions } from "../../../src/convention-schema.ts";
import { type Analysis, AnalysisError } from "./analysis.ts";
import { literal } from "./source-syntax.ts";

export type Role = Conventions["roles"][number];

type Shapes = NonNullable<Role["javascript"]>;

export type NodeAssertion = NonNullable<Shapes["nodes"]>[number];

export type TypeAssertion = NonNullable<Shapes["assignable"]>[number];

export interface ExportView {
  program: ts.Program;
  checker: ts.TypeChecker;
  source: ts.SourceFile;
  symbols: ts.Symbol[];
  targets: Set<ts.Symbol>;
}

export const unalias = (
  checker: ts.TypeChecker,
  start: ts.Symbol | undefined,
): ts.Symbol | undefined => {
  const seen = new Set<ts.Symbol>();
  let symbol = start;
  while (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    if (seen.has(symbol)) {
      return undefined;
    }
    seen.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
};

export const exportedSymbol = (
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined => symbol && unalias(checker, checker.getExportSymbolOfSymbol(symbol));

export const typeDeclaration = (symbol: ts.Symbol): ts.Declaration | undefined =>
  symbol.valueDeclaration ?? symbol.declarations?.[0];

export function observeProgram(analysis: Analysis, program: ts.Program): void {
  for (const source of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(source)) {
      continue;
    }
    const file = relative(analysis.root, source.fileName).replaceAll("\\", "/");
    if (
      file.split("/").includes("node_modules") &&
      program.isSourceFileFromExternalLibrary(source)
    ) {
      continue;
    }
    if (file === ".." || file.startsWith("../") || isAbsolute(file)) {
      throw new AnalysisError(
        "plumb.json",
        "A convention compiler input escapes the checked source root.",
      );
    }
    const parsed = analysis.source(file);
    if (source.text !== parsed.text && source.text !== parsed.text.replace(/^\uFEFF/, "")) {
      throw new AnalysisError(
        file,
        "The compiler Program contains different source text from the selected input.",
      );
    }
  }
}

export function exportView(analysis: Analysis, file: string, supplied?: ts.Program): ExportView {
  analysis.source(file);
  const program =
    supplied ??
    analysis.program(file, [], { ...analysis.options(file), allowJs: true, noEmit: true }, [file]);
  const checker = program.getTypeChecker(),
    source = program.getSourceFile(analysis.absolute(file));
  if (!source) {
    throw new AnalysisError(file, "The compiler Program does not include this selected source.");
  }
  observeProgram(analysis, program);
  const visited = new Set<string>();
  const verify = (path: string): void => {
    if (visited.has(path)) {
      return;
    }
    visited.add(path);
    const selected = program.getSourceFile(analysis.absolute(path));
    if (!selected) {
      throw new AnalysisError(path, "A reexported source is absent from the compiler Program.");
    }
    if (
      // commonJsModuleIndicator is the compiler's own record of a CommonJS module
      ("commonJsModuleIndicator" in selected && !!selected.commonJsModuleIndicator) ||
      selected.statements.some((node) => ts.isExportAssignment(node) && node.isExportEquals)
    ) {
      throw new AnalysisError(
        path,
        "Export conventions support ECMAScript modules; CommonJS/export-equals shapes are not supported.",
      );
    }
    for (const statement of selected.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) {
        continue;
      }
      if (!literal(statement.moduleSpecifier)) {
        throw new AnalysisError(path, "A reexport needs a literal module specifier.");
      }
      const target = analysis.target(
        path,
        statement.moduleSpecifier.text,
        program.getCompilerOptions(),
      );
      if (!checker.getSymbolAtLocation(statement.moduleSpecifier)) {
        throw new AnalysisError(path, `Cannot resolve reexport ${statement.moduleSpecifier.text}.`);
      }
      if (target) {
        verify(target);
      }
    }
  };
  verify(file);
  const module = checker.getSymbolAtLocation(source);
  const symbols = module ? checker.getExportsOfModule(module) : [];
  const targets = new Set<ts.Symbol>();
  for (const symbol of symbols) {
    const target = exportedSymbol(checker, symbol);
    if (!target?.declarations?.length) {
      throw new AnalysisError(
        file,
        `Export ${symbol.name} could not be resolved to a declaration.`,
      );
    }
    targets.add(target);
  }
  return { program, checker, source, symbols, targets };
}
