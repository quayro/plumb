import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import ts from "typescript";

import { canonical } from "../../../src/files.ts";
import { at } from "../../../src/schema.ts";
import { mapped } from "../../../test/support.ts";
import { surfaceSnapshotIsValid } from "../src/exports.ts";
import { check } from "../src/index.ts";
import { changed, declarations, fixture, tree } from "./signatures-support.ts";

await test("real declaration emission retains overloads, generics, public/protected members and full large types without writing", (t) => {
  const fields = Array.from({ length: 80 }, (_, index) => `field${index}: string;`).join("\n");
  const project = fixture(t, {
    "src/index.ts": `
    export interface Options<T extends string | number = string> { readonly value: T; label?: string; }
    export interface Large { ${fields} }
    export function parse(value: string): string;
    export function parse(value: number): number;
    export function parse(value: string | number): string | number { return value; }
    export class Store<T extends string | number = string> {
      private secret = 0;
      constructor(public readonly key: string) {}
      protected narrow(value: T): T { this.secret++; return value; }
      read(value: T): Options<T> { return { value: this.narrow(value) }; }
    }
  `,
  });
  const before = tree(project.root),
    value = project.value(),
    text = declarations(value);
  assert.equal(at(value, "schemaVersion"), 2);
  assert.equal(at(value, "compiler", "typescript"), ts.version);
  assert.equal(surfaceSnapshotIsValid(value), true);
  assert.match(text, /parse\(value: string\): string/);
  assert.match(text, /parse\(value: number\): number/);
  assert.ok(text.indexOf("parse(value: string)") < text.indexOf("parse(value: number)"));
  assert.match(text, /extends string \| number = string/);
  assert.match(text, /readonly value: T/);
  assert.match(text, /label\?: string/);
  assert.match(text, /protected narrow\(value: T\): T/);
  assert.match(text, /constructor\(key: string\)/);
  assert.match(text, /field79: string/);
  assert.doesNotMatch(text, /secret|this\.|return value|\.\.\. \d+ more/);
  assert.match(text, /#__plumb_private/);
  assert.deepEqual(tree(project.root), before);
  assert.equal(existsSync(join(project.root, "api.surface.json")), false);
  assert.equal(existsSync(join(project.root, ".plumb-signature-output")), false);
});

await test("same export names with changed parameter, return or member types refuse the approved signature snapshot", (t) => {
  const project = fixture(t, {
    "src/index.ts":
      "export interface Options { readonly name: string; }\nexport function read(value: Options): string { return value.name; }\n",
  });
  project.accept();
  assert.deepEqual(check(project.context), []);
  project.write(
    "src/index.ts",
    "export interface Options { readonly name: number; }\nexport function read(value: Options): number { return value.name; }\n",
  );
  changed(project.context);
  project.accept();
  assert.deepEqual(check(project.context), []);
});

await test("implementation edits, private detail and unrelated dependency exports do not change signatures", (t) => {
  const project = fixture(t, {
    "src/index.ts":
      'export { Store } from "./store.js"; export type { Public as Options } from "./types.js";',
    "src/store.ts":
      'export class Store { private hidden(): string { return "before"; } value(): number { return this.hidden().length; } }',
    "src/types.ts":
      "export interface Public { name: string; } export function internal(value: number): number { return value; }",
  });
  const before = project.value();
  assert.doesNotMatch(declarations(before), /internal|hidden|before/);
  project.write(
    "src/store.ts",
    'export class Store { private renamed(): string { return "different implementation"; } value(): number { return this.renamed().length + 1; } }',
  );
  project.write(
    "src/types.ts",
    "export interface Public { name: string; } export function internal(value: string): string { return value; }",
  );
  assert.equal(canonical(project.value()), canonical(before));
});

await test("reachable transitive types, renamed reexports and namespace public types are retained", (t) => {
  const project = fixture(t, {
    "src/index.ts":
      'export { identity as select } from "./entry.js"; export * as model from "./model.js";',
    "src/entry.ts":
      'import type { Public } from "./model.js"; export function identity<T extends Public>(value: T): T { return value; }',
    "src/model.ts":
      'import type { Detail } from "./detail.js"; export interface Public { readonly detail: Detail; }',
    "src/detail.ts":
      "export interface Detail { size: number; } export interface Unrelated { hidden: boolean; }",
  });
  const value = project.value(),
    text = declarations(value);
  assert.ok(mapped(at(value, "exports", "."), String).includes("select"));
  assert.ok(mapped(at(value, "exports", "."), String).includes("model"));
  assert.match(text, /Detail/);
  assert.match(text, /size: number/);
  assert.doesNotMatch(text, /Unrelated|hidden: boolean/);
  assert.ok(at(value, "signatures", "./src/detail.ts"));
  project.accept();
  project.write(
    "src/detail.ts",
    "export interface Detail { size: string; } export interface Unrelated { hidden: boolean; }",
  );
  changed(project.context);
});

await test("dependency declarations are resolved, scoped and bound without exposing install paths", (t) => {
  const project = fixture(t, {
    "src/index.ts": 'export type { Public } from "provider";',
    "node_modules/provider/package.json": JSON.stringify({
      name: "provider",
      version: "1.0.0",
      types: "index.d.ts",
    }),
    "node_modules/provider/index.d.ts":
      "export interface Public { value: string; } export interface Hidden { internal: boolean; }",
  });
  const before = project.value(),
    text = declarations(before);
  assert.ok(at(before, "signatures", "package:provider@1.0.0/index.d.ts"));
  assert.match(text, /value: string/);
  assert.doesNotMatch(text, /Hidden|internal/);
  assert.ok(!JSON.stringify(before).includes(project.root));
  project.write(
    "node_modules/provider/index.d.ts",
    "export interface Public { value: string; } export interface Hidden { internal: number; }",
  );
  assert.equal(canonical(project.value()), canonical(before));
  project.accept();
  project.write(
    "node_modules/provider/index.d.ts",
    "export interface Public { value: number; } export interface Hidden { internal: number; }",
  );
  changed(project.context);
});

await test("conditional targets and their precedence are distinct parts of the signature contract", (t) => {
  const map = { ".": { types: "./src/types.d.ts", default: "./src/index.ts" } };
  const project = fixture(
    t,
    {
      "src/index.ts": "export const value: number = 1;",
      "src/types.d.ts": "export declare const value: number;",
    },
    { exports: map },
  );
  const value = project.value();
  assert.equal(at(value, "targets", ". [types]", "module"), "./src/types.d.ts");
  assert.equal(at(value, "targets", ". [default]", "module"), "./src/index.ts");
  assert.notDeepEqual(
    at(value, "targets", ". [types]", "priority"),
    at(value, "targets", ". [default]", "priority"),
  );
  project.accept();
  project.write(
    "package.json",
    JSON.stringify({
      name: "signature-fixture",
      version: "1.0.0",
      type: "module",
      exports: { ".": { default: "./src/index.ts", types: "./src/types.d.ts" } },
    }),
  );
  changed(project.context);
});

await test("signature output is stable across checkout locations and nested project roots", (t) => {
  const files = { "src/index.ts": "export function identity<T>(value: T): T { return value; }" };
  const first = fixture(t, files),
    second = fixture(t, files, { root: "a" });
  assert.equal(canonical(first.value()), canonical(second.value()));
  assert.equal(second.proposal().path, "a/api.surface.json");
});

await test("typed JavaScript and declaration-only entries produce real declaration contracts", (t) => {
  const javascript = fixture(
    t,
    {
      "src/index.js":
        "/** @param {string} value @returns {number} */\nexport function size(value) { return value.length; }",
    },
    { exports: "./src/index.js", compiler: { allowJs: true } },
  );
  assert.match(declarations(javascript.value()), /size\(value: string\): number/);
  const declaration = fixture(
    t,
    { "src/index.d.ts": "export interface Value { readonly size: number; }" },
    { exports: "./src/index.d.ts" },
  );
  assert.match(declarations(declaration.value()), /readonly size: number/);
});
