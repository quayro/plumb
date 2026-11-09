import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Analysis, check } from "../src/index.ts";
import { catalogue, compiler, fixture, graph, lazy, rules } from "./semantic-support.ts";

await test("root graph follows .js-to-.ts, JS index and tsconfig aliases through one resolver", (t) => {
  const context = fixture(
    t,
    {
      "entry.ts": 'import "./src/runtime.js";',
      "src/runtime.ts": 'import "../lib"; import "@app/component";',
      "lib/index.js": 'import "forbidden";',
      "src/component.tsx": "export const Widget = 1;",
    },
    { contracts: { importGraphs: [graph] } },
  );
  const diagnostics = check(context);
  assert.equal(rules(diagnostics, "javascript.analysis").length, 0, JSON.stringify(diagnostics));
  assert.equal(rules(diagnostics, "contracts.import-graphs").length, 2);
  assert.ok(diagnostics.some((item) => item.message.includes("forbidden")));
  assert.ok(diagnostics.some((item) => item.path === "src/component.tsx"));
});

await test("single-character nested projects use their own compiler configuration", (t) => {
  const context = fixture(
    t,
    {
      "src/local.ts": "export const from = 'root';",
      "a/entry.ts": 'import "@app/local";',
      "a/src/local.ts": "export const from = 'nested';",
      "a/tsconfig.json": compiler,
    },
    {
      projects: [
        { root: ".", profile: "typescript" },
        { root: "a", profile: "typescript" },
      ],
    },
  );
  assert.equal(new Analysis(context).target("a/entry.ts", "@app/local"), "a/src/local.ts");
  context.config.projects.reverse();
  assert.equal(new Analysis(context).target("a/entry.ts", "@app/local"), "a/src/local.ts");
});

await test("validated project references reach compiler programs and their cache identity", (t) => {
  const context = fixture(t, {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
      files: ["entry.ts"],
      references: [{ path: "./lib" }],
    }),
    "entry.ts": "export const entry = 1;",
    "lib/tsconfig.json": JSON.stringify({
      compilerOptions: { composite: true },
      files: ["source.ts"],
    }),
    "lib/source.ts": "export const value = 1;",
  });
  const analysis = new Analysis(context);
  const parsed = analysis.compilerConfig("tsconfig.json");
  assert.ok(analysis.configs.has("lib/tsconfig.json"));
  const program = analysis.program(
    "entry.ts",
    [],
    parsed.options,
    parsed.fileNames,
    parsed.projectReferences,
  );
  assert.deepEqual(program.getProjectReferences(), parsed.projectReferences);
  assert.equal(
    program,
    analysis.program("entry.ts", [], parsed.options, parsed.fileNames, parsed.projectReferences),
  );
  assert.notEqual(program, analysis.program("entry.ts", [], parsed.options, parsed.fileNames));
});

await test("missing, cyclic and escaping reference configurations fail closed", (t) => {
  const config = (reference: string): string =>
    JSON.stringify({ files: ["entry.ts"], references: [{ path: reference }] });
  const context = fixture(t, {
    "tsconfig.json": config("./lib"),
    "entry.ts": "export const entry = 1;",
    "lib/entry.ts": "export const value = 1;",
  });
  assert.throws(() => new Analysis(context).compilerConfig("tsconfig.json"), /lib/);
  writeFileSync(join(context.root, "lib/tsconfig.json"), config(".."));
  assert.throws(
    () => new Analysis(context).compilerConfig("tsconfig.json"),
    /references contain a cycle/,
  );
  writeFileSync(join(context.root, "lib/tsconfig.json"), config("../../outside"));
  assert.throws(
    () => new Analysis(context).compilerConfig("tsconfig.json"),
    /escapes the project root/,
  );
});

await test("recursive reference reads use the context path guard and input reader", (t) => {
  const context = fixture(t, {
    "tsconfig.json": JSON.stringify({ files: ["entry.ts"], references: [{ path: "./lib" }] }),
    "entry.ts": "export const entry = 1;",
    "lib/tsconfig.json": JSON.stringify({ files: ["source.ts"] }),
    "lib/source.ts": "export const value = 1;",
  });
  const read: string[] = [];
  context.read = (file: string) => {
    read.push(file);
    return readFileSync(join(context.root, file), "utf8");
  };
  new Analysis(context).compilerConfig("tsconfig.json");
  assert.deepEqual(read, ["tsconfig.json", "lib/tsconfig.json"]);
  context.safePath = (file: unknown) => {
    if (file === "lib/tsconfig.json") {
      throw new Error("blocked reference path");
    }
    return join(context.root, String(file));
  };
  assert.throws(
    () => new Analysis(context).compilerConfig("tsconfig.json"),
    /blocked reference path/,
  );
});

