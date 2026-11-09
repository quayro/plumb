import { isArray, isRecord } from "../../../../src/schema.ts";
import { eslintRuleSchema, type RuleOptions } from "../options.ts";
import type { RuleModule, TSESTree } from "../types.ts";
import { rulesRelativeTo } from "./shared.ts";

// the default assertion names: expect, assert, and any helper whose name ends in Expect or Assert
const ASSERTION_NAMES = "^(?:expect|assert)|(?:Expect|Assert)$";
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_BASES = new Set(["test", "it", "xit", "xtest", "fit", "ftest"]);

// every name along a callee chain: expect(value).toBe -> toBe, expect; t.assert.ok -> ok, assert, t
const chainNames = (node: TSESTree.Node): string[] => {
  const names: string[] = [];
  for (let current: TSESTree.Node | undefined = node; current;) {
    if (current.type === "Identifier") {
      names.push(current.name);
      break;
    }
    if (current.type === "MemberExpression") {
      if (!current.computed && current.property.type === "Identifier") {
        names.push(current.property.name);
      }
      current = current.object;
    } else {
      current = current.type === "CallExpression" ? current.callee : undefined;
    }
  }
  return names;
};

const baseOf = (node: TSESTree.Node): string | undefined => {
  let current: TSESTree.Node | undefined = node;
  while (current && current.type !== "Identifier") {
    current =
      current.type === "MemberExpression"
        ? current.object
        : current.type === "CallExpression"
          ? current.callee
          : undefined;
  }
  return current?.type === "Identifier" ? current.name : undefined;
};

// a test call names a test or it (with modifiers), or a subtest on a test context
const isTestCall = (node: TSESTree.Node): boolean =>
  node.type === "CallExpression" &&
  (TEST_BASES.has(baseOf(node.callee) ?? "") ||
    (node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "test"));

const callbackOf = (
  node: TSESTree.CallExpression,
): TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression | undefined => {
  const last = node.arguments.at(-1);
  return last?.type === "ArrowFunctionExpression" || last?.type === "FunctionExpression"
    ? last
    : undefined;
};

const isNode = (value: unknown): value is TSESTree.Node =>
  isRecord(value) && typeof value.type === "string";

// nested test bodies are checked on their own, so they never satisfy the test that contains them
const asserts = (node: unknown, pattern: RegExp): boolean => {
  if (!isNode(node)) {
    return false;
  }
  if (node.type === "CallExpression") {
    if (isTestCall(node)) {
      return false;
    }
    if (chainNames(node.callee).some((name) => pattern.test(name))) {
      return true;
    }
  }
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (isArray(value) ? value.some((item) => asserts(item, pattern)) : asserts(value, pattern)),
  );
};

// a test that asserts nothing passes whatever the code does, so every test callback must assert
export const testAssertionsRule: RuleModule<[Partial<RuleOptions<"plumb/test-assertions">>?]> = {
  meta: {
    type: "problem",
    schema: eslintRuleSchema("plumb/test-assertions"),
    messages: {
      missing:
        "A test must assert something: call expect, assert or a helper ending in Expect or Assert in its body",
    },
  },
  create(context) {
    const { root = context.cwd, assertions = ASSERTION_NAMES } = context.options[0] ?? {};
    if (!TEST_FILE.test(rulesRelativeTo(root, context.filename))) {
      return {};
    }
    const pattern = new RegExp(assertions);
    return {
      CallExpression(node) {
        const callback = isTestCall(node) && callbackOf(node);
        if (callback && !asserts(callback.body, pattern)) {
          context.report({ node, messageId: "missing" });
        }
      },
    };
  },
};
