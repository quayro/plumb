import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { syncAssets } from "../src/assets.ts";
import { definePlumb } from "../src/config.ts";
import { checkRepository } from "../src/engine.ts";
import { at } from "../src/schema.ts";

type Write = (path: string, content: string) => void;

async function fixture(
  verify: (root: string, write: Write, database: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-release-test-"));
  const config = definePlumb({
    schemaVersion: 1,
    preset: "portable",
    projects: [{ root: ".", profile: "cpp", compileCommands: "build" }],
  });
  const write: Write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const database = JSON.stringify([
    { directory: root, file: "src/main.cpp", arguments: ["c++", "-c", "src/main.cpp"] },
  ]);
  try {
    write("plumb.json", JSON.stringify(config));
    write("src/main.cpp", "int main() { return 0; }\n");
    write("build/compile_commands.json", database);
    assert.deepEqual(syncAssets({ root, config }).diagnostics, []);
    await verify(root, write, database);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// these tests inject native process results to exercise core integrity, not Clang behavior.
const successful =
  (action: (command: readonly string[]) => void = () => {}) =>
  async (command: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    if (command.at(-1) === "--version") {
      return { code: 0, stdout: "18.1.8", stderr: "" };
    }
    action(command);
    return { code: 0, stdout: "", stderr: "" };
  };

await test("ignored compilation metadata contributes to identity and cannot mutate during a check", async () => {
  await fixture(async (root: string, write: Write, database: string) => {
    const first = await checkRepository({ root, execute: successful() });
    assert.equal(first.status, "pass", JSON.stringify(first.diagnostics));
    write("build/compile_commands.json", `${database}\n`);
    const second = await checkRepository({ root, execute: successful() });
    assert.equal(second.status, "pass", JSON.stringify(second.diagnostics));
    assert.notEqual(at(first.identity, "snapshot"), at(second.identity, "snapshot"));
    const changed = await checkRepository({
      root,
      execute: successful(() => write("build/compile_commands.json", database)),
    });
    assert.equal(changed.status, "incomplete");
    assert.ok(changed.diagnostics.some(({ rule }) => rule === "run.mutated"));
  });
});

await test("existing ignored formatting controls cannot mutate during native execution", async () => {
  await fixture(async (root: string, write: Write) => {
    write("src/.clang-format-ignore", "# no exclusions\n");
    const changed = await checkRepository({
      root,
      execute: successful(() => write("src/.clang-format-ignore", "*\n")),
    });
    assert.equal(changed.status, "incomplete");
    assert.ok(changed.diagnostics.some(({ rule }) => rule === "run.mutated"));
  });
});

await test("a newly created ignored formatting control cannot turn an incomplete check into a pass", async () => {
  await fixture(async (root: string, write: Write) => {
    const changed = await checkRepository({
      root,
      execute: successful(() => write("src/.clang-format-ignore", "*\n")),
    });
    assert.equal(changed.status, "incomplete");
    assert.ok(changed.diagnostics.some(({ rule }) => ["run.mutated", "run.failed"].includes(rule)));
  });
});
