import path from "node:path";

import { isRecord } from "../../../../src/schema.ts";
import { edgeVisitors } from "../../shared/edges.ts";
import { createModuleResolver } from "../../shared/module-resolver.ts";
import { eslintRuleSchema, type RuleOptions } from "../options.ts";
import { type Node, plumbSettings, type RuleModule } from "../types.ts";

const holdsNumber = (node: unknown): boolean => {
  if (!isRecord(node) || typeof node.type !== "string") {
    return false;
  }
  if (node.type === "Literal") {
    return typeof node.value === "number" && node.value !== 0; // zero is no amount
  }
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" && (Array.isArray(value) ? value.some(holdsNumber) : holdsNumber(value)),
  );
};

// keys: the property names whose value comes from a named token, never a number in place
const keyedNumbersRule: RuleModule<[Partial<RuleOptions<"plumb/keyed-numbers">>?]> = {
  meta: {
    type: "suggestion",
    schema: eslintRuleSchema("plumb/keyed-numbers"),
    messages: {
      token: "{{key}} takes a named token, never a number in place: {{message}}",
    },
  },
  create(context) {
    const { keys = [], message = "name it once, where its siblings are tuned" } =
      context.options[0] ?? {};
    const listed = new Set<unknown>(keys);
    const check = (key: unknown, value: Node | null): void => {
      if (value && typeof key === "string" && listed.has(key) && holdsNumber(value)) {
        context.report({
          node: value,
          messageId: "token",
          data: { key, message },
        });
      }
    };
    const keyOf = (node: Node): unknown =>
      node.type === "Identifier" ? node.name : node.type === "Literal" ? node.value : undefined;
    return {
      Property(node) {
        check(keyOf(node.key), node.value);
      },
      PropertyDefinition(node) {
        check(keyOf(node.key), node.value);
      },
      AssignmentExpression(node) {
        if (node.left.type === "MemberExpression") {
          check(keyOf(node.left.property), node.right);
        }
      },
      AssignmentPattern(node) {
        // a shorthand property default is already checked as its property's value
        if (
          node.left.type === "Identifier" &&
          !(node.parent.type === "Property" && node.parent.value === node)
        ) {
          check(node.left.name, node.right);
        }
      },
    };
  },
}; // a tuned value lives in one file, so a change to it is one edit

// a module a plain loader runs imports no refused package or specifier, and no file of a refused kind
const plainModuleRule: RuleModule<[Partial<RuleOptions<"plumb/plain-module">>?]> = {
  meta: {
    type: "problem",
    schema: eslintRuleSchema("plumb/plain-module"),
    messages: {
      refused: "{{source}} is refused here: {{reason}}",
      unresolved: "Cannot verify this loader contract: {{source}} does not resolve",
      dynamic: "A computed module specifier cannot be checked here: {{reason}}",
    },
  },
  create(context) {
    const {
      packages,
      specifiers,
      extensions = [],
      reason = "a plain loader runs this module",
    } = context.options[0] ?? {};
    const packagePattern = packages ? new RegExp(packages) : undefined;
    const specifierPattern = specifiers ? new RegExp(specifiers) : undefined;
    const resolver =
      plumbSettings(context).plumbResolver ??
      createModuleResolver(context.cwd || path.dirname(context.filename));
    const refusedFile = (source: string): boolean => {
      if (extensions.some((extension) => source.endsWith(extension))) {
        return true;
      }
      const target = resolver.runtime(context.filename, source);
      return target !== undefined && extensions.some((extension) => target.endsWith(extension));
    };
    const check = (node: Node, source: string): void => {
      if (packagePattern?.test(source) || specifierPattern?.test(source) || refusedFile(source)) {
        context.report({
          node,
          messageId: "refused",
          data: { source, reason },
        });
      } else if (
        resolver.isLocal(context.filename, source) &&
        !resolver.runtime(context.filename, source)
      ) {
        context.report({ node, messageId: "unresolved", data: { source } });
      }
    };
    return edgeVisitors(context, (edge) => {
      if (edge.kind === "type") {
        return;
      }
      if (edge.computed || edge.specifier === null) {
        context.report({
          node: edge.node,
          messageId: "dynamic",
          data: { reason },
        });
        return;
      }
      check(edge.node, edge.specifier);
    });
  },
};

export const plumbValueRules = {
  "keyed-numbers": keyedNumbersRule,
  "plain-module": plainModuleRule,
};
