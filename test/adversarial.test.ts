import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { JavascriptPack } from "../src/adapters.ts";
import { definePlumb } from "../src/config.ts";
import type { Context } from "../src/context.ts";
import { checkRepository, context } from "../src/engine.ts";
import { safePath } from "../src/files.ts";
import { type Execute, executeSteps } from "../src/process.ts";
import { at } from "../src/schema.ts";
import { fakePack } from "./support.ts";

const policy = { schemaVersion: 1, preset: "portable", javascript: {} };

async function fixture(
  contents: Record<string, string>,
  verify: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-adversarial-test-"));
  try {
    for (const [path, content] of Object.entries(contents)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    await verify(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type Action = (ctx: Context) => unknown;

const actingPack = (action: Action) => async (): Promise<JavascriptPack> =>
  fakePack({
    check: async (ctx) => {
      await action(ctx);
      return { diagnostics: [] };
    },
  });

const observingPack = (action: Action) => async (): Promise<JavascriptPack> =>
  fakePack({
    check: async (ctx, plan) => {
      await action(ctx);
      return {
        diagnostics: [],
        coverage: plan.map((entry) => ({
          id: entry.id,
          checkedFiles: entry.files,
          status: "pass",
        })),
      };
    },
  });

await test("a newly created unsafe path cannot disappear from post-check verification", async () => {
  await fixture(
    { "plumb.json": JSON.stringify(policy), "data.txt": "original" },
    async (root: string) => {
      const result = await checkRepository({
        root,
        loadJavascript: actingPack(() =>
          symlinkSync(join(root, "data.txt"), join(root, "new-link")),
        ),
      });
      assert.equal(result.status, "incomplete");
      assert.ok(
        result.diagnostics.some(({ rule }) => ["run.mutated", "inventory.unsafe"].includes(rule)),
      );
    },
  );
});

await test("the candidate policy remains protected from tool mutations", async () => {
  await fixture(
    { "plumb.json": JSON.stringify(policy), "data.txt": "original" },
    async (root: string) => {
      const result = await checkRepository({
        root,
        loadJavascript: actingPack(() =>
          writeFileSync(join(root, "plumb.json"), '{"schemaVersion":1,"preset":"portable"}'),
        ),
      });
      assert.equal(result.status, "incomplete");
      assert.ok(result.diagnostics.some(({ rule }) => rule === "run.mutated"));
    },
  );
});

await test("compiler reads bind dependency bytes and missing resolution probes to run identity", async () => {
  await fixture(
    {
      "plumb.json": JSON.stringify(policy),
      "src/index.ts": "export const value = 1;",
      "node_modules/example/index.d.ts": "export const value: number;",
    },
    async (root: string) => {
      const inspect = observingPack((ctx: Context) => {
        assert.equal(
          ctx.readCompilerInput("node_modules/example/index.d.ts"),
          "export const value: number;",
        );
        assert.equal(
          ctx.readCompilerInput("node_modules/example/missing.d.ts", { allowMissing: true }),
          null,
        );
      });
      const first = await checkRepository({ root, loadJavascript: inspect });
      assert.equal(first.exitCode, 0, JSON.stringify(first.diagnostics));
      assert.match(String(at(first.identity, "compilerInputs")), /^[a-f0-9]{64}$/);
      writeFileSync(join(root, "node_modules/example/index.d.ts"), "export const value: string;");
      const second = await checkRepository({
        root,
        loadJavascript: observingPack((ctx: Context) => {
          ctx.readCompilerInput("node_modules/example/index.d.ts");
          ctx.readCompilerInput("node_modules/example/missing.d.ts", { allowMissing: true });
        }),
      });
      assert.equal(second.exitCode, 0);
      assert.notEqual(at(first.identity, "compilerInputs"), at(second.identity, "compilerInputs"));
    },
  );
});

await test("changed compiler inputs and newly appearing dependency paths invalidate the same run", async () => {
  for (const missing of [false, true]) {
    await fixture(
      {
        "plumb.json": JSON.stringify(policy),
        "src/index.ts": "export const value = 1;",
        "node_modules/example/index.d.ts": "export const value: number;",
      },
      async (root: string) => {
        const path = `node_modules/example/${missing ? "new" : "index"}.d.ts`;
        const result = await checkRepository({
          root,
          loadJavascript: observingPack((ctx: Context) => {
            ctx.readCompilerInput(path, { allowMissing: true });
            writeFileSync(join(root, path), "export const changed: string;");
          }),
        });
        assert.equal(result.exitCode, 2);
        assert.ok(result.diagnostics.some((item) => item.rule === "run.mutated"));
      },
    );
  }
});

await test("compiler directory observations catch dependency inventory drift", async () => {
  await fixture(
    {
      "plumb.json": JSON.stringify(policy),
      "src/index.ts": "export const value = 1;",
      "node_modules/example/index.d.ts": "export const value: number;",
    },
    async (root: string) => {
      const result = await checkRepository({
        root,
        loadJavascript: observingPack((ctx: Context) => {
          assert.deepEqual(ctx.readCompilerDirectory("node_modules/example"), [
            { name: "index.d.ts", kind: "file" },
          ]);
          assert.equal(
            ctx.readCompilerDirectory("node_modules/absent", { allowMissing: true }),
            null,
          );
          writeFileSync(join(root, "node_modules/example/new.d.ts"), "export const other: number;");
        }),
      });
      assert.equal(result.exitCode, 2);
      assert.ok(result.diagnostics.some((item) => item.rule === "run.mutated"));
    },
  );
});

await test("compiler readers allow dependency inputs without widening ordinary source or metadata access", async () => {
  await fixture(
    { "plumb.json": JSON.stringify(policy), "node_modules/example/index.d.ts": "export {};" },
    async (root: string) => {
      const ctx = context({ root });
      assert.throws(() => ctx.read("node_modules/example/index.d.ts"), /Reserved/);
      assert.throws(() => ctx.readCompilerInput("../escape", { allowMissing: true }), /escapes/);
      assert.throws(() => ctx.readCompilerInput(".git/config", { allowMissing: true }), /Reserved/);
      if (process.platform !== "win32") {
        symlinkSync(join(root, "plumb.json"), join(root, "node_modules/example/link.json"));
        assert.throws(() => ctx.readCompilerInput("node_modules/example/link.json"), /Symbolic/);
      }
    },
  );
});

await test("an external approved policy remains protected from tool mutations", async () => {
  await fixture(
    { "approved.json": JSON.stringify(policy), "candidate/data.txt": "original" },
    async (root: string) => {
      const approved = join(root, "approved.json");
      const result = await checkRepository({
        root: join(root, "candidate"),
        policy: approved,
        loadJavascript: actingPack(() =>
          writeFileSync(approved, '{"schemaVersion":1,"preset":"portable"}'),
        ),
      });
      assert.equal(result.status, "incomplete");
      assert.ok(result.diagnostics.some(({ rule }) => rule === "run.mutated"));
    },
  );
});

await test("tool versions are probed for distinct project environments", async () => {
  const ctx = { root: ".", config: { tools: { versions: { ruff: "1.0.0" } } } };
  const steps = ["one", "two"].map((name) => ({
    id: `python.lint:${name}`,
    rule: "python.lint",
    tool: "ruff",
    cwd: name,
    command: ["ruff", "check"],
    versionCommand: ["ruff", "--version"],
  }));
  const ran: (string | undefined)[] = [];
  const execute: Execute = async (command, { cwd } = {}) => {
    if (command.at(-1) === "--version") {
      return { code: 0, stdout: cwd === "one" ? "1.0.0" : "2.0.0", stderr: "" };
    }
    ran.push(cwd);
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await executeSteps(ctx, steps, execute);
  assert.ok(result.diagnostics.some(({ rule }) => rule === "tools.version"));
  assert.deepEqual(ran, ["one"]);
});

await test("a mismatched cached version cannot allow a later tool invocation", async () => {
  const ctx = { root: ".", config: { tools: { versions: { ruff: "1.0.0" } } } };
  const steps = ["one", "two"].map((id) => ({
    id,
    rule: "python.lint",
    tool: "ruff",
    cwd: ".",
    command: ["ruff", "format"],
    versionCommand: ["ruff", "--version"],
  }));
  let ran = 0;
  const result = await executeSteps(ctx, steps, async (command) => {
    if (command.at(-1) === "--version") {
      return { code: 0, stdout: "2.0.0", stderr: "" };
    }
    ran++;
    return { code: 0, stdout: "", stderr: "" };
  });
  assert.ok(result.diagnostics.some(({ rule }) => rule === "tools.version"));
  assert.equal(ran, 0);
});

await test("an unobserved tool version pin cannot silently pass", async () => {
  await fixture(
    {
      "plumb.json": JSON.stringify({
        schemaVersion: 1,
        preset: "portable",
        tools: { versions: { typoed_tool_name: "1.0.0" } },
      }),
    },
    async (root: string) => {
      const result = await checkRepository({ root });
      assert.equal(result.status, "incomplete");
      assert.ok(
        result.diagnostics.some(({ rule }) =>
          ["config.invalid", "tools.version", "tools.missing"].includes(rule),
        ),
      );
    },
  );
});

await test("snapshot destinations cannot overwrite source or repository metadata", () => {
  for (const snapshot of [
    "src/main.ts",
    "package.json",
    ".git/api.surface.json",
    "node_modules/api.surface.json",
  ]) {
    assert.throws(
      () =>
        definePlumb({
          schemaVersion: 1,
          projects: [{ root: ".", profile: "typescript", surface: { snapshot } }],
        }),
      /snapshot|surface|reserved|metadata|inside/i,
      snapshot,
    );
  }
  assert.doesNotThrow(() =>
    definePlumb({
      schemaVersion: 1,
      projects: [{ root: ".", profile: "typescript", surface: { snapshot: "api.surface.json" } }],
    }),
  );
});

await test("safePath excludes repository metadata even when the directory exists", async () => {
  await fixture(
    { ".git/config": "untouched", "node_modules/tool.js": "untouched" },
    async (root: string) => {
      assert.throws(() => safePath(root, ".git/config"), /reserved|metadata|unsupported/i);
      assert.throws(() => safePath(root, "node_modules/tool.js"), /reserved|metadata|unsupported/i);
      assert.equal(readFileSync(join(root, ".git/config"), "utf8"), "untouched");
    },
  );
});

await test("native command configuration errors are incomplete rather than violations", async () => {
  const result = await executeSteps(
    { root: ".", config: {} },
    [{ id: "python.lint:.", rule: "python.lint", command: ["ruff"], cwd: "." }],
    async () => ({ code: 2, stdout: "", stderr: "unknown option" }),
  );
  assert.equal(result.checks[0].status, "incomplete");
  assert.equal(result.diagnostics[0].rule, "python.lint");
});
