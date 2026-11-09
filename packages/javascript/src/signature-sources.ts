import { isAbsolute, resolve } from "node:path";

import ts from "typescript";

import { alias, type Collector, fail, sourceOf, type SourceRecord } from "./signature-nodes.ts";
import { literal } from "./source-syntax.ts";

export function sourceRecord(c: Collector, source: ts.SourceFile): SourceRecord | undefined {
  const path = resolve(source.fileName);
  if (c.libraries.has(path)) {
    return undefined;
  }
  const known = c.records.get(source);
  if (known) {
    return known;
  }
  const original = c.originalProgram.getSourceFile(path) ?? source;
  // emit may remove reference directives. Refuse their unsupported ambient closure before it can
  // disappear.
  if (
    [original, source].some(
      (file) =>
        file.referencedFiles.length ||
        file.typeReferenceDirectives.length ||
        file.libReferenceDirectives.length ||
        file.hasNoDefaultLib,
    )
  ) {
    fail(
      c,
      source,
      "Triple-slash reference directives are not supported by signature snapshots; use explicit module imports and declaration modules so ambient dependencies can be recorded completely.",
    );
  }
  const name = c.nameOf(path),
    duplicate = c.labels.get(name);
  if (duplicate && duplicate !== source) {
    fail(
      c,
      source,
      `Two distinct type-provider modules share ${name}; use one unambiguous dependency installation.`,
    );
  }
  const item: SourceRecord = { name, source, references: new Map() };
  c.records.set(source, item);
  c.labels.set(name, source);
  for (const statement of source.statements) {
    if (
      !ts.isExternalModule(source) ||
      ts.isNamespaceExportDeclaration(statement) ||
      (ts.isModuleDeclaration(statement) &&
        (ts.isStringLiteral(statement.name) || statement.flags & ts.NodeFlags.GlobalAugmentation))
    ) {
      c.selectAmbient(statement);
    }
    if (ts.isImportDeclaration(statement) && !statement.importClause) {
      c.included.add(statement);
      c.reference(statement.moduleSpecifier);
    }
  }
  return item;
}

export function selectAmbient(c: Collector, node: ts.Node): void {
  if (c.ambient.has(node)) {
    return;
  }
  c.ambient.add(node);
  if (ts.isModuleDeclaration(node)) {
    c.included.add(node);
    for (
      let parent: ts.Node | undefined = node.parent;
      parent && !ts.isSourceFile(parent);
      parent = parent.parent
    ) {
      c.containers.add(parent);
    }
    c.sourceRecord(node.getSourceFile());
    if (!node.body) {
      return fail(
        c,
        node,
        "An ambient module without a declaration body cannot provide complete signature evidence.",
      );
    }
    if (ts.isModuleBlock(node.body)) {
      node.body.statements.forEach((statement) => {
        c.selectAmbient(statement);
      });
    } else {
      c.selectAmbient(node.body);
    }
  } else if (ts.isVariableStatement(node)) {
    node.declarationList.declarations.forEach((declaration) => {
      c.select(declaration, true);
    });
  } else if (ts.isExportDeclaration(node)) {
    c.included.add(node);
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const item of node.exportClause.elements) {
        c.included.add(item);
        if (node.moduleSpecifier) {
          c.request(c.reference(node.moduleSpecifier), (item.propertyName ?? item.name).text, true);
        } else {
          const target = c.checker.getExportSpecifierLocalTargetSymbol(item);
          if (!target) {
            fail(c, item, "An ambient export has no resolved declaration.");
          }
          c.visitSymbol(target, true);
        }
      }
    } else if (node.moduleSpecifier) {
      c.visitSymbol(c.reference(node.moduleSpecifier), true);
    }
  } else if (ts.isImportDeclaration(node) && !node.importClause) {
    c.included.add(node);
    c.reference(node.moduleSpecifier);
  } else if (ts.isImportEqualsDeclaration(node)) {
    const target = c.checker.getSymbolAtLocation(node.name);
    if (!target) {
      fail(c, node, "An ambient import has no resolved declaration.");
    }
    c.visitSymbol(target, true);
  } else {
    c.select(node, true);
  }
}

export function reference(c: Collector, node: ts.Node): ts.Symbol {
  if (!literal(node)) {
    return fail(c, node, "A public declaration has a nonliteral module dependency.");
  }
  let module = c.checker.getSymbolAtLocation(node);
  if (!module) {
    const source = node.getSourceFile();
    const mode = ts.getModeForUsageLocation(source, node, c.program.getCompilerOptions());
    const resolved = ts.resolveModuleName(
      node.text,
      source.fileName,
      c.program.getCompilerOptions(),
      c.host,
      undefined,
      undefined,
      mode,
    ).resolvedModule;
    const target = resolved && c.program.getSourceFile(resolved.resolvedFileName);
    module = target && c.checker.getSymbolAtLocation(target);
  }
  if (!module) {
    return fail(c, node, `The public declaration dependency ${node.text} could not be resolved.`);
  }
  module = alias(c, module);
  const target = sourceOf(module);
  if (!target) {
    return fail(c, node, `The public declaration dependency ${node.text} has no source module.`);
  }
  const origin = c.sourceRecord(node.getSourceFile()),
    dependency = c.sourceRecord(target);
  if (!origin || !dependency) {
    return fail(c, node, "A module dependency unexpectedly resolves to a global compiler library.");
  }
  const specifier =
    isAbsolute(node.text) || /^[a-z]:[\\/]/i.test(node.text) ? dependency.name : node.text;
  const previous = origin.references.get(specifier);
  if (previous && previous !== dependency.name) {
    fail(
      c,
      node,
      `The module specifier ${specifier} resolves ambiguously in its public declarations.`,
    );
  }
  origin.references.set(specifier, dependency.name);
  c.rewrites.set(node, specifier);
  return module;
}
