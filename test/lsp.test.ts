import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { serveEditor } from "../src/lsp.ts";
import { at } from "../src/schema.ts";
import { lengthOf, parseJson } from "./support.ts";

const ROOT = join("/", "work", "repo");

const frame = (message: unknown): string => {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};

const notify = (method: string): string => frame({ jsonrpc: "2.0", method });

// feeds the given chunks to the server, answering each check with the next recorded report
async function exchange(chunks: string[], reports: unknown[]) {
  const written: unknown[] = [];
  let runs = 0;
  async function* input() {
    yield* chunks;
  }
  const code = await serveEditor(
    input(),
    (text) => written.push(parseJson(text.slice(text.indexOf("\r\n\r\n") + 4))),
    (argv) => {
      assert.deepEqual(argv, ["check", "--format", "json"]);
      return Promise.resolve({ code: 1, text: JSON.stringify(reports[runs++] ?? {}) });
    },
    ROOT,
    "1",
  );
  return { code, written, runs };
}

const published = (written: unknown[]): unknown[] =>
  written
    .filter((message) => at(message, "method") === "textDocument/publishDiagnostics")
    .map((message) => [
      at(message, "params", "uri"),
      lengthOf(at(message, "params", "diagnostics")),
    ]);

const uri = (path: string): string => pathToFileURL(join(ROOT, path)).href;

await test("the server announces save-driven diagnostics and answers the lifecycle", async () => {
  const { code, written, runs } = await exchange(
    [
      frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      frame({ jsonrpc: "2.0", id: 2, method: "textDocument/hover" }),
      frame({ jsonrpc: "2.0", id: 3, method: "shutdown" }),
      notify("exit"),
      notify("textDocument/didSave"),
    ],
    [],
  );
  assert.equal(code, 0);
  assert.deepEqual(at(written[0], "result", "capabilities", "textDocumentSync"), {
    openClose: true,
    change: 0,
    save: true,
  });
  assert.equal(at(written[1], "error", "code"), -32601);
  assert.equal(at(written[2], "result"), null);
  // nothing after exit is served
  assert.equal(runs, 0);
});

await test("each save publishes the check per file and clears files that became clean", async () => {
  const violation = {
    diagnostics: [
      { rule: "files.names", path: "src/A.ts", message: "Rename it.", remedy: "Use kebab-case." },
      { rule: "custom.x", path: "src/b.ts", message: "No.", line: 3, column: 5 },
      { rule: "run.failed", path: ".", message: "A tool is missing.", status: "incomplete" },
    ],
  };
  const { written } = await exchange(
    [notify("initialized"), notify("textDocument/didSave")],
    [violation, { diagnostics: [violation.diagnostics[1]] }],
  );
  assert.deepEqual(published(written), [
    [uri("src/A.ts"), 1],
    [uri("src/b.ts"), 1],
    // a repository-wide failure is shown on the policy file
    [uri("plumb.json"), 1],
    [uri("src/A.ts"), 0],
    [uri("src/b.ts"), 1],
    [uri("plumb.json"), 0],
  ]);
  const shown = at(written[1], "params", "diagnostics", 0);
  assert.deepEqual(at(shown, "range", "start"), { line: 2, character: 4 });
  assert.deepEqual(
    [at(shown, "code"), at(shown, "source"), at(shown, "severity")],
    ["custom.x", "plumb", 1],
  );
  assert.equal(
    at(written[0], "params", "diagnostics", 0, "message"),
    "Rename it.\nUse kebab-case.",
  );
  // an incomplete run is an error in the editor too, never a hint
  assert.equal(at(written[2], "params", "diagnostics", 0, "severity"), 1);
});

await test("messages split across chunks, unframed bytes and broken bodies do not stall it", async () => {
  const open = notify("textDocument/didOpen"),
    broken = "Content-Length: 5\r\n\r\n{nope";
  const { written, runs } = await exchange(
    [
      open.slice(0, 20),
      open.slice(20),
      "X-Noise: 1\r\n\r\n",
      broken,
      frame({ jsonrpc: "2.0", id: 9, method: "shutdown" }),
    ],
    [{ diagnostics: [] }],
  );
  assert.equal(runs, 1);
  assert.equal(at(written.at(-1), "id"), 9);
});

await test("plumb lsp publishes a real check over stdio and exits when told to", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plumb-lsp-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "plumb.json"),
    JSON.stringify({ schemaVersion: 1, preset: "portable", files: { forbidden: ["**/*.orig"] } }),
  );
  writeFileSync(join(root, "a.orig"), "x\n");
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/plumb.ts", import.meta.url)), "lsp", "--root", root],
    {
      encoding: "utf8",
      input: [
        frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        notify("initialized"),
        frame({ jsonrpc: "2.0", id: 2, method: "shutdown" }),
        notify("exit"),
      ].join(""),
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout
    .split(/Content-Length: \d+\r\n\r\n/)
    .filter(Boolean)
    .map(parseJson);
  assert.equal(at(replies[0], "result", "serverInfo", "name"), "plumb");
  assert.equal(at(replies[1], "params", "uri"), pathToFileURL(join(root, "a.orig")).href);
  assert.equal(at(replies[1], "params", "diagnostics", 0, "code"), "files.forbidden");
  assert.equal(at(replies[2], "id"), 2);
});
