import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { at } from "../src/schema.ts";
import { parseJson } from "./support.ts";

const source = fileURLToPath(new URL("..", import.meta.url));
const temporary =
  process.env.PLUMB_TEST_TMP ?? fileURLToPath(new URL("../../.plumb-tests", import.meta.url));

mkdirSync(temporary, { recursive: true });

function fixture(t: TestContext) {
  const root = mkdtempSync(join(temporary, "identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // the core runs from a vendored folder: Node strips types only outside node_modules
  const core = join(root, "tools/plumb"),
    pack = join(root, "node_modules/@quayro/plumb-javascript");
  mkdirSync(core, { recursive: true });
  mkdirSync(pack, { recursive: true });
  for (const path of ["package.json", "bin", "src"]) {
    cpSync(join(source, path), join(core, path), { recursive: true });
  }
  const manifest = (name: string): void =>
    writeFileSync(
      join(pack, "package.json"),
      JSON.stringify({ name, type: "module", exports: "./index.mjs" }),
    );
  manifest("@quayro/plumb-javascript");
  // this is a loader fixture, not a substitute for the actual JavaScript engine suite.
  writeFileSync(
    join(pack, "index.mjs"),
    [
      "export const rules = () => [];",
      "export const check = () => ({diagnostics: []});",
      "export const fix = () => ({diagnostics: [], written: []});",
      "export const snapshot = () => [];",
      "export const surfaceSnapshotIsValid = () => false;",
      "",
    ].join("\n"),
  );
  writeFileSync(join(pack, "policy.json"), '{"setting":1}\n');
  const inspect = (compiled = false) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `${compiled ? 'globalThis.PLUMB_BUILD_ID = "compiled-core";' : ""} const engine = await import(${JSON.stringify(pathToFileURL(join(core, "src/engine.ts")).href)}); const pack = await engine.javascriptPack(); process.stdout.write(JSON.stringify(engine.checkerIdentity(pack.identity)));`,
      ],
      { cwd: root, encoding: "utf8" },
    );
  return { pack, inspect, manifest };
}

await test("checker identity includes the resolved optional pack independently of core or build identity", (t) => {
  const { pack, inspect } = fixture(t);
  const first = inspect();
  assert.equal(first.status, 0, first.stderr);
  writeFileSync(join(pack, "policy.json"), '{"setting":2}\n');
  const second = inspect();
  assert.equal(second.status, 0, second.stderr);
  const before = parseJson(first.stdout),
    after = parseJson(second.stdout);
  assert.equal(at(before, "sha256"), at(after, "sha256"));
  assert.notEqual(at(before, "javascript", "sha256"), at(after, "javascript", "sha256"));
  assert.equal(at(after, "javascript", "version"), undefined);
  const compiled = inspect(true);
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(at(parseJson(compiled.stdout), "sha256"), "compiled-core");
  assert.deepEqual(at(parseJson(compiled.stdout), "javascript"), at(after, "javascript"));
});

await test("the optional pack must be the Plumb JavaScript package", (t) => {
  const { inspect, manifest } = fixture(t);
  manifest("other-pack");
  const result = inspect();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be @quayro\/plumb-javascript/);
});
