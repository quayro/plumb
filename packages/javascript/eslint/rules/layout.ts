import type { Node, RuleModule } from "../types.ts";

// an export of a declaration takes the declaration's section; a bare export list stays an export
const unexported = (node: Node): Node =>
  "declaration" in node && node.declaration ? node.declaration : node;

const moduleSection = (node: Node): string => {
  const declaration = unexported(node);
  if (
    declaration.type === "ExportNamedDeclaration" ||
    declaration.type === "ExportAllDeclaration"
  ) {
    return "exports";
  }
  if (declaration.type === "ImportDeclaration") {
    return "imports";
  }
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations.some(
      (entry) =>
        entry.init?.type === "ArrowFunctionExpression" || entry.init?.type === "FunctionExpression",
    )
      ? "function"
      : "variables";
  }
  return declaration.type;
};

const moduleSpacingRule: RuleModule = {
  meta: {
    type: "layout",
    fixable: "whitespace",
    schema: [],
    messages: {
      missing: "Separate module sections, class members, and functions with a blank line.",
      joined: "Keep consecutive bound singleton exports together.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    const isBoundExport = (node: Node): boolean =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "VariableDeclaration" &&
      node.declaration.declarations.every(
        (entry) =>
          entry.init?.type === "CallExpression" &&
          entry.init.callee.type === "MemberExpression" &&
          !entry.init.callee.computed &&
          entry.init.callee.property.name === "bind",
      );
    const requireBlankLine = (previous: Node, current: Node): void => {
      const comments = source.getTokensBetween(previous, current, {
        includeComments: true,
      });
      const boundaries = [previous, ...comments, current];
      if (
        boundaries.some(
          (entry, offset) =>
            offset > 0 &&
            entry.loc.start.line > (boundaries[offset - 1]?.loc.end.line ?? Infinity) + 1,
        )
      ) {
        return;
      }
      const anchor =
        comments.find((entry) => entry.loc.start.line > previous.loc.end.line) ?? current;
      const onNewLine = anchor.loc.start.line > previous.loc.end.line;
      // a class member is indented, so the blank line goes at the start of its line, before the indentation
      const lineStart = source.getIndexFromLoc({ line: anchor.loc.start.line, column: 0 });
      const indent = source.lines[anchor.loc.start.line - 1]?.match(/^\s*/)?.[0] ?? "";
      context.report({
        node: current,
        messageId: "missing",
        fix: (fixer) =>
          onNewLine
            ? fixer.insertTextBeforeRange([lineStart, lineStart], "\n")
            : fixer.insertTextBefore(anchor, `\n\n${indent}`),
      });
    };

    return {
      Program(node) {
        for (let index = 1; index < node.body.length; index++) {
          const previous = node.body[index - 1];
          const current = node.body[index];
          if (!previous || !current) {
            continue;
          }
          if (isBoundExport(previous) && isBoundExport(current)) {
            const gap = source.text.slice(previous.range[1], current.range[0]);
            if (/^\s*\n\s*\n\s*$/.test(gap)) {
              context.report({
                node: current,
                messageId: "joined",
                fix: (fixer) => fixer.replaceTextRange([previous.range[1], current.range[0]], "\n"),
              });
            }
            continue;
          }
          const section = moduleSection(current);
          if (
            section === moduleSection(previous) &&
            ["imports", "exports", "variables"].includes(section)
          ) {
            continue;
          }
          requireBlankLine(previous, current);
        }
      },
      ClassBody(node) {
        for (let index = 1; index < node.body.length; index++) {
          const previous = node.body[index - 1];
          const current = node.body[index];
          if (!previous || !current) {
            continue;
          }
          if (
            previous.type === "MethodDefinition" &&
            current.type === "MethodDefinition" &&
            previous.static === current.static &&
            source.getText(previous.key) === source.getText(current.key) &&
            (previous.kind === current.kind ||
              (previous.kind === "get" && current.kind === "set") ||
              (previous.kind === "set" && current.kind === "get"))
          ) {
            continue;
          }
          const previousSection =
            previous.type === "PropertyDefinition" || previous.type === "AccessorProperty"
              ? "variables"
              : "function";
          const currentSection =
            current.type === "PropertyDefinition" || current.type === "AccessorProperty"
              ? "variables"
              : "function";
          if (previousSection === currentSection && currentSection === "variables") {
            continue;
          }
          requireBlankLine(previous, current);
        }
      },
    };
  },
};

const importsFirstRule: RuleModule = {
  meta: {
    type: "layout",
    schema: [],
    messages: {
      first:
        "Keep static imports before module declarations; move them manually while preserving dependency evaluation order.",
    },
  },
  create(context) {
    return {
      Program(node) {
        let firstStatement: Node | undefined;
        for (const statement of node.body) {
          if (statement.type === "ExpressionStatement" && statement.directive && !firstStatement) {
            continue;
          }
          if (statement.type !== "ImportDeclaration") {
            firstStatement ??= statement;
            continue;
          }
          if (!firstStatement) {
            continue;
          }
          context.report({
            node: statement,
            messageId: "first",
          });
        }
      },
    };
  },
};

const classStyleRule: RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      function: "Library behavior belongs in a class; export a bound method from its singleton.",
      class: "A library module organizes its behavior in a class.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const declarations = node.body.map(unexported);
        if (!declarations.some((entry) => entry.type === "ClassDeclaration")) {
          context.report({ node, messageId: "class" });
        }
        for (const entry of declarations) {
          if (entry.type === "FunctionDeclaration") {
            context.report({ node: entry, messageId: "function" });
            continue;
          }
          if (entry.type !== "VariableDeclaration") {
            continue;
          }
          for (const declaration of entry.declarations) {
            const init = declaration.init;
            if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") {
              context.report({ node: declaration, messageId: "function" });
            }
          }
        }
      },
    };
  },
};

export const plumbLayoutRules = {
  "class-style": classStyleRule,
  "imports-first": importsFirstRule,
  "module-spacing": moduleSpacingRule,
};
