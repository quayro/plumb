import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { context } from "../src/engine.ts";
import { checkFormatTools, formatToolFiles, formatToolSteps } from "../src/format-tools.ts";
import type { Execute, RunResult } from "../src/process.ts";

function repo(
  t: TestContext,
  format: unknown,
  files: Record<string, string>,
  tools?: unknown,
): ReturnType<typeof context> {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "format-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const all = {
    "plumb.json": JSON.stringify({
      schemaVersion: 1,
      preset: "portable",
      format,
      ...(tools ? { tools } : {}),
    }),
    ...files,
  };
  for (const [path, value] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  }
  return context({ root });
}

const fake = (
  codes: Record<string, RunResult> = {},
  versions: Record<string, RunResult> = {},
): { calls: (readonly string[])[]; execute: Execute } => {
  const calls: (readonly string[])[] = [];
  const execute: Execute = async (command) => {
    calls.push(command);
    const tool = command[0]?.split("/").at(-1) ?? "";
    if (command.at(-1) === "--version") {
      return versions[tool] ?? { code: 0, stdout: `${tool} 1.0.0`, stderr: "" };
    }
    return codes[tool] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { calls, execute };
};

const FILES = {
  "db/schema/a.prisma": "",
  "db/schema/b.prisma": "",
  "scripts/x.sh": "",
  ".githooks/pre-commit": "",
  "sql/q.sql": "",
  "sql/old/m.sql": "",
  "Cargo.toml": "",
};
const TOOLS = [
  { tool: "prisma", files: ["**/*.prisma"] },
  { tool: "shfmt", files: ["**/*.sh", ".githooks/*"] },
  { tool: "sql-formatter", files: ["sql/**/*.sql"] },
  { tool: "taplo", files: ["**/*.toml"] },
];

await test("each tool builds its check and fix commands for the selected files only", (t) => {
  const ctx = repo(
    t,
    { tools: TOOLS, ignore: [{ path: "sql/old/**", reason: "deployed migrations" }] },
    FILES,
    { versions: { prisma: "1.0.0", shfmt: "1.0.0", "sql-formatter": "1.0.0", taplo: "1.0.0" } },
  );
  const bin = (tool: string): string => tool;
  const commands = (mode: string): unknown[][] =>
    formatToolSteps(ctx, mode, { resolve: bin }).map((step) => [step.rule, step.command]);
  assert.deepEqual(commands("check"), [
    ["format.prisma", ["prisma", "format", "--check", "--schema", "./db/schema"]],
    ["format.shell", ["shfmt", "-i", "2", "-d", "./.githooks/pre-commit", "./scripts/x.sh"]],
    ["format.sql", ["sql-formatter", "--language", "postgresql", "./sql/q.sql"]],
    ["format.toml", ["taplo", "fmt", "--check", "./Cargo.toml"]],
  ]);
  assert.deepEqual(commands("fix"), [
    ["format.prisma", ["prisma", "format", "--schema", "./db/schema"]],
    ["format.shell", ["shfmt", "-i", "2", "-w", "./.githooks/pre-commit", "./scripts/x.sh"]],
    ["format.sql", ["sql-formatter", "--language", "postgresql", "--fix", "./sql/q.sql"]],
    ["format.toml", ["taplo", "fmt", "./Cargo.toml"]],
  ]);
  assert.ok(!formatToolFiles(ctx).includes("sql/old/m.sql"));
  const prisma = formatToolSteps(ctx, "check", { resolve: bin })[0];
  assert.equal(prisma?.env?.CHECKPOINT_DISABLE, "1");
});

await test("an entry that matches nothing is incomplete, never a silent pass", async (t) => {
  const ctx = repo(t, { tools: [{ tool: "taplo", files: ["**/*.toml"] }] }, { "a.txt": "" });
  const { diagnostics } = await checkFormatTools(ctx, fake().execute);
  assert.deepEqual(
    diagnostics.map(({ rule, status }) => [rule, status]),
    [["format.toml", "incomplete"]],
  );
  assert.match(diagnostics[0].message, /matches no selected files/);
});

await test("exit 1 is a violation and a parse failure or spawn error is incomplete", async (t) => {
  const ctx = repo(
    t,
    {
      tools: [
        { tool: "shfmt", files: ["**/*.sh"] },
        { tool: "taplo", files: ["**/*.toml"] },
      ],
    },
    { "a.sh": "", "a.toml": "" },
    { versions: { shfmt: "1.0.0", taplo: "1.0.0" } },
  );
  const { diagnostics } = await checkFormatTools(
    ctx,
    fake({
      shfmt: { code: 1, stdout: "@@ -1 +1 @@\n", stderr: "" },
      taplo: { code: 2, stdout: "", stderr: "parse error" },
    }).execute,
  );
  assert.deepEqual(
    diagnostics.map(({ rule, status, check }) => [rule, status, check]),
    [
      ["format.shell", "violation", "format-tools"],
      ["format.toml", "incomplete", "format-tools"],
    ],
  );
  const spawned = await checkFormatTools(
    ctx,
    fake({ shfmt: { code: null, stdout: "", stderr: "", error: "spawn ENOENT" } }).execute,
  );
  assert.equal(
    spawned.diagnostics.find((item) => item.rule === "format.shell")?.status,
    "incomplete",
  );
});

await test("a missing tool or an unpinned version is refused", async (t) => {
  const ctx = repo(
    t,
    { tools: [{ tool: "shfmt", files: ["**/*.sh"] }] },
    { "a.sh": "" },
    { versions: { shfmt: "3.10.0" } },
  );
  const missing = await checkFormatTools(
    ctx,
    fake({}, { shfmt: { code: null, stdout: "", stderr: "", error: "spawn ENOENT" } }).execute,
  );
  assert.deepEqual(
    missing.diagnostics.map(({ rule }) => rule),
    ["tools.missing"],
  );
  const wrong = await checkFormatTools(
    ctx,
    fake({}, { shfmt: { code: 0, stdout: "v3.9.0", stderr: "" } }).execute,
  );
  assert.deepEqual(
    wrong.diagnostics.map(({ rule }) => rule),
    ["tools.version"],
  );
  const right = await checkFormatTools(
    ctx,
    fake({}, { shfmt: { code: 0, stdout: "v3.10.0", stderr: "" } }).execute,
  );
  assert.deepEqual(right.diagnostics, []);
  assert.equal(right.versions.shfmt, "v3.10.0");
});

await test("binaries resolve from PATH first, then the repository's node_modules/.bin", (t) => {
  const ctx = repo(
    t,
    { tools: [{ tool: "prisma", files: ["**/*.prisma"] }] },
    { "s.prisma": "", "node_modules/.bin/prisma": "#!/bin/sh\n" },
    { versions: { prisma: "1.0.0" } },
  );
  const onPath = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "path-"));
  t.after(() => rmSync(onPath, { recursive: true, force: true }));
  writeFileSync(join(onPath, "prisma"), "#!/bin/sh\n");
  chmodSync(join(onPath, "prisma"), 0o755);
  assert.equal(
    formatToolSteps(ctx, "check", { path: onPath })[0].command[0],
    join(onPath, "prisma"),
  );
  assert.equal(
    formatToolSteps(ctx, "check", { path: "" })[0].command[0],
    join(ctx.root, "node_modules/.bin/prisma"),
  );
});

