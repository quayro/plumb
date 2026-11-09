import ts from "typescript";

interface Edge {
  node: ts.Node;
  specifier?: string;
  dynamic: boolean;
  typeOnly: boolean;
}

export const isScript = (path: string): boolean => /\.[cm]?[jt]sx?$/.test(path);

export const isTest = (path: string): boolean =>
  /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);

export const literal = (
  node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

export const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
};

// inline type specifiers keep an empty runtime import under verbatimModuleSyntax.
export const edges = (source: ts.Node): Edge[] => {
  const found: Edge[] = [];
  walk(source, (node) => {
    if (ts.isImportDeclaration(node) && literal(node.moduleSpecifier)) {
      const clause = node.importClause;
      found.push({
        node,
        specifier: node.moduleSpecifier.text,
        dynamic: false,
        typeOnly:
          clause?.isTypeOnly === true || clause?.phaseModifier === ts.SyntaxKind.TypeKeyword,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      literal(node.moduleSpecifier)
    ) {
      found.push({
        node,
        specifier: node.moduleSpecifier.text,
        dynamic: false,
        typeOnly: node.isTypeOnly,
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      found.push({
        node,
        ...(expression && literal(expression) && { specifier: expression.text }),
        dynamic: false,
        typeOnly: node.isTypeOnly,
      });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      literal(node.argument.literal)
    ) {
      found.push({
        node,
        specifier: node.argument.literal.text,
        dynamic: false,
        typeOnly: true,
      });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      found.push({
        node,
        ...(argument && literal(argument) && { specifier: argument.text }),
        dynamic: true,
        typeOnly: false,
      });
    }
  });
  return found;
};