await test("unresolved local imports fail incomplete instead of disappearing from a graph", (t) => {
  const context = fixture(
    t,
    { "entry.ts": 'import "./missing";' },
    { contracts: { importGraphs: [graph] } },
  );
  const [diagnostic] = check(context);
  assert.equal(diagnostic.rule, "javascript.analysis");
  assert.equal(diagnostic.status, "incomplete");
  assert.equal(diagnostic.suppressible, false);
  assert.match(diagnostic.message, /Cannot resolve local dependency/);
});

await test("resolved aliases and absolute dependencies cannot escape the checked inventory", (t) => {
  const parent = fixture(
    t,
    {
      "outside.ts": 'import "forbidden";',
      "project/entry.ts": "export {};",
      "project/tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          paths: { "@outside": ["../outside.ts"] },
        },
      }),
    },
    {
      contracts: {
        importGraphs: [graph],
        boundaries: [
          {
            from: ["entry.ts"],
            deny: ["private/**"],
            reason: "entry cannot reach private modules",
          },
        ],
      },
    },
  );
  const context = {
    ...parent,
    root: join(parent.root, "project"),
    files: ["entry.ts", "tsconfig.json"],
  };
  for (const specifier of ["@outside", join(parent.root, "outside.ts").replaceAll("\\", "/")]) {
    writeFileSync(join(context.root, "entry.ts"), `import ${JSON.stringify(specifier)};`);
    const diagnostics = check(context);
    assert.equal(diagnostics.length, 2, JSON.stringify(diagnostics));
    assert.ok(
      diagnostics.every(
        (item) =>
          item.rule === "javascript.analysis" &&
          item.status === "incomplete" &&
          item.suppressible === false,
      ),
    );
    assert.ok(
      diagnostics.every((item) =>
        /escapes the checked root|leaves the checked root|Cannot resolve local dependency/.test(
          item.message,
        ),
      ),
    );
  }
});

await test("installed external dependencies remain outside local graph traversal", (t) => {
  const context = fixture(
    t,
    {
      "entry.ts": 'import "external";',
      "node_modules/external/index.d.ts": "export const value: number;",
    },
    { contracts: { importGraphs: [graph] } },
  );
  context.files = context.files.filter((file) => !file.startsWith("node_modules/"));
  assert.deepEqual(check(context), []);
});

await test("declaration files cannot hide a local runtime implementation from graph analysis", (t) => {
  const context = fixture(
    t,
    {
      "entry.ts": 'import "./src/runtime";',
      "src/runtime.d.ts": "export const value: number;",
      "src/runtime.js": 'import "forbidden"; export const value = 1;',
    },
    { contracts: { importGraphs: [graph] } },
  );
  assert.equal(rules(check(context), "contracts.import-graphs").length, 1);
  rmSync(join(context.root, "src/runtime.js"));
  context.files = context.files.filter((file) => file !== "src/runtime.js");
  assert.equal(check(context)[0].status, "incomplete");
});

await test("type-only declarations erase edges while inline type reexports keep their runtime edge", (t) => {
  const context = fixture(
    t,
    {
      "entry.ts": 'import type { T } from "./types"; export type { T } from "./types";',
      "types.tsx": "export interface T { value: string }",
    },
    { contracts: { importGraphs: [graph] } },
  );
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "entry.ts"), 'export { type T } from "./types";');
  assert.equal(rules(check(context), "contracts.import-graphs").length, 1);
});

await test("a typo in a contract entry glob or graph scope cannot pass with an empty selection", (t) => {
  const context = fixture(
    t,
    { "entry.ts": "export const entry = 1;" },
    {
      contracts: {
        importGraphs: [
          { ...graph, entries: ["gone/**"] },
          { ...graph, within: "missing" },
        ],
      },
    },
  );
  assert.equal(rules(check(context), "javascript.analysis").length, 2);
});

await test("boundary checks resolve aliases and check type imports", (t) => {
  const context = fixture(
    t,
    {
      "src/domain.ts":
        'import type { Hidden } from "@app/impl/private.js"; export type Value = Hidden;',
      "src/impl/private.ts": "export interface Hidden { value: string }",
    },
    {
      contracts: {
        boundaries: [
          { from: ["./src/domain.ts"], deny: ["src/impl/**"], reason: "domain owns the interface" },
        ],
      },
    },
  );
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, "contracts.boundaries");
  assert.match(diagnostics[0].message, /src\/impl\/private.ts/);
});