await test("an entry whose tool has no pinned version is refused before it runs", async (t) => {
  const ctx = repo(t, { tools: [{ tool: "shfmt", files: ["**/*.sh"] }] }, { "a.sh": "" });
  const probe = fake();
  const { diagnostics } = await checkFormatTools(ctx, probe.execute);
  assert.deepEqual(
    diagnostics.map(({ rule, status }) => [rule, status]),
    [["tools.version", "incomplete"]],
  );
  assert.deepEqual(probe.calls, []);
});

await test("exit 1 is a violation only when the output shows a formatting difference", async (t) => {
  const ctx = repo(
    t,
    { tools: [{ tool: "shfmt", files: ["**/*.sh"] }] },
    { "a.sh": "" },
    { versions: { shfmt: "1.0.0" } },
  );
  const parse = await checkFormatTools(
    ctx,
    fake({ shfmt: { code: 1, stdout: "", stderr: "a.sh:1:4: reached EOF without closing quote" } })
      .execute,
  );
  assert.deepEqual(
    parse.diagnostics.map(({ rule, status }) => [rule, status]),
    [["format.shell", "incomplete"]],
  );
  const diff = await checkFormatTools(
    ctx,
    fake({
      shfmt: { code: 1, stdout: "--- a.sh.orig\n+++ a.sh\n@@ -1 +1 @@\n-x\n+y\n", stderr: "" },
    }).execute,
  );
  assert.deepEqual(
    diff.diagnostics.map(({ rule, status }) => [rule, status]),
    [["format.shell", "violation"]],
  );
});

await test("a prisma folder holding an ignored or excluded schema file is refused rather than formatted", async (t) => {
  const ctx = repo(
    t,
    {
      tools: [{ tool: "prisma", files: ["**/*.prisma"] }],
      ignore: [{ path: "db/legacy.prisma", reason: "frozen" }],
    },
    { "db/a.prisma": "", "db/legacy.prisma": "" },
    { versions: { prisma: "1.0.0" } },
  );
  assert.deepEqual(formatToolSteps(ctx, "fix", { resolve: (tool) => tool }), []);
  const { diagnostics } = await checkFormatTools(ctx, fake().execute);
  assert.deepEqual(
    diagnostics.map(({ rule, status }) => [rule, status]),
    [["format.prisma", "incomplete"]],
  );
});

await test("sql-formatter check compares its printed output with the file, since it has no --check", async (t) => {
  const tools = { versions: { "sql-formatter": "1.0.0" } };
  const ctx = repo(
    t,
    { tools: [{ tool: "sql-formatter", files: ["*.sql"] }] },
    { "q.sql": "SELECT\n  1;\n" },
    tools,
  );
  const outcome = async (stdout: string, code = 0): Promise<unknown[][]> =>
    (
      await checkFormatTools(ctx, fake({ "sql-formatter": { code, stdout, stderr: "" } }).execute)
    ).diagnostics.map(({ rule, status, message }) => [rule, status, message]);
  assert.deepEqual(await outcome("SELECT\n  1;\n"), []);
  assert.deepEqual(await outcome("SELECT\n  2;\n"), [
    ["format.sql", "violation", "format.sql: q.sql would be reformatted"],
  ]);
  assert.equal((await outcome("", 1))[0]?.[1], "incomplete");
});
