import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { ESLint } from "eslint";

import { context as repositoryContext } from "../../../src/engine.ts";
import { createConfig, typedRuntime } from "../eslint/index.ts";
import { createModuleResolver } from "../shared/module-resolver.ts";
import { Analysis } from "../src/analysis.ts";
import { fixture } from "./typed-lint-support.ts";

await test("real typed lint refuses floating promises including void and custom thenables", async (t) => {
  const source =
    "export async function work(): Promise<number> { return 1; }\nwork();\nvoid work();\ninterface Pending { then(ok: () => void, bad: () => void): Pending }\ndeclare const pending: Pending;\npending;\n";
  const found = await fixture(t, { "src/main.ts": source }).lint();
  assert.equal(
    found.filter((item) => item.ruleId === "@typescript-eslint/no-floating-promises").length,
    3,
  );
  const correct = await fixture(t, {
    "src/main.ts":
      "async function work(): Promise<number> { return 1; }\nexport async function read(): Promise<number> { return await work(); }\n",
  }).lint();
  assert.ok(!correct.some((item) => item.ruleId === "@typescript-eslint/no-floating-promises"));
});

await test("real typed rules enforce promise context, unsafe values and complete union switches", async (t) => {
  const source =
    'declare const unsafe: any;\ndeclare function task(): Promise<void>;\nexport const value = unsafe.field;\nunsafe();\nexport function read(take: (n: number) => void): string { take(unsafe); if (task()) { return unsafe; } return "ok"; }\nexport function choice(value: "a" | "b"): number { switch (value) { case "a": return 1; default: return 0; } }\nexport async function wait(): Promise<void> { await 1; }\n';
  const found = new Set(
    (await fixture(t, { "src/main.ts": source }).lint()).map((item) => item.ruleId),
  );
  for (const rule of [
    "no-misused-promises",
    "no-unsafe-argument",
    "no-unsafe-assignment",
    "no-unsafe-call",
    "no-unsafe-member-access",
    "no-unsafe-return",
    "switch-exhaustiveness-check",
    "await-thenable",
  ]) {
    assert.ok(found.has(`@typescript-eslint/${rule}`), rule);
  }
  const correct = await fixture(t, {
    "src/main.ts":
      'export function choice(value: "a" | "b"): number { switch (value) { case "a": return 1; case "b": return 2; } }\n',
  }).lint();
  assert.ok(
    !correct.some((item) => item.ruleId === "@typescript-eslint/switch-exhaustiveness-check"),
  );
});

await test("typed scope cannot omit TypeScript and exposes JavaScript without type evidence", async (t) => {
  assert.throws(
    () =>
      fixture(
        t,
        {
          "src/main.ts": "export const value = 1;\n",
          "src/omitted.ts": "export const other = 2;\n",
        },
        { include: ["src/main.ts"] },
      ),
    /outside every configured Program/,
  );
  const files = {
    "src/main.ts": "export const value = 1;\n",
    "src/extra.js": "Promise.resolve(1);\n",
  };
  assert.deepEqual(fixture(t, files).runtime.syntaxOnlyFiles, ["src/extra.js"]);
  const checked = fixture(t, files, { compilerOptions: { allowJs: true } });
  assert.ok(checked.runtime.typedFiles.includes("src/extra.js"));
  assert.ok(
    (await checked.lint("src/extra.js")).some(
      (item) => item.ruleId === "@typescript-eslint/no-floating-promises",
    ),
  );
});

await test("real compiler Programs track extended configs, package metadata, local inputs and absent resolution probes", (t) => {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-typed-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "plumb.json": JSON.stringify({
      schemaVersion: 1,
      preset: "portable",
      projects: [{ root: ".", profile: "typescript" }],
      exclude: [{ files: ["src/hidden.ts"], reason: "Observed dependency fixture" }],
    }),
    "tsconfig.json": JSON.stringify({ extends: "./config/base.json", files: ["src/main.ts"] }),
    "config/base.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
    }),
    "src/main.ts":
      'import type { External } from "typed-fixture";\nimport { hidden } from "./hidden.js";\nexport const value: External = { value: hidden };\n',
    "src/hidden.ts": "export const hidden = 1;\n",
    "node_modules/typed-fixture/package.json": JSON.stringify({
      name: "typed-fixture",
      types: "index.d.ts",
    }),
    "node_modules/typed-fixture/index.d.ts": "export interface External { value: number }\n",
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  const ctx = repositoryContext({ root }),
    analysis = new Analysis(ctx),
    project = ctx.config.projects[0];
  const runtime = typedRuntime(analysis, project, ["src/main.ts"]);
  runtime.programs[0].getSemanticDiagnostics();
  for (const file of [
    "config/base.json",
    "src/main.ts",
    "src/hidden.ts",
    "node_modules/typed-fixture/package.json",
    "node_modules/typed-fixture/index.d.ts",
  ]) {
    assert.ok(ctx.compilerInputs.has(file), file);
  }
  assert.equal(
    analysis.resolver.resolve(
      join(root, "src/main.ts"),
      "./later.js",
      runtime.programs[0].getCompilerOptions(),
    ),
    undefined,
  );
  assert.ok(
    [...ctx.compilerInputs].some(([file, hash]) => file.startsWith("src/later.") && hash === null),
  );
  assert.ok(ctx.compilerDirectories.has("src"));
  writeFileSync(join(root, "src/hidden.ts"), "export const hidden = 2;\n");
  assert.throws(
    () => analysis.compilerHost({}).readFile(join(root, "src/hidden.ts")),
    /changed while checking/,
  );
});

await test("standalone module resolution uses the same closed source boundary", (t) => {
  const parent = mkdtempSync(
    join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-resolver-boundary-"),
  );
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "candidate");
  mkdirSync(root);
  writeFileSync(join(parent, "outside.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "main.ts"), "export const value = 1;\n");
  const resolver = createModuleResolver(root);
  assert.equal(resolver.resolve(join(root, "main.ts"), "../outside"), undefined);
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ extends: "../outside.json", files: ["main.ts"] }),
  );
  writeFileSync(
    join(parent, "outside.json"),
    JSON.stringify({ compilerOptions: { strict: false } }),
  );
  assert.throws(
    () => createModuleResolver(root).optionsFor(join(root, "main.ts")),
    /outside|not found|escapes/i,
  );
});

await test("the public preset reports absent type services rather than a syntax-only TS success", async (t) => {
  const { root } = fixture(t, { "src/main.ts": "export const value = 1;\n" });
  const engine = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: createConfig({ root }),
  });
  const [result] = await engine.lintText("export const value = 1;\n", {
    filePath: join(root, "src/main.ts"),
  });
  assert.ok(
    result.messages.some(
      (item) => item.ruleId === "plumb/type-information" && item.messageId === "unresolved",
    ),
  );
});
