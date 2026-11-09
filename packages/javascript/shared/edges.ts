import { unwrapExpression, type Variable, variableOf } from "../eslint/effects.ts";
import type { Node, RuleContext, RuleListener } from "../eslint/types.ts";

type Constant = string | number;

export interface Edge {
  kind: "static" | "reexport" | "dynamic" | "require" | "type";
  specifier: string | null;
  node: Node;
  computed: boolean;
}

// constant folding over ESTree: literals, templates and + chains of constants, and never-reassigned
// const bindings. Source is never evaluated.
export function constants(context: RuleContext): {
  value: (node: Node | null | undefined, seen?: Set<Variable>) => Constant | undefined;
  literal: (node: Node | null | undefined) => string | undefined;
} {
  const modified = (variable: Variable): boolean =>
    (variable.references ?? []).some((reference) => reference.isWrite?.() && !reference.init);
  const value = (
    input: Node | null | undefined,
    seen = new Set<Variable>(),
  ): Constant | undefined => {
    const node = unwrapExpression(input);
    if (!node || seen.size > 48) {
      return undefined;
    }
    if (
      node.type === "Literal" &&
      (typeof node.value === "string" || typeof node.value === "number")
    ) {
      return node.value;
    }
    if (node.type === "TemplateLiteral") {
      let text = "";
      for (const [index, quasi] of node.quasis.entries()) {
        text += quasi.value.cooked ?? "";
        if (index < node.expressions.length) {
          const part = value(node.expressions[index], seen);
          if (part === undefined) {
            return undefined;
          }
          text += String(part);
        }
      }
      return text;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = value(node.left, seen),
        right = value(node.right, seen);
      return left === undefined || right === undefined
        ? undefined
        : typeof left === "number" && typeof right === "number"
          ? left + right
          : `${left}${right}`;
    }
    if (node.type !== "Identifier") {
      return undefined;
    }
    const variable = variableOf(context, node);
    if (!variable || seen.has(variable) || modified(variable)) {
      return undefined;
    }
    const definition = variable.defs?.find(
      (item) => item.type === "Variable" && item.node.id.type === "Identifier",
    );
    return definition?.type === "Variable"
      ? value(definition.node.init, new Set([...seen, variable]))
      : undefined;
  };
  const literal = (node: Node | null | undefined): string | undefined => {
    const folded = value(node);
    return folded === undefined ? undefined : String(folded);
  };
  return { value, literal };
}

// a free identifier named name: no local binding shadows the global it reads
const unbound = (context: RuleContext, node: Node | null | undefined, name: string): boolean =>
  node?.type === "Identifier" && node.name === name && !variableOf(context, node)?.defs?.length;

// require("x"), module.require("x"), (0, require)("x") and createRequire(url)("x") all load a
// module eagerly
export function isRequireCall(context: RuleContext, node: Node | null | undefined): boolean {
  if (node?.type !== "CallExpression") {
    return false;
  }
  const target =
    node.callee.type === "SequenceExpression"
      ? node.callee.expressions.at(-1)
      : unwrapExpression(node.callee);
  if (unbound(context, target, "require")) {
    return true;
  }
  if (
    target?.type === "MemberExpression" &&
    !target.computed &&
    target.property.type === "Identifier" &&
    target.property.name === "require" &&
    unbound(context, target.object, "module")
  ) {
    return true;
  }
  return (
    target?.type === "CallExpression" &&
    (target.callee.type === "Identifier"
      ? target.callee.name
      : target.callee.type === "MemberExpression" && target.callee.property.type === "Identifier"
        ? target.callee.property.name
        : undefined) === "createRequire"
  );
}

// every module edge of the file, as { kind: static|reexport|dynamic|require|type, specifier|null,
// node, computed }.
// computed is true when the specifier is not a constant, so no rule can check where the edge points.
export function edgeVisitors(context: RuleContext, visit: (edge: Edge) => void): RuleListener {
  const { literal } = constants(context);
  const edge = (
    kind: Edge["kind"],
    node: Node,
    source: Node | null | undefined,
    typeOnly = false,
  ): void => {
    const specifier = literal(source);
    visit({
      kind: typeOnly ? "type" : kind,
      specifier: specifier ?? null,
      node,
      computed: specifier === undefined,
    });
  };
  return {
    ImportDeclaration(node) {
      edge("static", node, node.source, node.importKind === "type");
    },
    ExportNamedDeclaration(node) {
      if (node.source) {
        edge("reexport", node, node.source, node.exportKind === "type");
      }
    },
    ExportAllDeclaration(node) {
      edge("reexport", node, node.source, node.exportKind === "type");
    },
    TSImportEqualsDeclaration(node) {
      if (node.moduleReference.type === "TSExternalModuleReference") {
        edge("require", node, node.moduleReference.expression, node.importKind === "type");
      }
    },
    TSImportType(node) {
      edge(
        "type",
        node,
        node.argument.type === "TSLiteralType" ? node.argument.literal : undefined,
        true,
      );
    },
    ImportExpression(node) {
      edge("dynamic", node, node.source);
    },
    CallExpression(node) {
      if (isRequireCall(context, node)) {
        edge("require", node, node.arguments[0]);
      }
    },
  };
}
