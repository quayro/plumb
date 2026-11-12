import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { loadAdapterRegistry } from "../../../src/adapter-registry.ts";
import { main } from "../../../src/cli.ts";
import { at } from "../../../src/schema.ts";
import { mapped, parseJson, parseReport } from "../../../test/support.ts";

export function folder(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// the contract every SDK port keeps, proved on its toy adapter: id toy, version 2.0.0, files
// **/*.toy, capability policy, rule word. A source holding "bad" is a word finding at 1:1, "crash"
// fails the check and "stray" reports an undeclared rule.
export async function contractAssert(t: TestContext, command: readonly string[]): Promise<void> {
  const [program = "", ...prefix] = command;
  const root = folder(t, "plumb-sdk-port-"),
    registry = join(folder(t, "plumb-sdk-port-tools-"), "registry.json");
  const files = { "a.toy": "fine", "b.toy": "bad", "c.toy": "crash", "d.toy": "stray" };
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(root, path), content);
  }
  const run = (args: string[], input = ""): { status: number | null; stdout: string } => {
    const result = spawnSync(program, [...prefix, ...args], { encoding: "utf8", input });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  };
  const request = (paths: string[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      schemaVersion: 1,
      action: "check",
      adapter: "toy",
      version: "2.0.0",
      root,
      project: { root: ".", profile: "toy" },
      files: paths.map((path) => ({
        path,
        sha256: sha256(Object.entries(files).find(([name]) => name === path)?.[1] ?? ""),
      })),
      ...extra,
    });
  const answer = (input: string, code: number): unknown => {
    const result = run([], input);
    assert.equal(result.status, code, `${input}\n${result.stdout}`);
    return parseJson(result.stdout);
  };
  const shape = (response: unknown): unknown[] =>
    mapped(at(response, "diagnostics"), (item) => [
      at(item, "rule"),
      at(item, "path"),
      at(item, "status") ?? "violation",
    ]);

  const clean = answer(request(["a.toy"]), 0);
  assert.deepEqual(
    [at(clean, "status"), at(clean, "coverage"), at(clean, "inputs")],
    [
      "pass",
      [{ capability: "policy", files: ["a.toy"] }],
      [{ path: "a.toy", sha256: sha256("fine") }],
    ],
  );
  // an escaped path names the same file: the port reads JSON, not the bytes of the request
  const escaped = request(["a.toy"]).replace('"path":"a.toy"', '"path":"\\u0061.toy"');
  assert.match(escaped, /u0061/);
  assert.deepEqual(at(answer(escaped, 0), "coverage", 0, "files"), ["a.toy"]);
  const found = answer(request(["a.toy", "b.toy"]), 1);
  assert.deepEqual(shape(found), [["toy/word", "b.toy", "violation"]]);
  assert.deepEqual(
    [at(found, "diagnostics", 0, "line"), at(found, "diagnostics", 0, "column")],
    [1, 1],
  );
  assert.deepEqual(at(found, "coverage"), [{ capability: "policy", files: ["a.toy", "b.toy"] }]);

  const stale = { files: [{ path: "a.toy", sha256: "0".repeat(64) }] };
  for (const [input, rule] of [
    [request([], stale), "toy/input"],
    [request(["gone.toy"]), "toy/input"],
    [request(["c.toy"]), "toy/input"],
    [request(["d.toy"]), "toy/input"],
    [request(["a.toy"], { schemaVersion: 2 }), "toy/protocol"],
    [request(["a.toy"], { schemaVersion: true }), "toy/protocol"],
    [request(["a.toy"], { adapter: "other" }), "toy/protocol"],
    [request(["a.toy"], { version: "1.0.0" }), "toy/protocol"],
    [request(["a.toy"], { action: "fix" }), "toy/protocol"],
    [request(["../outside.toy"]), "toy/protocol"],
    [request(["/etc/hosts"]), "toy/protocol"],
    [request(["C:/a.toy"]), "toy/protocol"],
    [request(["C:\\\\a.toy"]), "toy/protocol"],
    [request(["\\\\a.toy"]), "toy/protocol"],
    ['"not a request"', "toy/protocol"],
    ["not json", "toy/protocol"],
  ] as const) {
    const response = answer(input, 2);
    assert.equal(at(response, "diagnostics", 0, "rule"), rule, input);
    assert.deepEqual(at(response, "coverage"), [], input);
  }
  assert.equal(at(answer(request(["gone.toy"]), 2), "inputs", 0, "sha256"), null);
  const doctor = answer(request(["b.toy"], { action: "doctor" }), 0);
  assert.deepEqual([at(doctor, "coverage"), at(doctor, "inputs")], [[], []]);

  // the printed manifest is a registry the core accepts, and the adapter conforms and runs under it
  const printed = run(["--manifest"]);
  assert.equal(printed.status, 0, printed.stdout);
  writeFileSync(registry, printed.stdout);
  assert.deepEqual(
    loadAdapterRegistry(registry, root)?.adapters[0]?.rules.map((rule) => [
      rule.id,
      rule.capability,
      rule.suppressible,
    ]),
    [
      ["toy/input", "policy", false],
      ["toy/protocol", "policy", false],
      ["toy/word", "policy", undefined],
    ],
  );
  const cli = async (args: string[]): Promise<{ code: number; text: string }> => {
    let text = "";
    const code = await main([...args, "--adapters", registry, "--format", "json"], (chunk) => {
      text += chunk;
    });
    return { code, text };
  };
  const conformance = await cli(["conformance"]);
  assert.equal(conformance.code, 0, conformance.text);
  assert.deepEqual(
    mapped(at(parseReport(conformance.text).adapters, 0, "probes"), (probe) => at(probe, "passed")),
    [true, true, true, true, true, true],
  );
  for (const path of ["c.toy", "d.toy"]) {
    rmSync(join(root, path));
  }
  writeFileSync(
    join(root, "plumb.json"),
    JSON.stringify({
      schemaVersion: 1,
      preset: "portable",
      projects: [{ root: ".", profile: "toy" }],
    }),
  );
  const checked = await cli(["check", "--root", root]);
  assert.equal(checked.code, 1, checked.text);
  assert.deepEqual(
    parseReport(checked.text).diagnostics.map((item) => [item.rule, item.path, item.line]),
    [["toy/word", "b.toy", 1]],
  );
}
