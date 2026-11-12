import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { syncAssets } from "../src/assets.ts";
import { definePlumb } from "../src/config.ts";
import { checkRepository } from "../src/engine.ts";

type Write = (path: string, content: string) => void;

async function fixture(verify: (root: string, write: Write) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-release-test-"));
  const config = definePlumb({
    schemaVersion: 1,
    preset: "portable",
    projects: [{ root: ".", profile: "python" }],
  });
  const write: Write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  try {
    write("plumb.json", JSON.stringify(config));
    write("src/main.py", "x = 1\n");
    assert.deepEqual(syncAssets({ root, config }).diagnostics, []);
    await verify(root, write);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// these tests inject tool results to exercise core integrity, not ruff or mypy behavior.
const successful =
  (action: (command: readonly string[]) => void = () => {}) =>
  async (command: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    if (command.at(-1) === "--version") {
      return { code: 0, stdout: "1.0.0", stderr: "" };
    }
    action(command);
    return { code: 0, stdout: "", stderr: "" };
  };

await test("a clean python check passes with the synced tool policies", async () => {
  await fixture(async (root) => {
    const result = await checkRepository({ root, execute: successful() });
    assert.equal(result.status, "pass", JSON.stringify(result.diagnostics));
  });
});

await test("existing tool policies cannot mutate during native execution", async () => {
  await fixture(async (root, write) => {
    const changed = await checkRepository({
      root,
      execute: successful(() => write("ruff.toml", "line-length = 200\n")),
    });
    assert.equal(changed.status, "incomplete");
    assert.ok(changed.diagnostics.some(({ rule }) => rule === "run.mutated"));
  });
});

await test("a newly created nested tool policy cannot turn an incomplete check into a pass", async () => {
  await fixture(async (root, write) => {
    const changed = await checkRepository({
      root,
      execute: successful(() => write("src/ruff.toml", '[lint]\nignore = ["ALL"]\n')),
    });
    assert.equal(changed.status, "incomplete");
    assert.ok(changed.diagnostics.some(({ rule }) => ["run.mutated", "run.failed"].includes(rule)));
  });
});
