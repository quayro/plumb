import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { at } from "../../../src/schema.ts";
import { mapped, parseJson } from "../../../test/support.ts";
import { Analysis, check, snapshot } from "../src/index.ts";
import {
  fixture,
  packageProject,
  registration,
  registrationSources,
  rules,
} from "./semantic-support.ts";

await test("a written-once pattern that finds no values is incomplete", (t) => {
  const context = fixture(
    t,
    { "src/paths.ts": "export const paths = {};" },
    { contracts: { writtenOnce: [{ table: "src/paths.ts", values: "^/.", files: ["src/**"] }] } },
  );
  assert.equal(check(context)[0].status, "incomplete");
});

await test("root-project unique exports cover destructuring and renamed reexports", (t) => {
  const context = fixture(
    t,
    {
      "src/a.ts": "export const { shared } = { shared: 1 }; export const original = 2;",
      "src/b.ts": 'export { original as shared } from "./a";',
      "src/c.ts": 'export { original } from "./a";',
    },
    { projects: [{ root: ".", profile: "typescript", uniqueExports: ["src"] }] },
  );
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, "exports.unique");
  assert.equal(diagnostics[0].path, "src/b.ts");
});

await test("overloads and same-file type/value merges have one unique-export owner", (t) => {
  const context = fixture(
    t,
    {
      "src/a.ts":
        "export function read(a: string): string; export function read(a: unknown): unknown { return a; } export interface Value { a: 1 } export const Value = 1;",
    },
    { projects: [{ root: ".", profile: "typescript", uniqueExports: ["src"] }] },
  );
  assert.deepEqual(check(context), []);
});

await test("registration contracts resolve aliases and count one direct lexical composition call", (t) => {
  const context = fixture(t, registrationSources, { contracts: { registrations: [registration] } });
  assert.deepEqual(check(context), []);
});

await test("generator and accessor registration bodies are refused", (t) => {
  const context = fixture(
    t,
    {
      ...registrationSources,
      "src/jobs.ts":
        'import { register } from "./registry"; export function* billingRegisterJobs() { register("sweep"); } export const otherRegisterJobs = () => { class Box { get value() { register("late"); return 1; } } return Box; };',
    },
    { contracts: { registrations: [registration] } },
  );
  assert.ok(rules(check(context), "contracts.registrations").length >= 2);
});

await test("conditional, duplicate and outside registrar calls are refused", (t) => {
  const context = fixture(
    t,
    {
      ...registrationSources,
      "src/composition.ts":
        'import { billingRegisterJobs as jobs } from "./jobs"; export const compose = (): void => { if (true) jobs(); jobs(); jobs(); }; jobs();',
    },
    { contracts: { registrations: [registration] } },
  );
  assert.equal(rules(check(context), "contracts.registrations").length, 3);
});

await test("surface proposals support shorthand exports and do not write their own baseline", (t) => {
  const context = fixture(
    t,
    {
      "package.json": JSON.stringify({ exports: "./src/index.ts" }),
      "src/index.ts": "export const Widget = 1; export interface WidgetProps { size: number }",
    },
    { projects: [packageProject] },
  );
  const [proposal] = snapshot(context);
  assert.equal(proposal.path, "api.surface.json");
  assert.deepEqual(JSON.parse(proposal.content), {
    schemaVersion: 1,
    exports: { ".": ["Widget", "WidgetProps (type)"] },
  });
  assert.equal(existsSync(join(context.root, "api.surface.json")), false);
  assert.equal(rules(check(context), "exports.surface").length, 1);
  writeFileSync(join(context.root, "api.surface.json"), proposal.content);
  context.files.push("api.surface.json");
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "src/index.ts"), "export const Widget = 1;");
  const fixing = { ...context, mode: "fix" };
  assert.equal(rules(check(fixing), "exports.surface").length, 1);
  assert.equal(readFileSync(join(context.root, "api.surface.json"), "utf8"), proposal.content);
});

