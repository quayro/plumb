import ts from "typescript";

import { AnalysisError } from "./analysis.ts";
import {
  hasModifier,
  isNamespaceBody,
  isStatement,
  nameNode,
  privateMember,
  type SignatureGraph,
  sorted,
  type SourceRecord,
} from "./signature-nodes.ts";
import { literal } from "./source-syntax.ts";

// prints each recorded module with only its selected declarations, sorted so the output is stable
export function printSignatures(
  records: Iterable<SourceRecord>,
  included: ReadonlySet<ts.Node>,
  containers: ReadonlySet<ts.Node>,
  rewrites: ReadonlyMap<ts.Node, string>,
): SignatureGraph["signatures"] {
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  });
  const sortNodes = <T extends ts.Node>(nodes: readonly T[]): T[] =>
    [...nodes].sort((a, b) => {
      const key = (node: ts.Node): string => {
        const name = nameNode(node);
        const text = name
          ? ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || literal(name)
            ? name.text
            : name.getText()
          : undefined;
        const specifier =
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          literal(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : "";
        return `${hasModifier(node, ts.SyntaxKind.StaticKeyword) ? "static:" : ""}${text ?? (ts.isConstructorDeclaration(node) ? "constructor" : `${node.kind}:${specifier}`)}`;
      };
      const left = key(a),
        right = key(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const signatures = new Map<string, { declaration: string; references: Record<string, string> }>();
  for (const item of records) {
    const transformed = ts.transform(item.source, [
      (context) => {
        const factory = context.factory;
        const statements = (nodes: readonly ts.Statement[]): ts.Statement[] =>
          sortNodes(nodes.map(retain).filter(isStatement));
        function retain(node: ts.Node): ts.Node | undefined {
          if (!included.has(node) && !containers.has(node)) {
            return undefined;
          }
          if (ts.isModuleDeclaration(node)) {
            return factory.updateModuleDeclaration(
              node,
              node.modifiers,
              node.name,
              node.body &&
                (ts.isModuleBlock(node.body)
                  ? factory.updateModuleBlock(node.body, statements(node.body.statements))
                  : retainBody(node.body)),
            );
          }
          if (ts.isVariableStatement(node)) {
            return factory.updateVariableStatement(
              node,
              node.modifiers,
              factory.updateVariableDeclarationList(
                node.declarationList,
                node.declarationList.declarations
                  .filter((entry) => included.has(entry))
                  .flatMap((entry) => {
                    const next = ts.visitNode(entry, visit, ts.isVariableDeclaration);
                    return next ? [next] : [];
                  }),
              ),
            );
          }
          if (ts.isImportDeclaration(node) && node.importClause) {
            const clause = node.importClause,
              bindings = clause.namedBindings;
            const named =
              bindings &&
              (ts.isNamespaceImport(bindings)
                ? included.has(bindings)
                  ? bindings
                  : undefined
                : factory.updateNamedImports(
                    bindings,
                    bindings.elements.filter((entry) => included.has(entry)),
                  ));
            const name = included.has(clause) ? clause.name : undefined;
            if (!name && (!named || (ts.isNamedImports(named) && !named.elements.length))) {
              return undefined;
            }
            return factory.updateImportDeclaration(
              node,
              node.modifiers,
              factory.updateImportClause(clause, clause.isTypeOnly, name, named),
              ts.visitNode(node.moduleSpecifier, visit, ts.isExpression) ?? node.moduleSpecifier,
              node.attributes,
            );
          }
          if (
            ts.isExportDeclaration(node) &&
            node.exportClause &&
            ts.isNamedExports(node.exportClause)
          ) {
            return factory.updateExportDeclaration(
              node,
              node.modifiers,
              node.isTypeOnly,
              factory.updateNamedExports(
                node.exportClause,
                node.exportClause.elements.filter((entry) => included.has(entry)),
              ),
              node.moduleSpecifier &&
                (ts.visitNode(node.moduleSpecifier, visit, ts.isExpression) ??
                  node.moduleSpecifier),
              node.attributes,
            );
          }
          return ts.visitNode(node, visit);
        }
        function retainBody(body: ts.Node): ts.NamespaceBody | undefined {
          const next = retain(body);
          return isNamespaceBody(next) ? next : undefined;
        }
        function visit(node: ts.Node): ts.Node {
          const rewrite = rewrites.get(node);
          if (rewrite !== undefined) {
            return factory.createStringLiteral(rewrite);
          }
          if (ts.isClassDeclaration(node)) {
            const hidden = new Set(
              node.members
                .filter(privateMember)
                .map((member) => hasModifier(member, ts.SyntaxKind.StaticKeyword)),
            );
            const members = node.members
              .filter((member) => !privateMember(member))
              .map((member) => ts.visitEachChild(member, visit, context));
            for (const isStatic of hidden) {
              members.push(
                factory.createPropertyDeclaration(
                  isStatic ? [factory.createModifier(ts.SyntaxKind.StaticKeyword)] : undefined,
                  factory.createPrivateIdentifier(
                    isStatic ? "#__plumb_private_static" : "#__plumb_private",
                  ),
                  undefined,
                  factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword),
                  undefined,
                ),
              );
            }
            return factory.updateClassDeclaration(
              node,
              node.modifiers,
              node.name,
              node.typeParameters?.map((parameter) => ts.visitEachChild(parameter, visit, context)),
              node.heritageClauses?.map((clause) => ts.visitEachChild(clause, visit, context)),
              sortNodes(members),
            );
          }
          if (ts.isInterfaceDeclaration(node)) {
            return factory.updateInterfaceDeclaration(
              node,
              node.modifiers,
              node.name,
              node.typeParameters?.map((parameter) => ts.visitEachChild(parameter, visit, context)),
              node.heritageClauses?.map((clause) => ts.visitEachChild(clause, visit, context)),
              sortNodes(node.members.map((member) => ts.visitEachChild(member, visit, context))),
            );
          }
          return ts.visitEachChild(node, visit, context);
        }
        return (source: ts.SourceFile): ts.SourceFile =>
          factory.updateSourceFile(source, statements(source.statements));
      },
    ]);
    try {
      const [output] = transformed.transformed;
      if (!output) {
        throw new AnalysisError("plumb.json", "The declaration transform produced no module.");
      }
      const declaration = printer.printFile(output).trimEnd();
      signatures.set(item.name, {
        declaration: `${declaration || (ts.isExternalModule(item.source) ? "export {};" : "")}\n`,
        references: sorted(item.references),
      });
    } finally {
      transformed.dispose();
    }
  }
  return sorted(signatures);
}
