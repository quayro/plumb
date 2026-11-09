import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { context } from "../src/engine.ts";
import { checkFormatting, fixFormatting, formattingFiles } from "../src/formatting.ts";
import { keysOf, parseJson } from "./support.ts";

const TABLE = "# Title\n\n| a | bb |\n|---|---|\n| ccc | d |\n";
const KEYS = "A string # one\nLONG_NAME nonEmpty # two\n";

function repo(t: TestContext, policy = {}, files = {}) {
  const temporary = process.env.PLUMB_TEST_TMP ?? tmpdir();
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, "formatting-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const all = { "plumb.json": JSON.stringify({ schemaVersion: 1, ...policy }), ...files };
  for (const [path, value] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  }
  return {
    root,
    ctx: (mode = "check") => context({ root, mode }),
    read: (path: string) => readFileSync(join(root, path), "utf8"),
  };
}

await test("a misaligned Markdown table is reported, fixed, and then passes", (t) => {
  const r = repo(t, {}, { "README.md": TABLE });
  assert.deepEqual(
    checkFormatting(r.ctx()).map(({ rule, path }) => [rule, path]),
    [["format.markdown-table", "README.md"]],
  );
  assert.deepEqual(fixFormatting(r.ctx("fix")).written, ["README.md"]);
  assert.match(r.read("README.md"), /\| a {3}\| bb {2}\|/);
  assert.deepEqual(checkFormatting(r.ctx()), []);
});

await test("the JavaScript pack owns Markdown when a JavaScript project exists", (t) => {
  const r = repo(t, { projects: [{ root: ".", profile: "typescript" }] }, { "README.md": TABLE });
  assert.ok(!formattingFiles(r.ctx()).includes("README.md"));
});

await test("the portable preset selects nothing by default", (t) => {
  const r = repo(t, { preset: "portable" }, { "README.md": TABLE, "api/.env.schema": KEYS });
  assert.deepEqual(formattingFiles(r.ctx()), []);
});

await test("key-column files default to env schemas and follow the configured globs", (t) => {
  const files = { "api/.env.schema": KEYS, "config/app.keys": KEYS };
  assert.deepEqual(
    checkFormatting(repo(t, {}, files).ctx()).map(({ rule, path }) => [rule, path]),
    [["format.key-columns", "api/.env.schema"]],
  );
  assert.deepEqual(
    formattingFiles(repo(t, { format: { keyColumns: ["config/*.keys"] } }, files).ctx()),
    ["config/app.keys"],
  );
});

await test("only listed JSON files have their keys sorted", (t) => {
  const r = repo(
    t,
    { format: { sortKeys: [{ files: ["data/*.json"] }] } },
    { "data/a.json": '{"b":1,"a":2}\n', "other.json": '{"b":1,"a":2}\n' },
  );
  assert.deepEqual(
    checkFormatting(r.ctx()).map(({ rule, path }) => [rule, path]),
    [["format.json-keys", "data/a.json"]],
  );
  fixFormatting(r.ctx("fix"));
  assert.deepEqual(keysOf(parseJson(r.read("data/a.json") ?? "")), ["a", "b"]);
  assert.equal(r.read("other.json"), '{"b":1,"a":2}\n');
  assert.deepEqual(checkFormatting(r.ctx()), []);
});

await test("an unparseable selected JSON file is incomplete, never a silent pass", (t) => {
  const r = repo(
    t,
    { format: { sortKeys: [{ files: ["data/*.json"] }] } },
    { "data/a.json": "{oops" },
  );
  assert.deepEqual(
    checkFormatting(r.ctx()).map(({ rule, status }) => [rule, status]),
    [["format.json-keys", "incomplete"]],
  );
});

await test("excluded, ignored and generated files are never selected", (t) => {
  const r = repo(
    t,
    {
      exclude: [{ files: ["vendor/**"], reason: "third party" }],
      format: { ignore: [{ path: "docs/frozen.md", reason: "archived" }] },
    },
    { "vendor/x.md": TABLE, "docs/frozen.md": TABLE, "docs/live.md": TABLE },
  );
  const selected = formattingFiles(r.ctx());
  assert.ok(selected.includes("docs/live.md"));
  assert.ok(!selected.includes("vendor/x.md") && !selected.includes("docs/frozen.md"));
  for (const owned of r.ctx().ownedFiles) {
    assert.ok(!selected.includes(owned));
  }
});

await test("integer-like keys out of code-point order are reported", (t) => {
  const r = repo(
    t,
    { format: { sortKeys: [{ files: ["a.json"] }] } },
    { "a.json": '{"9":1,"10":2}\n' },
  );
  assert.deepEqual(
    checkFormatting(r.ctx()).map(({ rule }) => rule),
    ["format.json-keys"],
  );
});