await test("surfaces pin nested conditions separately and include JavaScript exports", (t) => {
  const context = fixture(
    t,
    {
      "package.json": JSON.stringify({
        exports: {
          ".": {
            import: { types: "./src/types.ts", default: "./src/index.js" },
            require: "./src/index.cjs",
          },
        },
      }),
      "src/types.ts": "export interface Widget { size: number }",
      "src/index.js": "export const Widget = 1;",
      "src/index.cjs": "exports.Widget = 1;",
    },
    { projects: [packageProject] },
  );
  const exported = at(parseJson(snapshot(context)[0].content), "exports");
  assert.deepEqual(at(exported, ". [import/types]"), ["Widget (type)"]);
  assert.deepEqual(at(exported, ". [import/default]"), ["Widget"]);
  assert.ok(mapped(at(exported, ". [require]"), String).includes("Widget"));
});

await test("surface wildcard expansion uses the supplied inventory", (t) => {
  const context = fixture(
    t,
    {
      "package.json": JSON.stringify({ exports: { "./*": "./src/*.ts" } }),
      "src/one.ts": "export const one = 1;",
      "src/two.ts": "export const two = 2;",
    },
    { projects: [packageProject] },
  );
  assert.deepEqual(at(parseJson(snapshot(context)[0].content), "exports"), {
    "./one": ["one"],
    "./two": ["two"],
  });
});

await test("type-only named and star reexports retain their type-only surface category", (t) => {
  const context = fixture(
    t,
    {
      "package.json": JSON.stringify({ exports: "./src/index.ts" }),
      "src/index.ts": 'export type { Widget } from "./widget"; export type * from "./other";',
      "src/widget.ts": "export class Widget {}",
      "src/other.ts": "export class Other {}",
    },
    { projects: [packageProject] },
  );
  assert.deepEqual(at(parseJson(snapshot(context)[0].content), "exports", "."), [
    "Other (type)",
    "Widget (type)",
  ]);
});

await test("type-only export categories survive transitive star barrels", (t) => {
  const context = fixture(
    t,
    {
      "package.json": JSON.stringify({ exports: "./src/index.ts" }),
      "src/index.ts": 'export * from "./types"; export * from "./values";',
      "src/types.ts": 'export type * from "./widget";',
      "src/widget.ts": "export class Widget {}",
      "src/values.ts": 'export * from "./index"; export const value = 1;',
    },
    { projects: [packageProject] },
  );
  assert.deepEqual(at(parseJson(snapshot(context)[0].content), "exports", "."), [
    "Widget (type)",
    "value",
  ]);
});

await test("missing surface config, export target or local reexport is incomplete", (t) => {
  const context = fixture(
    t,
    {
      "package.json": JSON.stringify({ exports: "./src/index.ts" }),
      "src/index.ts": 'export * from "./missing";',
    },
    { projects: [packageProject] },
  );
  assert.equal(check(context)[0].status, "incomplete");
  rmSync(join(context.root, "tsconfig.json"));
  assert.equal(check(context)[0].status, "incomplete");
  assert.throws(() => snapshot(context));
});

await test("an unresolved external reexport cannot become an empty successful API snapshot", (t) => {
  const context = fixture(
    t,
    {
      "package.json": JSON.stringify({ exports: "./src/index.ts" }),
      "src/index.ts": 'export * from "missing-package";',
    },
    { projects: [packageProject] },
  );
  assert.equal(check(context)[0].status, "incomplete");
  assert.throws(() => snapshot(context), /could not be resolved/);
});

await test("the snapshot API cannot propose overwriting source or another project's files", (t) => {
  const context = fixture(
    t,
    {
      "package.json": JSON.stringify({ exports: "./src/index.ts" }),
      "src/index.ts": "export const value = 1;",
    },
    { projects: [{ ...packageProject, surface: { snapshot: "src/index.ts" } }] },
  );
  assert.throws(() => snapshot(context), /surface\.json/);
  const [project] = context.config.projects;
  assert.ok(project?.surface);
  project.surface.snapshot = "../other.surface.json";
  assert.throws(() => snapshot(context));
  assert.equal(readFileSync(join(context.root, "src/index.ts"), "utf8"), "export const value = 1;");
});

