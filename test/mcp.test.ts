import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { serve } from "../src/mcp.ts";
import { at } from "../src/schema.ts";
import { parseJson } from "./support.ts";

const request = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

const callTool = (id: number, name: string, values?: unknown): string =>
  request(id, "tools/call", { name, arguments: values });

// answers the given lines with a recorded fake command runner
async function exchange(lines: string[], code = 0) {
  const replies: unknown[] = [],
    runs: (readonly string[])[] = [];
  async function* input() {
    yield* lines;
  }
  await serve(
    input(),
    (text) => replies.push(parseJson(text)),
    (argv) => {
      runs.push(argv);
      return Promise.resolve({ code, text: '{"file":{"path":"a.ts"},"policy":"large"}' });
    },
    "1",
  );
  return { replies, runs };
}

await test("the server negotiates a version, lists read-only tools and ignores notifications", async () => {
  const { replies } = await exchange([
    request(1, "initialize", { protocolVersion: "2024-11-05" }),
    request(2, "initialize", { protocolVersion: "1999-01-01" }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    "",
    request(3, "tools/list"),
    request(4, "ping"),
  ]);
  assert.deepEqual(
    replies.map((reply) => at(reply, "id")),
    [1, 2, 3, 4],
  );
  assert.equal(at(replies[0], "result", "protocolVersion"), "2024-11-05");
  assert.equal(at(replies[1], "result", "protocolVersion"), "2025-06-18");
  const tools: unknown = at(replies[2], "result", "tools");
  assert.ok(Array.isArray(tools));
  assert.deepEqual(
    tools.map((tool) => at(tool, "name")),
    ["instructions", "check", "plan", "inspect_file", "explain"],
  );
});

await test("malformed lines, unknown methods and unknown tools are protocol errors", async () => {
  const { replies, runs } = await exchange([
    "{not json",
    request(1, "resources/list"),
    callTool(2, "fix"),
    callTool(3, "sync"),
  ]);
  assert.deepEqual(
    replies.map((reply) => [at(reply, "id"), at(reply, "error", "code")]),
    [
      [null, -32700],
      [1, -32601],
      [2, -32602],
      [3, -32602],
    ],
  );
  assert.deepEqual(runs, []);
});

await test("an argument cannot add an option or a second value to the command", async () => {
  const { replies, runs } = await exchange([
    callTool(1, "inspect_file", { path: "--policy" }),
    callTool(2, "explain", { rule: "--help" }),
    callTool(3, "explain", { rule: "-x" }),
    callTool(4, "explain", { rule: ["files.forbidden", "--policy", "/tmp/loose.json"] }),
    callTool(5, "explain", { rule: "" }),
    callTool(6, "explain"),
    callTool(7, "check", { policy: "/tmp/loose.json", "dry-run": true }),
    callTool(8, "inspect_file", { path: "src/a b.ts", file: "other.ts" }),
  ]);
  assert.deepEqual(
    replies.slice(0, 6).map((reply) => at(reply, "error", "code")),
    Array.from({ length: 6 }, () => -32602),
  );
  // undeclared arguments are dropped, and a declared one stays a single argv value
  assert.deepEqual(runs, [
    ["check", "--format", "json"],
    ["inspect", "--file", "src/a b.ts"],
  ]);
  assert.equal(at(replies[7], "result", "content", 0, "text"), '{\n  "path": "a.ts"\n}');
});

await test("a violation or an incomplete run is an error result, never a pass", async () => {
  for (const code of [1, 2]) {
    const { replies } = await exchange(
      [callTool(1, "check"), callTool(2, "inspect_file", { path: "a" })],
      code,
    );
    assert.deepEqual(
      replies.map((reply) => at(reply, "result", "isError")),
      [true, true],
    );
  }
});

await test("plumb mcp serves the policy it was started with over stdio", (t) => {
  const root = mkdtempSync(join(tmpdir(), "plumb-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "plumb.json"),
    JSON.stringify({ schemaVersion: 1, preset: "portable", files: { forbidden: ["**/*.orig"] } }),
  );
  writeFileSync(join(root, "a.orig"), "x\n");
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/plumb.ts", import.meta.url)), "mcp", "--root", root],
    {
      encoding: "utf8",
      input: `${[
        request(1, "initialize", { protocolVersion: "2025-06-18" }),
        callTool(2, "check"),
        callTool(3, "explain", { rule: "files.forbidden" }),
        callTool(4, "inspect_file", { path: "a.orig" }),
        callTool(5, "inspect_file", { path: "../outside.ts" }),
      ].join("\n")}\n`,
    },
  );
  assert.equal(child.status, 0);
  const replies = child.stdout.trimEnd().split("\n").map(parseJson);
  const text = (index: number): unknown =>
    parseJson(String(at(replies[index], "result", "content", 0, "text")));
  assert.equal(at(replies[0], "result", "serverInfo", "name"), "plumb");
  assert.equal(at(replies[1], "result", "isError"), true);
  assert.equal(at(text(1), "diagnostics", 0, "rule"), "files.forbidden");
  assert.equal(at(text(2), "rule", "id"), "files.forbidden");
  assert.deepEqual(at(text(3), "checks"), ["files"]);
  assert.equal(at(replies[4], "result", "isError"), true);
  assert.equal(at(text(4), "status"), "incomplete");
});
