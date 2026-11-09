import { isAbsolute, relative, sep } from "node:path";

import ts from "typescript";

import { isRecord } from "../../../src/schema.ts";
import { type Analysis, AnalysisError } from "./analysis.ts";

export const slash = (value: string): string => value.split(sep).join("/");

export const inside = (root: string, path: string): boolean => {
  const name = relative(root, path);
  return !isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`);
};

export const owned = (analysis: Analysis, file: string): boolean =>
  inside(analysis.root, file) &&
  !slash(relative(analysis.root, file)).split("/").includes("node_modules");

export const sorted = <T>(entries: Iterable<[string, T]>): Record<string, T> =>
  Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const modifiers = (node: ts.Node): readonly ts.Modifier[] =>
  ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];

export const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  modifiers(node).some((modifier) => modifier.kind === kind);

export const privateMember = (node: ts.Node): boolean =>
  !ts.isConstructorDeclaration(node) &&
  (hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
    ((ts.isClassElement(node) || ts.isPropertyAccessExpression(node)) &&
      !!node.name &&
      ts.isPrivateIdentifier(node.name)));

// a parsed node carries a numeric kind; a node's name property holds one when it has a name
const isNode = (value: unknown): value is ts.Node =>
  isRecord(value) && typeof value.kind === "number";

// a node's declared name, when it has one, for ordering members and statements
export const nameNode = (node: ts.Node): ts.Node | undefined => {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations[0]?.name;
  }
  const name: unknown = "name" in node ? node.name : undefined;
  return isNode(name) ? name : undefined;
};

export const isStatement = (node: ts.Node | undefined): node is ts.Statement =>
  node !== undefined && ts.isStatement(node);

// a nested namespace body is itself a namespace declaration
export const isNamespaceBody = (node: ts.Node | undefined): node is ts.NamespaceBody =>
  node !== undefined && (ts.isModuleBlock(node) || ts.isModuleDeclaration(node));

export interface SourceRecord {
  name: string;
  source: ts.SourceFile;
  references: Map<string, string>;
}

export interface SignatureGraph {
  targets: Record<string, { module: string; priority: number[] }>;
  signatures: Record<string, { declaration: string; references: Record<string, string> }>;
}

// the state one signature graph accumulates, and the steps that extend it; each step module
// receives it
export interface Collector {
  analysis: Analysis;
  program: ts.Program;
  checker: ts.TypeChecker;
  host: ts.CompilerHost;
  nameOf: (file: string) => string;
  libraries: Set<string>;
  originalProgram: ts.Program;
  included: Set<ts.Node>;
  containers: Set<ts.Node>;
  scanned: Set<ts.Node>;
  ambient: Set<ts.Node>;
  symbols: Map<ts.Symbol, boolean>;
  requests: Map<ts.Symbol, Map<string, boolean>>;
  records: Map<ts.SourceFile, SourceRecord>;
  labels: Map<string, ts.SourceFile>;
  rewrites: Map<ts.Node, string>;
  sourceRecord: (source: ts.SourceFile) => SourceRecord | undefined;
  selectAmbient: (node: ts.Node) => void;
  reference: (node: ts.Node) => ts.Symbol;
  request: (module: ts.Symbol, name: string, full?: boolean) => void;
  visitSymbol: (symbol: ts.Symbol | undefined, full?: boolean) => void;
  select: (declaration: ts.Node, full?: boolean) => void;
}

export const sourceOf = (module: ts.Symbol | undefined): ts.SourceFile | undefined =>
  module?.declarations?.find(ts.isSourceFile) ?? module?.declarations?.[0]?.getSourceFile();

export const alias = (c: Collector, symbol: ts.Symbol): ts.Symbol =>
  symbol.flags & ts.SymbolFlags.Alias ? c.checker.getAliasedSymbol(symbol) : symbol;

export function fail(c: Collector, node: ts.Node, message: string): never {
  const file = node.getSourceFile().fileName;
  throw new AnalysisError(
    owned(c.analysis, file) ? c.analysis.relative(file) : "plumb.json",
    message,
  );
}

export const statementOf = (start: ts.Node): ts.Node => {
  let node = start;
  while (node.parent && !ts.isSourceFile(node.parent) && !ts.isModuleBlock(node.parent)) {
    node = node.parent;
  }
  return node;
};
