import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { at } from "../../../src/schema.ts";
import { parseJson, setAt } from "../../../test/support.ts";
import { surfaceSnapshotIsValid } from "../src/exports.ts";
import { check } from "../src/index.ts";
import { changed, declarations, fixture } from "./signatures-support.ts";

await test("unresolved, invalid, excluded or any public type evidence is incomplete rather than an accepted snapshot", (t) => {
  for (const text of [
    "export type Broken = Missing;",
    "export function broken(value: number): string { return value; }",
    "export function unsafe(value: any): any { return value; }",
    'export type { Missing } from "missing-provider";',
  ]) {
    const project = fixture(t, { "src/index.ts": text });
    assert.throws(project.proposal);
    assert.ok(check(project.context).some((item) => item.status === "incomplete"));
    assert.equal(existsSync(join(project.root, "api.surface.json")), false);
  }
  const excluded = fixture(t, {
    "src/index.ts": 'export type { Value } from "./hidden.js";',
    "src/hidden.ts": "export interface Value { size: number; }",
  });
  excluded.context.files = excluded.context.files.filter((file) => file !== "src/hidden.ts");
  assert.throws(excluded.proposal, /inventory/);
});

await test("interpretation options are bound even when the emitted optional property stays the same", (t) => {
  const project = fixture(t, { "src/index.ts": "export interface Value { name?: string; }" });
  project.accept();
  project.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
        strict: true,
        types: [],
        exactOptionalPropertyTypes: true,
      },
      include: ["src/**/*"],
    }),
  );
  changed(project.context);
  assert.equal(at(project.value(), "compiler", "options", "exactOptionalPropertyTypes"), true);
});

await test("v1 remains name-only, v2 requires explicit migration, and fix never updates either contract", (t) => {
  const project = fixture(
    t,
    { "src/index.ts": "export function value(input: number): number { return input; }" },
    { signatures: false },
  );
  const before = project.accept();
  assert.equal(at(parseJson(before), "schemaVersion"), 1);
  project.write("src/index.ts", "export function value(input: string): string { return input; }");
  assert.deepEqual(check(project.context), []);
  const [entry] = project.context.config.projects;
  assert.ok(entry?.surface);
  entry.surface.signatures = true;
  assert.ok(
    check(project.context).some(
      (item) => item.status === "incomplete" && /schemaVersion 2/.test(item.message),
    ),
  );
  assert.equal(readFileSync(join(project.root, "api.surface.json"), "utf8"), before);
  const approved = project.accept();
  assert.equal(at(parseJson(approved), "schemaVersion"), 2);
  project.write("src/index.ts", "export function value(input: number): number { return input; }");
  changed({ ...project.context, mode: "fix" });
  assert.equal(readFileSync(join(project.root, "api.surface.json"), "utf8"), approved);
});

await test("snapshot ownership validation rejects malformed or disconnected signature evidence", (t) => {
  const valid = fixture(t, { "src/index.ts": "export const value: number = 1;" }).value();
  assert.equal(surfaceSnapshotIsValid(valid), true);
  for (const mutate of [
    (value: unknown) => {
      setAt(value, ["extra"], true);
    },
    (value: unknown) => {
      setAt(value, ["routing"], "invalid JSON");
    },
    (value: unknown) => {
      setAt(value, ["targets", ".", "module"], "./missing.ts");
    },
    (value: unknown) => {
      setAt(value, ["targets", ".", "priority"], [-1]);
    },
    (value: unknown) => {
      setAt(value, ["compiler", "libraries"], "not-a-hash");
    },
    (value: unknown) => {
      setAt(value, ["signatures", "./src/index.ts", "references", "missing"], "./missing.ts");
    },
    (value: unknown) => {
      setAt(value, ["signatures", "./src/index.ts", "declaration"], null);
    },
  ]) {
    const value = structuredClone(valid);
    mutate(value);
    assert.equal(surfaceSnapshotIsValid(value), false);
  }
});

await test("blocked and non-script condition changes remain observable when script targets are identical", (t) => {
  const project = fixture(
    t,
    { "src/index.ts": "export const value: number = 1;" },
    { exports: { node: null, default: "./src/index.ts" } },
  );
  project.accept();
  project.write(
    "package.json",
    JSON.stringify({
      name: "signature-fixture",
      version: "1.0.0",
      type: "module",
      exports: { browser: null, default: "./src/index.ts" },
    }),
  );
  changed(project.context);
  assert.equal(at(parseJson(String(at(project.value(), "routing"))), "browser"), null);
});

await test("an entry's own ambient globals remain part of the contract even when no exported type names them", (t) => {
  const source = (type: string): string => `export const value: number = 1;
    declare global {
      interface PublicGlobal { field: ${type}; next?: PublicGlobal; }
      namespace PublicNamespace { const version: 1; interface Options { field: ${type}; } }
    }
  `;
  const project = fixture(t, { "src/index.ts": source("string") });
  const value = project.value(),
    text = declarations(value);
  assert.match(text, /declare global/);
  assert.match(text, /interface PublicGlobal/);
  assert.match(text, /namespace PublicNamespace/);
  assert.match(text, /version: 1/);
  assert.match(text, /field: string/);
  project.accept();
  assert.deepEqual(check(project.context), []);
  project.write("src/index.ts", source("number"));
  changed(project.context);
});

await test("ambient effects in cyclic bare-import modules are retained with finite traversal", (t) => {
  const source = (type: string): string =>
    `import "./index.js"; export {}; declare global { interface CycleAmbient { field: ${type}; } }`;
  const project = fixture(t, {
    "src/index.ts": 'import "./ambient.js"; export const value: number = 1;',
    "src/ambient.ts": source("string"),
  });
  const value = project.value();
  assert.match(String(at(value, "signatures", "./src/ambient.ts", "declaration")), /CycleAmbient/);
  assert.match(declarations(value), /field: string/);
  project.accept();
  project.write("src/ambient.ts", source("number"));
  changed(project.context);
});

await test("triple-slash ambient dependencies are explicitly incomplete even if declaration emit removes their directives", (t) => {
  for (const directive of [
    '/// <reference path="./ambient.d.ts" />',
    '/// <reference types="ambient-provider" />',
    '/// <reference lib="es2022" />',
  ]) {
    const project = fixture(t, {
      "src/index.ts": `${directive}\nexport const value: number = 1;`,
      "src/ambient.d.ts": "interface AmbientPublic { field: string; }",
      "node_modules/@types/ambient-provider/package.json": JSON.stringify({
        name: "@types/ambient-provider",
        version: "1.0.0",
        types: "index.d.ts",
      }),
      "node_modules/@types/ambient-provider/index.d.ts":
        "interface ProviderAmbient { field: string; }",
    });
    assert.throws(project.proposal, /reference directives/);
    assert.ok(
      check(project.context).some(
        (item) => item.status === "incomplete" && /reference directives/.test(item.message),
      ),
    );
    assert.equal(existsSync(join(project.root, "api.surface.json")), false);
  }
});