await test("focused and skipped test markers include import aliases, options and chained each calls", (t) => {
  const context = fixture(
    t,
    {
      "src/example.test.ts":
        'import { test as check } from "node:test"; check("one", { only: true }, () => {}); describe.only.each([1])("set", () => {}); test.skip("pending", () => {}); test("normal", { skip: false }, () => {});',
    },
    { preset: "ozmikhail" },
  );
  const diagnostics = check(context);
  assert.equal(rules(diagnostics, "tests.focused").length, 2);
  assert.equal(rules(diagnostics, "tests.skipped").length, 1);
});

await test("normal tests pass and malformed source fails incomplete", (t) => {
  const context = fixture(
    t,
    { "src/example.test.ts": 'import { test } from "node:test"; test("all", () => {});' },
    { preset: "ozmikhail" },
  );
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "src/example.test.ts"), "export const broken = ;");
  assert.equal(check(context)[0].status, "incomplete");
});

await test("Node test contexts are checked and data in test folders is not parsed as source", (t) => {
  const context = fixture(
    t,
    {
      "tests/sample.mjs":
        'import test from "node:test"; test("outer", (context) => context.test("inner", { skip: true }, () => {}));',
      "tests/data.json": '{"word":"test.only"}',
    },
    { preset: "ozmikhail" },
  );
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, "tests.skipped");
});

await test("one Analysis reuses source and compiler programs without changing check behavior", (t) => {
  const context = fixture(t, registrationSources, { contracts: { registrations: [registration] } });
  const analysis = new Analysis(context);
  assert.equal(analysis.source("src/jobs.ts"), analysis.source("./src/jobs.ts"));
  assert.equal(analysis.program("src/composition.ts"), analysis.program("src/composition.ts"));
  assert.deepEqual(check(context, analysis), []);
});

await test("the semantic runtime loads from a vendored plumb folder linked as a workspace", (t) => {
  const context = fixture(t, {});
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  const vendored = join(context.root, "tools", "plumb");
  // the consumer copies the whole tree; Node strips types because the real path is outside node_modules
  cpSync(source, vendored, {
    recursive: true,
    filter: (path) =>
      !["node_modules", "test", ".git"].some((part) =>
        relative(source, path).split(/[\\/]/).includes(part),
      ),
  });
  mkdirSync(join(context.root, "node_modules", "@quayro"), { recursive: true });
  const installed = join(context.root, "node_modules", "@quayro", "plumb-javascript");
  symlinkSync(
    join(vendored, "packages", "javascript"),
    installed,
    process.platform === "win32" ? "junction" : "dir",
  );
  const require = createRequire(import.meta.url);
  const typescript = dirname(require.resolve("typescript/package.json"));
  symlinkSync(
    typescript,
    join(context.root, "node_modules", "typescript"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const entry = pathToFileURL(join(installed, "src", "index.ts")).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { check } = await import(${JSON.stringify(entry)}); process.stdout.write(typeof check);`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(output, "function");
});

await test("x and f prefixed tests, runIf, and skip calls on the test context or this are refused", (t) => {
  const bad = {
    "src/a.test.ts":
      'import { test, describe, it } from "node:test"; xit("a", () => {}); fdescribe("b", () => {}); ftest("c", () => {}); test.runIf(false)("d", () => {});',
  };
  const focused = check(fixture(t, bad, { preset: "ozmikhail" }));
  assert.equal(rules(focused, "tests.focused").length, 2);
  assert.equal(rules(focused, "tests.skipped").length, 2);
  for (const body of [
    'test("e", (t) => { t.skip(); });',
    'test("f", function () { this.skip(); });',
    'test("g", (ctx) => { ctx.todo("later"); });',
    'test("h", (t) => t.test("i", (u) => u.skip()));',
  ]) {
    const context = fixture(
      t,
      { "src/b.test.ts": `import { test } from "node:test"; ${body}` },
      { preset: "ozmikhail" },
    );
    assert.equal(rules(check(context), "tests.skipped").length >= 1, true, body);
  }
  const clean = fixture(
    t,
    {
      "src/c.test.ts":
        'import { test } from "node:test"; test("ok", (t) => { t.assert.ok(true); }); test("skipped by option", { skip: false }, () => {});',
    },
    { preset: "ozmikhail" },
  );
  assert.deepEqual(check(clean), []);
});
