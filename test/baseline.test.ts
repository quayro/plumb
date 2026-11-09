import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { main } from "../src/cli.ts";
import { at } from "../src/schema.ts";
import { parseJson, parseReport } from "./support.ts";

const POLICY = { schemaVersion: 1, preset: "portable", files: { forbidden: ["**/*.orig"] } };

function fixture(t: TestContext, files: string[], exceptions: unknown = []) {
  const root = mkdtempSync(join(tmpdir(), "plumb-baseline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "plumb.json"), JSON.stringify({ ...POLICY, exceptions }));
  for (const file of files) {
    writeFileSync(join(root, file), "x\n");
  }
  return root;
}

async function run(root: string, ...args: string[]) {
  let text = "";
  const code = await main([...args, "--root", root], (chunk) => {
    text += chunk;
  });
  return { code, text };
}

await test("baseline budgets today's violations and writes nothing", async (t) => {
  const root = fixture(t, ["a.orig", "b.orig"]),
    before = await run(root, "check", "--format", "json");
  assert.equal(before.code, 1);
  const proposed = await run(root, "baseline");
  assert.equal(proposed.code, 0);
  const exceptions = at(parseJson(proposed.text), "exceptions");
  assert.deepEqual(exceptions, [
    {
      id: "baseline-files-forbidden",
      rules: ["files.forbidden"],
      files: ["a.orig", "b.orig"],
      reason: "baseline: violations that predate this policy",
      max: 2,
    },
  ]);
  // the policy is untouched until someone adds the reviewed entries
  assert.equal((await run(root, "check", "--format", "json")).code, 1);
  writeFileSync(join(root, "plumb.json"), JSON.stringify({ ...POLICY, exceptions }));
  const after = await run(root, "check", "--format", "json");
  assert.equal(after.code, 0);
  assert.equal(parseReport(after.text).suppressed?.length, 2);
  // the budget covers exactly the reviewed files: a new violation still fails
  writeFileSync(join(root, "c.orig"), "x\n");
  assert.equal((await run(root, "check", "--format", "json")).code, 1);
  const next = parseJson((await run(root, "baseline")).text);
  assert.equal(at(next, "exceptions", 0, "id"), "baseline-files-forbidden-x");
  assert.deepEqual(at(next, "exceptions", 0, "files"), ["c.orig"]);
});

await test("baseline never budgets what an exception cannot suppress", async (t) => {
  const stale = {
    id: "old",
    rules: ["files.forbidden"],
    files: ["gone.orig"],
    reason: "left behind",
    max: 1,
  };
  // a glob in a file name cannot be named exactly, and a stale exception is not suppressible
  const root = fixture(t, ["x{1}.orig"], [stale]),
    proposed = await run(root, "baseline"),
    result = parseReport(proposed.text);
  assert.notEqual(proposed.code, 0);
  assert.deepEqual(at(parseJson(proposed.text), "exceptions"), []);
  assert.deepEqual(result.diagnostics.map((item) => item.rule).sort(), [
    "exceptions.stale",
    "files.forbidden",
  ]);
});
