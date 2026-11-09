import assert from "node:assert/strict";

import { plumbBoundaryRules } from "../eslint/rules/boundaries.ts";

export interface Reported {
  messageId?: string;
  message?: string;
  data?: Record<string, unknown>;
  node?: unknown;
  [field: string]: unknown;
}

// test doubles: each mock carries only the fields the rule under test reads
export function double<C extends object>(fields: object): C;

export function double(fields: object): object {
  return fields;
}

// a rule's listener as callable visitors; calling a selector the rule does not handle fails the test
export const listen = (listener: object): Record<string, (node?: object) => void> =>
  new Proxy<Record<string, (node?: object) => void>>(
    {},
    {
      get: (_target, key) => (node?: object) => {
        const visitor: unknown = typeof key === "string" ? Reflect.get(listener, key) : undefined;
        assert.ok(typeof visitor === "function", `no visitor for ${String(key)}`);
        Reflect.apply(visitor, undefined, [node]);
      },
    },
  );

export const identifier = (name: string): { type: string; name: string } => ({
  type: "Identifier",
  name,
});

export const member = (object: object, key: string | object, computed = false): object => ({
  type: "MemberExpression",
  object,
  property:
    computed && typeof key === "string"
      ? { type: "Literal", value: key }
      : typeof key === "string"
        ? identifier(key)
        : key,
  computed,
});

export interface Binding {
  defs: object[];
  references: object[];
}

interface Ownership {
  reports: Reported[];
  visitors: Record<string, (node?: object) => void>;
  bindings: Map<string, Binding>;
  bind: (name: string, init: object, pattern?: object) => { node: object; value: Binding };
}

export function ownership(rows: object[], bindings = new Map<string, Binding>()): Ownership {
  const reports: Reported[] = [],
    context = {
      cwd: "/repo",
      filename: "/repo/src/main.ts",
      options: [{ rows }],
      sourceCode: { getScope: () => ({ set: bindings }) },
      report: (item: Reported) => reports.push(item),
    };
  const bind = (name: string, init: object, pattern: object = identifier(name)) => {
    const node = { type: "VariableDeclarator", id: pattern, init },
      value: Binding = { defs: [{ type: "Variable", node }], references: [] };
    bindings.set(name, value);
    return { node, value };
  };
  return {
    reports,
    visitors: listen(plumbBoundaryRules.owners.create(double(context))),
    bindings,
    bind,
  };
}
