import { constants } from "../../shared/edges.ts";
import { eslintRuleSchema, type RuleOptions } from "../options.ts";
import type { Node, RuleModule, TSESTree } from "../types.ts";

type Phrase = (node: Node | null | undefined) => boolean;

type Shape = RuleOptions<"plumb/literal-calls">["calls"][number]["args"][number];

// an argument shape: a literal, an optional one, an object of literals or an array of them; phrase
// folds constants
const SHAPES: Record<Shape, (node: Node | undefined, phrase: Phrase) => boolean> = {
  literal: (node, phrase) => phrase(node),
  "literal?": (node, phrase) => node === undefined || phrase(node),
  "literal-object": (node, phrase) =>
    node?.type === "ObjectExpression" &&
    node.properties.every(
      (entry) => entry.type === "Property" && !entry.computed && phrase(entry.value),
    ),
  "literal-array": (node, phrase) =>
    node?.type === "ArrayExpression" && node.elements.every((entry) => phrase(entry)),
};

const calleeName = (node: TSESTree.CallExpression): string | undefined =>
  node.callee.type === "Identifier"
    ? node.callee.name
    : node.callee.type === "MemberExpression" && !node.callee.computed
      ? node.callee.property.name
      : undefined;

// calls: rows of { callee, args, moduleScope }; callee is a pattern, args name each shape in order
const literalCallsRule: RuleModule<[Partial<RuleOptions<"plumb/literal-calls">>?]> = {
  meta: {
    type: "problem",
    schema: eslintRuleSchema("plumb/literal-calls"),
    messages: {
      literal: "{{callee}} states its arguments as literals ({{args}}), so each key is on the page",
      scope: "{{callee}} is called at module scope, so boot sees every value it registers",
    },
  },
  create(context) {
    const options = context.options[0];
    const rows = (options?.calls ?? []).map((row) => ({
      ...row,
      pattern: new RegExp(row.callee),
    }));
    const { value } = constants(context);
    const phrase: Phrase = (node) => typeof value(node) === "string";
    return {
      CallExpression(node) {
        const name = calleeName(node);
        for (const row of name ? rows.filter((entry) => entry.pattern.test(name)) : []) {
          const extra = node.arguments.length > row.args.length;
          const shaped = row.args.every((shape, index) =>
            SHAPES[shape](node.arguments[index], phrase),
          );
          if (extra || !shaped) {
            context.report({
              node,
              messageId: "literal",
              data: { callee: name, args: row.args.join(", ") },
            });
          }
          if (
            row.moduleScope &&
            context.sourceCode
              .getAncestors(node)
              .some(
                (ancestor) =>
                  ancestor.type.includes("Function") ||
                  ((ancestor.type === "PropertyDefinition" ||
                    ancestor.type === "AccessorProperty") &&
                    !ancestor.static),
              )
          ) {
            context.report({
              node,
              messageId: "scope",
              data: { callee: name },
            });
          }
        }
      },
    };
  },
}; // a registry read at boot holds values a reader can find by searching for them

const isChainedBy = (node: Node, chain: string | undefined): boolean => {
  const member = node.parent;
  return (
    member?.type === "MemberExpression" &&
    member.object === node &&
    !member.computed &&
    member.property.name === chain &&
    member.parent?.type === "CallExpression" &&
    member.parent.callee === member
  );
};

// object.method(...) for the listed methods is always followed by .chain(...)
const chainedCallRule: RuleModule<[Partial<RuleOptions<"plumb/chained-call">>?]> = {
  meta: {
    type: "problem",
    schema: eslintRuleSchema("plumb/chained-call"),
    messages: {
      chain: "{{object}}.{{method}}(...) is followed by .{{chain}}(...) in this module",
    },
  },
  create(context) {
    const { object, methods = [], chain } = context.options[0] ?? {};
    const listed = new Set<string>(methods);
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.object.type !== "Identifier" ||
          callee.object.name !== object ||
          !listed.has(callee.property.name)
        ) {
          return;
        }
        const branch = node.parent?.type === "ConditionalExpression" && node.parent.test !== node; // a ternary may choose the call it chains
        if (!isChainedBy(node, chain) && !(branch && isChainedBy(node.parent, chain))) {
          context.report({
            node,
            messageId: "chain",
            data: { object, method: callee.property.name, chain },
          });
        }
      },
    };
  },
};

export const plumbCallRules = {
  "chained-call": chainedCallRule,
  "literal-calls": literalCallsRule,
};
