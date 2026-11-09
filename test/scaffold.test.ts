import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { main } from "../src/cli.ts";
import type { Report } from "../src/diagnostics.ts";
import { checkRepository, context, scaffoldRepository } from "../src/engine.ts";
import { scaffold, type ScaffoldCheck } from "../src/scaffold.ts";
import { at, isArray } from "../src/schema.ts";
import { lengthOf, parseJson } from "./support.ts";

const mapped = (value: unknown, read: (item: unknown) => unknown): unknown[] =>
  isArray(value) ? value.map(read) : [];

const policy = (): Record<string, unknown> => ({
  schemaVersion: 1,
  preset: "portable",
  conventions: {
    files: ["src/**", "test/**"],
    roles: [
      {
        id: "source",
        files: ["src/**"],
        name: "^[a-z-]+\\.txt$",
        companions: [{ path: "test/{stem}.txt", role: "test" }],
        scaffold: {
          path: "src/{name}.txt",
          content: "source {name}\n",
          companions: [{ path: "test/{name}.txt", content: "test {name}\n" }],
        },
      },
      { id: "test", files: ["test/**"] },
    ],
  },
});

function fixture(t: TestContext, value = policy()) {
  const temporary = process.env.PLUMB_TEST_TMP ?? tmpdir();
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, "scaffold-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "plumb.json"), JSON.stringify(value));
  return root;
}

const check = (candidate: ScaffoldCheck): Promise<Report> => checkRepository(candidate);

const pass = (): Report => ({
  schemaVersion: 1,
  status: "pass",
  exitCode: 0,
  checks: [],
  diagnostics: [],
});

await test("scaffolding validates the complete new role and companions in isolation before writing", async (t) => {
  const root = fixture(t);
  const preview = await scaffoldRepository({
    root,
    role: "source",
    name: "greeting",
    dryRun: true,
  });
  assert.equal(preview.exitCode, 0, JSON.stringify(preview.diagnostics));
  assert.equal(at(preview.plan, "kind"), "plumb-scaffold");
  assert.equal(existsSync(join(root, "src/greeting.txt")), false);
  assert.deepEqual(
    mapped(at(preview.plan, "files"), (item) => at(item, "path")),
    ["src/greeting.txt", "test/greeting.txt"],
  );
  assert.match(String(at(preview.plan, "identity", "snapshot")), /^[a-f0-9]{64}$/);
  assert.ok(
    String(at(preview.plan, "patch")).startsWith(
      '--- /dev/null\n+++ "b/src/greeting.txt"\n@@ -0,0 +1,',
    ),
    String(at(preview.plan, "patch")),
  );
  const created = await scaffoldRepository({ root, role: "source", name: "greeting" });
  assert.equal(created.exitCode, 0, JSON.stringify(created.diagnostics));
  assert.deepEqual(created.written, ["src/greeting.txt", "test/greeting.txt"]);
  assert.equal(readFileSync(join(root, "src/greeting.txt"), "utf8"), "source greeting\n");
  assert.equal((await checkRepository({ root })).exitCode, 0);
  const again = await scaffoldRepository({ root, role: "source", name: "greeting" });
  assert.equal(again.exitCode, 2);
  assert.equal(lengthOf(again.written), 0);
});

await test("invalid or incomplete scaffold validation never creates original source", async (t) => {
  const value = policy();
  value.files = {
    names: [{ files: ["src/**"], pattern: "^approved\\.txt$", reason: "approved names" }],
  };
  const root = fixture(t, value),
    refused = await scaffoldRepository({ root, role: "source", name: "bad" });
  assert.equal(refused.exitCode, 1);
  assert.ok(refused.diagnostics.some((item) => item.rule === "files.names"));
  assert.equal(lengthOf(refused.written), 0);
  assert.equal(existsSync(join(root, "src")), false);
  const ctx = context({ root: fixture(t) });
  const incomplete = await scaffold(
    ctx,
    async (): Promise<Report> => ({
      schemaVersion: 1,
      status: "incomplete",
      exitCode: 2,
      checks: [],
      diagnostics: [{ rule: "tools.missing", path: ".", status: "incomplete", message: "missing" }],
    }),
    { role: "source", name: "new" },
  );
  assert.equal(incomplete.written.length, 0);
  assert.equal(at(incomplete.plan, "validation", "status"), "incomplete");
  assert.equal(existsSync(join(ctx.root, "src")), false);
  for (const status of ["violation", "incomplete", "unknown"]) {
    await assert.rejects(
      scaffold(ctx, async () => ({ ...pass(), checks: [{ id: "required", status }] }), {
        role: "source",
        name: "new",
      }),
      /contradicts/,
    );
    assert.equal(existsSync(join(ctx.root, "src")), false);
  }
});

await test("a checker cannot mutate scaffold proposals or approve stale original inputs", async (t) => {
  const root = fixture(t),
    ctx = context({ root });
  await assert.rejects(
    scaffold(
      ctx,
      async (candidate) => {
        writeFileSync(join(candidate.root, "src/new.txt"), "changed");
        return pass();
      },
      { role: "source", name: "new" },
    ),
    /checker changed/,
  );
  assert.equal(existsSync(join(root, "src")), false);
  await assert.rejects(
    scaffold(
      ctx,
      async () => {
        writeFileSync(join(root, "other.txt"), "concurrent");
        return pass();
      },
      { role: "source", name: "new" },
    ),
    /inputs changed/,
  );
  assert.equal(existsSync(join(root, "src")), false);
  assert.equal(readFileSync(join(root, "other.txt"), "utf8"), "concurrent");
});

await test("multi-file creation rolls back its own files when a later exclusive open fails", async (t) => {
  const root = fixture(t);
  let count = 0;
  await assert.rejects(
    scaffold(context({ root }), check, {
      role: "source",
      name: "new",
      create: (...args) => {
        if (++count === 2) {
          throw new Error("simulated create failure");
        }
        return openSync(...args);
      },
    }),
    /simulated create failure/,
  );
  assert.equal(existsSync(join(root, "src")), false);
  assert.equal(existsSync(join(root, "test")), false);
});

await test("rollback preserves a path created by another writer", async (t) => {
  const root = fixture(t);
  let count = 0;
  await assert.rejects(
    scaffold(context({ root }), check, {
      role: "source",
      name: "new",
      create: (...args) => {
        if (++count === 2) {
          writeFileSync(args[0], "concurrent");
        }
        return openSync(...args);
      },
    }),
    /EEXIST/,
  );
  assert.equal(existsSync(join(root, "src/new.txt")), false);
  assert.equal(readFileSync(join(root, "test/new.txt"), "utf8"), "concurrent");
});

await test("CLI scaffold enforces its arguments and reports the reviewable proposal", async (t) => {
  const root = fixture(t);
  let output = "";
  assert.equal(
    await main(
      ["scaffold", "source", "hello", "--root", root, "--dry-run", "--format", "json"],
      (text) => {
        output += text;
      },
    ),
    0,
  );
  assert.equal(lengthOf(at(parseJson(output), "plan", "files")), 2);
  assert.equal(existsSync(join(root, "src")), false);
  for (const args of [
    ["scaffold", "source"],
    ["scaffold", "source", "hello", "--apply", "x"],
    ["scaffold", "source", "hello", "--staged"],
  ]) {
    assert.equal(await main([...args, "--root", root], () => {}), 2);
  }
});
