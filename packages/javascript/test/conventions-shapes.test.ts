import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { ReadOptions } from "../../../src/context.ts";
import { asError, errorCode } from "../../../src/errors.ts";
import { check, compiler, firstOf, fixture, handler, shape, typed } from "./conventions-support.ts";

await test("unsupported computed declaration names and invalid syntax are incomplete", (t) => {
  const context = fixture(
    t,
    { "src/main.ts": "export class Source { [Symbol.iterator]() {} }" },
    shape({ kinds: ["method"], names: ["execute"] }, { min: 1 }),
  );
  assert.match(firstOf(context).message, /computed declaration name/);
  writeFileSync(join(context.root, "src/main.ts"), "export function {");
  assert.ok(
    check(context).every((item) => item.status === "incomplete" && item.suppressible === false),
  );
});

await test("JavaScript-only role semantics explicitly refuse non-JavaScript source", (t) => {
  const context = fixture(t, { "src/main.py": "value = 1\n" }, { exports: { allow: [] } });
  assert.match(firstOf(context).message, /JS\/TS source/);
  assert.equal(firstOf(context).status, "incomplete");
});

await test("typed export contracts use actual strict compiler assignability", (t) => {
  const context = fixture(
    t,
    {
      "src/main.ts": "export const run = (value: number): string => String(value);",
      "contracts.ts": handler,
    },
    typed,
  );
  assert.deepEqual(check(context), []);
  writeFileSync(
    join(context.root, "src/main.ts"),
    "export const run = (value: number): number => value;",
  );
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, "conventions.types");
  assert.match(diagnostics[0].message, /not assignable to Handler/);
});

await test("typed structural objects and aliased value exports can satisfy a declared interface", (t) => {
  const context = fixture(
    t,
    {
      "src/main.ts":
        "const implementation = { execute(value: number): string { return String(value); } }; export { implementation as run };",
      "contracts.ts": "export interface Handler { execute(value: number): string }",
    },
    typed,
  );
  assert.deepEqual(check(context), []);
});

await test("missing and type-only value exports are ordinary contract violations", (t) => {
  const context = fixture(
    t,
    { "src/main.ts": "export const other = 1;", "contracts.ts": handler },
    typed,
  );
  assert.equal(firstOf(context).rule, "conventions.types");
  assert.match(firstOf(context).message, /value export run is missing/);
  writeFileSync(join(context.root, "src/main.ts"), "export type run = (value: number) => string;");
  assert.match(firstOf(context).message, /type-only export/);
});

await test("any, unknown, never and uninstantiated generic exports cannot prove typed contracts", (t) => {
  for (const source of [
    "export const run: any = 1;",
    "export const run: unknown = 1;",
    "export const run = null as never;",
    "export function run<T>(value: T): T { return value; }",
  ]) {
    const context = fixture(t, { "src/main.ts": source, "contracts.ts": handler }, typed);
    const diagnostics = check(context);
    assert.ok(
      diagnostics.some(
        (item) => item.rule === "conventions.analysis" && item.status === "incomplete",
      ),
      source,
    );
  }
  const nested = fixture(
    t,
    {
      "src/main.ts": "export const run = { execute: null as any };",
      "contracts.ts": "export interface Handler { execute(value: number): string }",
    },
    typed,
  );
  assert.match(check(nested)[0].message, /unsafe or unevaluated type/);
});

await test("missing contract symbols, compiler errors and weakened compiler settings are incomplete", (t) => {
  const context = fixture(
    t,
    {
      "src/main.ts": "export const run = (value: number): string => String(value);",
      "contracts.ts": "export interface Other { value: string }",
    },
    typed,
  );
  assert.match(firstOf(context).message, /must be an exported declared type/);
  writeFileSync(join(context.root, "contracts.ts"), handler);
  writeFileSync(
    join(context.root, "src/main.ts"),
    'import "./missing.js"; export const run = (value: number): string => String(value);',
  );
  assert.match(firstOf(context).message, /compiler errors/);
  writeFileSync(
    join(context.root, "src/main.ts"),
    "export const run = (value: number): string => String(value);",
  );
  writeFileSync(
    join(context.root, "tsconfig.json"),
    JSON.stringify({
      ...compiler,
      compilerOptions: { ...compiler.compilerOptions, strictNullChecks: false },
    }),
  );
  assert.match(firstOf(context).message, /strictNullChecks conflicts/);
});

await test("a typed contract cannot add excluded or unconfigured source to its Program", (t) => {
  const context = fixture(
    t,
    {
      "src/main.ts": "export const run = (value: number): string => String(value);",
      "contracts.ts": handler,
    },
    typed,
  );
  writeFileSync(
    join(context.root, "tsconfig.json"),
    JSON.stringify({ ...compiler, files: ["contracts.ts"] }),
  );
  assert.match(firstOf(context).message, /must include both/);
  writeFileSync(join(context.root, "tsconfig.json"), JSON.stringify(compiler));
  context.files = context.files.filter((path) => path !== "contracts.ts");
  assert.ok(
    check(context).some(
      (item) =>
        item.status === "incomplete" && /absent from the checked inventory/.test(item.message),
    ),
  );
});

await test("compiler-backed shape evidence must match the shared observed source", (t) => {
  const context = fixture(
    t,
    { "src/main.ts": "export function implementation() {}" },
    shape({ kinds: ["function"], exported: true }, { min: 1 }),
  );
  const actual = context.read;
  context.readCompilerInput = (path: string, { allowMissing = false }: ReadOptions = {}) => {
    try {
      return actual(path);
    } catch (error) {
      if (allowMissing && errorCode(error) === "ENOENT") {
        return null;
      }
      throw asError(error);
    }
  };
  context.read = (path) => (path === "src/main.ts" ? "export function altered() {}" : actual(path));
  assert.match(firstOf(context).message, /different source text/);
});
