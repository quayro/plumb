import { resolve } from "node:path";

import ts from "typescript";

import { AnalysisError } from "./analysis.ts";
import {
  alias,
  type Collector,
  fail,
  owned,
  privateMember,
  sourceOf,
  statementOf,
} from "./signature-nodes.ts";
import { literal } from "./source-syntax.ts";

export function request(c: Collector, module: ts.Symbol, name: string, full = false): void {
  let seen = c.requests.get(module);
  if (!seen) {
    seen = new Map();
    c.requests.set(module, seen);
  }
  if (seen.has(name) && (seen.get(name) || !full)) {
    return;
  }
  seen.set(name, full);
  const symbol = c.checker.getExportsOfModule(module).find((item) => item.name === name);
  if (!symbol) {
    throw new AnalysisError(
      "plumb.json",
      `A public declaration dependency has no export named ${name}.`,
    );
  }
  c.visitSymbol(symbol, full);
  const source = sourceOf(module);
  if (!source) {
    return;
  }
  c.sourceRecord(source);
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) {
        if (item.name.text === name) {
          c.included.add(item);
          c.containers.add(statement);
          if (statement.moduleSpecifier) {
            c.request(
              c.reference(statement.moduleSpecifier),
              (item.propertyName ?? item.name).text,
              full,
            );
          }
        }
      }
    } else if (
      statement.exportClause &&
      ts.isNamespaceExport(statement.exportClause) &&
      statement.exportClause.name.text === name
    ) {
      c.included.add(statement);
      if (statement.moduleSpecifier) {
        c.visitSymbol(c.reference(statement.moduleSpecifier), full);
      }
    } else if (!statement.exportClause && statement.moduleSpecifier && name !== "default") {
      const destination = c.checker.getSymbolAtLocation(statement.moduleSpecifier),
        exported =
          destination &&
          c.checker.getExportsOfModule(alias(c, destination)).find((item) => item.name === name);
      if (exported && alias(c, exported) === alias(c, symbol)) {
        c.included.add(statement);
        c.request(c.reference(statement.moduleSpecifier), name, full);
      }
    }
  }
}

export function visitSymbol(c: Collector, symbol: ts.Symbol | undefined, full = false): void {
  if (!symbol || (c.symbols.has(symbol) && (c.symbols.get(symbol) || !full))) {
    return;
  }
  c.symbols.set(symbol, full);
  if (symbol.flags & ts.SymbolFlags.Alias) {
    for (const declaration of symbol.declarations ?? []) {
      c.select(declaration);
      const statement = statementOf(declaration);
      if (ts.isImportDeclaration(statement)) {
        const module = c.reference(statement.moduleSpecifier);
        if (ts.isImportSpecifier(declaration)) {
          c.request(module, (declaration.propertyName ?? declaration.name).text, full);
        } else if (ts.isImportClause(declaration)) {
          c.request(module, "default", full);
        } else if (full) {
          c.visitSymbol(module, true);
        }
      } else if (ts.isExportSpecifier(declaration)) {
        const exportDeclaration = declaration.parent.parent;
        if (exportDeclaration.moduleSpecifier) {
          c.request(
            c.reference(exportDeclaration.moduleSpecifier),
            (declaration.propertyName ?? declaration.name).text,
            full,
          );
        } else {
          c.visitSymbol(c.checker.getExportSpecifierLocalTargetSymbol(declaration), full);
        }
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        statement.moduleReference.expression
      ) {
        c.visitSymbol(c.reference(statement.moduleReference.expression), full);
      }
    }
    const target = c.checker.getAliasedSymbol(symbol);
    if (!target.declarations?.length) {
      throw new AnalysisError(
        "plumb.json",
        `The public symbol ${symbol.name} has no resolved declaration.`,
      );
    }
    c.visitSymbol(target, full);
    return;
  }
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isSourceFile(declaration)) {
      c.sourceRecord(declaration);
    } else if (!ts.isTypeParameterDeclaration(declaration) && !ts.isParameter(declaration)) {
      c.select(declaration, full);
    }
  }
  if (full && symbol.flags & ts.SymbolFlags.Module) {
    for (const entry of c.checker.getExportsOfModule(symbol)) {
      c.request(symbol, entry.name, true);
    }
  }
}

export function select(c: Collector, declaration: ts.Node, full = false): void {
  if (c.libraries.has(resolve(declaration.getSourceFile().fileName))) {
    return;
  }
  const statement = statementOf(declaration);
  const partial =
    ts.isVariableDeclaration(declaration) ||
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isExportSpecifier(declaration);
  const node = partial
    ? declaration
    : ts.isModuleDeclaration(declaration)
      ? declaration
      : statement;
  c.included.add(node);
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    c.containers.add(parent);
  }
  c.sourceRecord(node.getSourceFile());
  if (ts.isModuleDeclaration(node)) {
    if (full) {
      const symbol = c.checker.getSymbolAtLocation(node.name);
      if (symbol) {
        c.visitSymbol(symbol, true);
      }
    }
    return;
  }
  if (
    c.scanned.has(node) ||
    ts.isImportDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement)
  ) {
    return;
  }
  c.scanned.add(node);
  const inspect = (child: ts.Node): void => {
    if (privateMember(child)) {
      return;
    }
    if (
      child.kind === ts.SyntaxKind.AnyKeyword &&
      owned(c.analysis, child.getSourceFile().fileName)
    ) {
      fail(
        c,
        child,
        "A public signature contains any; use unknown or an explicit precise API type instead of accepting an incomplete type contract.",
      );
    }
    if (
      ts.isImportTypeNode(child) &&
      ts.isLiteralTypeNode(child.argument) &&
      literal(child.argument.literal)
    ) {
      const module = c.reference(child.argument.literal);
      if (child.qualifier) {
        let first: ts.EntityName = child.qualifier;
        while (ts.isQualifiedName(first)) {
          first = first.left;
        }
        c.request(module, first.text, !ts.isQualifiedName(child.qualifier));
        c.visitSymbol(c.checker.getSymbolAtLocation(child.qualifier), true);
      } else {
        c.visitSymbol(module, true);
      }
    }
    if (ts.isIdentifier(child)) {
      const entity =
        ts.isQualifiedName(child.parent) && child.parent.right === child ? child.parent : child;
      const qualifier =
        (ts.isQualifiedName(entity.parent) && entity.parent.left === entity) ||
        (ts.isPropertyAccessExpression(entity.parent) && entity.parent.expression === entity);
      c.visitSymbol(c.checker.getSymbolAtLocation(child), !qualifier);
    }
    ts.forEachChild(child, inspect);
  };
  inspect(node);
}
