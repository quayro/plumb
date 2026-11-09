import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { loadAdapterRegistry } from "../../../src/adapter-registry.ts";
import { type AdapterDefinition, manifest, respond } from "../adapter.ts";

const toy: AdapterDefinition = {
  id: "toy",
  version: "2.0.0",
  files: ["**/*.toy"],
  capabilities: ["policy"],
  rules: [{ id: "word", description: "No bad words.", remedy: "Remove the word." }],
  check: ({ text }) => {
    if (text.includes("crash")) {
      throw new Error("parser gave up");
    }
    if (text.includes("stray")) {
      return [{ rule: "undeclared", message: "x" }];
    }
    return text.includes("bad") ? [{ rule: "word", message: "bad word", line: 1, column: 1 }] : [];
  },
};

function project(t: TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-sdk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(root, path), content);
  }
  const request = (extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    action: "check",
    adapter: "toy",
    version: "2.0.0",
    root,
    project: { root: ".", profile: "toy" },
    files: Object.entries(files).map(([path, content]) => ({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
    ...extra,
  });
  return { root, request };
}

const shape = (response: ReturnType<typeof respond>) =>
  response.diagnostics.map((item) => [item.rule, item.path, item.status ?? "violation"]);

await test("a clean file passes with evidence and a finding is a namespaced violation", (t) => {
  const { request } = project(t, { "a.toy": "fine", "b.toy": "bad" }),
    response = respond(toy, request());
  assert.equal(response.status, "violation");
  assert.deepEqual(shape(response), [["toy/word", "b.toy", "violation"]]);
  assert.deepEqual(response.coverage, [{ capability: "policy", files: ["a.toy", "b.toy"] }]);
  assert.deepEqual(
    response.inputs.map((item) => item.path),
    ["a.toy", "b.toy"],
  );
  assert.equal(respond(toy, project(t, { "a.toy": "fine" }).request()).status, "pass");
});

await test("what the adapter cannot verify is incomplete and never covered", (t) => {
  const { request } = project(t, { "a.toy": "fine" });
  const stale = request({ files: [{ path: "a.toy", sha256: "0".repeat(64) }] }),
    missing = request({ files: [{ path: "gone.toy", sha256: "0".repeat(64) }] });
  for (const [value, rule] of [
    [stale, "toy/input"],
    [missing, "toy/input"],
    [project(t, { "a.toy": "crash" }).request(), "toy/input"],
    [project(t, { "a.toy": "stray" }).request(), "toy/input"],
    [request({ schemaVersion: 2 }), "toy/protocol"],
    [request({ adapter: "other" }), "toy/protocol"],
    [request({ version: "1.0.0" }), "toy/protocol"],
    [request({ action: "fix" }), "toy/protocol"],
    [request({ files: [{ path: "../outside.toy", sha256: "0".repeat(64) }] }), "toy/protocol"],
    [request({ files: [{ path: "/etc/hosts", sha256: "0".repeat(64) }] }), "toy/protocol"],
    [undefined, "toy/protocol"],
    ["not a request", "toy/protocol"],
  ] as const) {
    const response = respond(toy, value);
    assert.equal(response.status, "incomplete", JSON.stringify(value));
    assert.equal(response.diagnostics[0]?.rule, rule);
    assert.deepEqual(response.coverage, []);
  }
  assert.equal(respond(toy, missing).inputs[0]?.sha256, null);
});

await test("doctor answers without reading or claiming any source", (t) => {
  const { request } = project(t, { "a.toy": "bad" }),
    response = respond(toy, request({ action: "doctor" }));
  assert.equal(response.status, "pass");
  assert.deepEqual([response.coverage, response.inputs], [[], []]);
});

await test("the manifest is a registry the core accepts, with every file pinned", (t) => {
  const { root } = project(t, {}),
    tools = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-sdk-tools-"));
  t.after(() => rmSync(tools, { recursive: true, force: true }));
  const file = join(tools, "registry.json");
  writeFileSync(file, JSON.stringify(manifest(toy, fileURLToPath(import.meta.url))));
  const entry = loadAdapterRegistry(file, root)?.adapters[0];
  assert.equal(entry?.id, "toy");
  assert.equal(entry?.integrity.length, 3);
  assert.deepEqual(
    entry?.rules.map((rule) => [rule.id, rule.capability, rule.suppressible]),
    [
      ["toy/input", "policy", false],
      ["toy/protocol", "policy", false],
      ["toy/word", "policy", undefined],
    ],
  );
});