await test("boundaries refuse computed import paths and allow unrelated modules", (t) => {
  const context = fixture(
    t,
    { "src/domain.ts": 'export const read = () => import("node:fs");' },
    {
      contracts: {
        boundaries: [
          { from: ["src/**"], deny: ["react", "src/http/**"], reason: "domain stays independent" },
        ],
      },
    },
  );
  assert.deepEqual(check(context), []);
  writeFileSync(
    join(context.root, "src/domain.ts"),
    "const name = 'node:fs'; export const read = () => import(name);",
  );
  assert.equal(rules(check(context), "contracts.boundaries").length, 1);
});

await test("manifest coverage accepts literal templates, TSX and explicit type-only imports", (t) => {
  const context = fixture(
    t,
    {
      "src/catalogue.ts": "export const sources = [`./entry.ts`, './view.tsx'] as const;",
      "src/entry.ts":
        'import { view } from "./view"; import type { T } from "./unbuilt"; export {view};',
      "src/view.tsx": "export const view = 1;",
    },
    { contracts: { manifests: [catalogue] } },
  );
  assert.deepEqual(check(context), []);
});

await test("manifest coverage refuses omitted inline type reexports, duplicates and stale exemptions", (t) => {
  const context = fixture(
    t,
    {
      "src/catalogue.ts": 'export const sources = ["./entry.ts", "./entry.ts", "./missing.ts"];',
      "src/entry.ts": 'export { type View } from "./view";',
      "src/view.tsx": "export interface View { value: string }",
    },
    {
      contracts: {
        manifests: [{ ...catalogue, exempt: [{ path: "src/unused.ts", reason: "old exemption" }] }],
      },
    },
  );
  const diagnostics = check(context);
  assert.equal(rules(diagnostics, "javascript.analysis").length, 0);
  assert.equal(rules(diagnostics, "contracts.manifests").length, 4);
});

await test("nonliteral manifests and dynamic dependencies are refused", (t) => {
  const context = fixture(
    t,
    {
      "src/catalogue.ts": "export const sources = discover();",
      "src/entry.ts": "export const value = 1;",
    },
    { contracts: { manifests: [catalogue] } },
  );
  assert.equal(rules(check(context), "contracts.manifests").length, 1);
  writeFileSync(join(context.root, "src/catalogue.ts"), 'export const sources = ["./entry.ts"];');
  writeFileSync(
    join(context.root, "src/entry.ts"),
    "export const load = (name: string) => import(name);",
  );
  assert.equal(rules(check(context), "contracts.manifests").length, 1);
});

await test("lazy imports, template-literal catalogue and names agree", (t) => {
  const context = fixture(
    t,
    {
      "src/router.ts": "export const pages = [() => import(`./home-page`)];",
      "src/home-page.tsx": "export const Home = 1;",
      "scripts/pages.ts": "export const pages = [`src/home-page.tsx`];",
    },
    { contracts: { lazyModules: [lazy] } },
  );
  assert.deepEqual(check(context), []);
  writeFileSync(
    join(context.root, "scripts/pages.ts"),
    'export const pages = ["src/gone-page.tsx"];',
  );
  assert.equal(rules(check(context), "contracts.lazy-modules").length, 2);
});

await test("unresolved and computed lazy imports cannot silently produce empty coverage", (t) => {
  const context = fixture(
    t,
    {
      "src/router.ts": 'export const pages = [() => import("./missing")];',
      "scripts/pages.ts": "export const pages = [];",
    },
    { contracts: { lazyModules: [lazy] } },
  );
  assert.equal(check(context)[0].status, "incomplete");
  writeFileSync(
    join(context.root, "src/router.ts"),
    'const path = "./missing"; export const pages = [() => import(path)];',
  );
  assert.equal(rules(check(context), "contracts.lazy-modules").length, 1);
});

await test("written-once tables include template literals and ignore type positions", (t) => {
  const context = fixture(
    t,
    {
      "src/paths.ts": "export const paths = { pricing: `/pricing` };",
      "src/menu.ts": 'type Path = "/pricing"; export const link = "/pricing";',
      "src/menu.test.ts": 'export const expected = "/pricing";',
    },
    {
      contracts: {
        writtenOnce: [
          { table: "src/paths.ts", values: "^/.", files: ["src/**"], ignore: ["**/*.test.ts"] },
        ],
      },
    },
  );
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, "contracts.written-once");
  assert.equal(diagnostics[0].path, "src/menu.ts");
});
