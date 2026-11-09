import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { check, firstOf, fixture, nodeOf, roleOf, shape } from "./conventions-support.ts";

await test("role import boundaries use literal specifiers, type imports and compiler-resolved aliases", (t) => {
  const context = fixture(
    t,
    {
      "src/main.ts":
        'import { value } from "@shared/value.js"; import type { Data } from "../shared/types.js"; export { value };',
      "shared/value.ts": "export const value = 1;",
      "shared/types.ts": "export interface Data { value: number }",
    },
    { imports: { allow: ["shared/**"], deny: ["node:fs"] } },
  );
  assert.deepEqual(check(context), []);
  writeFileSync(
    join(context.root, "src/main.ts"),
    'import "node:fs"; import type { Data } from "../shared/types.js";',
  );
  roleOf(context).imports?.deny?.push("shared/types.ts");
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every((item) => item.rule === "conventions.imports"));
  assert.ok(diagnostics.some((item) => item.message.includes("node:fs")));
  assert.ok(diagnostics.some((item) => item.message.includes("shared/types.ts")));
});

await test("computed, missing and excluded local dependencies are incomplete", (t) => {
  const context = fixture(
    t,
    {
      "src/main.ts": "export const load = (name: string) => import(name);",
      "shared/value.ts": "export const value = 1;",
    },
    { imports: { allow: ["shared/**"] } },
  );
  assert.equal(firstOf(context).status, "incomplete");
  writeFileSync(join(context.root, "src/main.ts"), 'import "./missing.js";');
  assert.match(firstOf(context).message, /Cannot resolve local dependency/);
  writeFileSync(join(context.root, "src/main.ts"), 'import "../shared/value.js";');
  context.files = context.files.filter((path) => path !== "shared/value.ts");
  assert.match(firstOf(context).message, /outside the checked inventory/);
});

await test("allow-empty import policy is meaningful and forbids every observed dependency", (t) => {
  const context = fixture(
    t,
    { "src/main.ts": "export const value = 1;" },
    { imports: { allow: [] } },
  );
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "src/main.ts"), 'import "node:path";');
  assert.equal(firstOf(context).rule, "conventions.imports");
});

await test("resolved export names include aliases and type reexports", (t) => {
  const context = fixture(
    t,
    {
      "src/main.ts":
        'export { implementation as run } from "../shared/implementation.js"; export type { Version } from "../shared/implementation.js";',
      "shared/implementation.ts": "export const implementation = 1; export type Version = string;",
    },
    {
      exports: { require: ["run", "Version"], allow: ["run", "Version"], name: "^(run|Version)$" },
    },
  );
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "src/main.ts"), "export const extra = 1;");
  const diagnostics = check(context);
  assert.equal(diagnostics.filter((item) => item.rule === "conventions.exports").length, 3);
  assert.ok(diagnostics.some((item) => /requires export run/.test(item.message)));
  assert.ok(diagnostics.some((item) => /does not allow export extra/.test(item.message)));
});

await test("missing reexports and unsupported CommonJS exports cannot claim a complete shape", (t) => {
  const context = fixture(
    t,
    { "src/main.ts": 'export * from "./missing.js";' },
    { exports: { allow: [] } },
  );
  assert.equal(firstOf(context).status, "incomplete");
  const commonjs = fixture(
    t,
    { "src/main.cjs": "exports.run = () => 1;" },
    { exports: { require: ["run"] } },
  );
  assert.ok(
    check(commonjs).some(
      (item) =>
        item.rule === "conventions.analysis" &&
        item.status === "incomplete" &&
        /CommonJS/.test(item.message),
    ),
  );
});

await test("positive selectors distinguish exported aliases, nested members and destructured bindings", (t) => {
  const context = fixture(
    t,
    {
      "src/main.ts":
        "function implementation() { return 1; } export { implementation as run }; class Owner { execute() {} } const { one, two } = { one: 1, two: 2 }; export { one };",
    },
    {
      javascript: {
        nodes: [
          {
            id: "public-function",
            select: {
              kinds: ["function"],
              names: ["implementation"],
              exported: true,
              topLevel: true,
            },
            count: { min: 1, max: 1 },
          },
          {
            id: "nested-method",
            select: { kinds: ["method"], names: ["execute"], exported: false, topLevel: false },
            count: { min: 1, max: 1 },
          },
          {
            id: "bindings",
            select: { kinds: ["variable"], names: ["one", "two"], topLevel: true },
            count: { min: 2, max: 2 },
          },
          {
            id: "private-binding",
            select: { kinds: ["variable"], names: ["two"], exported: false },
            count: { min: 1, max: 1 },
          },
        ],
      },
    },
  );
  assert.deepEqual(check(context), []);
});

await test("shape counts reject missing declarations and excess selected declarations", (t) => {
  const context = fixture(
    t,
    { "src/main.ts": "export function first() {} export function second() {}" },
    shape({ kinds: ["function"], exported: true, topLevel: true }, { min: 1, max: 1 }),
  );
  assert.match(firstOf(context).message, /matched 2 declarations/);
  writeFileSync(join(context.root, "src/main.ts"), "export const value = 1;");
  assert.match(firstOf(context).message, /matched 0 declarations/);
  nodeOf(context).count = { max: 0 };
  assert.deepEqual(check(context), []);
});

await test("nested declarations cannot satisfy a top-level positive requirement", (t) => {
  const context = fixture(
    t,
    { "src/main.ts": "export function outer() { function needed() {} }" },
    shape({ kinds: ["function"], names: ["needed"], topLevel: true }, { min: 1 }),
  );
  assert.equal(firstOf(context).rule, "conventions.nodes");
  nodeOf(context).select.topLevel = false;
  assert.deepEqual(check(context), []);
});
