import { globMatches } from "../shared/glob.ts";
import { rulesRelativeTo } from "./rules/shared.ts";
import type { RuleContext, RuleModule } from "./types.ts";

type Visitor = (...args: unknown[]) => void;

// Object.create derives the view from the context itself, so it answers every member the context does
const isRuleContext = (value: unknown): value is RuleContext =>
  typeof value === "object" && value !== null;

interface Row {
  files: string[];
  options: unknown[];
}

// every applicable row gets its own rule state; overlapping contracts are all enforced
export const scopedRule = (rule: RuleModule, root: string): RuleModule<[Row[]?]> => ({
  ...rule,
  meta: {
    ...rule.meta,
    schema: [
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            files: { type: "array", items: { type: "string" } },
            options: { type: "array", maxItems: 1 },
          },
          required: ["files", "options"],
          additionalProperties: false,
        },
      },
    ],
  },
  create(context) {
    const file = rulesRelativeTo(root, context.filename);
    const visitors: Record<string, Visitor> = {};
    // ESLint validated the rows against the schema above before create runs
    const rows = context.options[0] ?? [];
    for (const row of rows) {
      if (!globMatches(row.files, file)) {
        continue;
      }
      const view: unknown = Object.create(context, { options: { value: row.options } });
      if (!isRuleContext(view)) {
        throw new TypeError("A scoped rule could not derive its rule context");
      }
      for (const [selector, visitor] of Object.entries(rule.create(view))) {
        if (typeof visitor !== "function") {
          continue;
        }
        const previous = visitors[selector];
        visitors[selector] = (...args) => {
          previous?.(...args);
          Reflect.apply(visitor, undefined, args);
        };
      }
    }
    return visitors;
  },
});
