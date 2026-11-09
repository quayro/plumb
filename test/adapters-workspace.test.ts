import assert from "node:assert/strict";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { CoverageRecord } from "../src/adapter-native.ts";
import { doctorAdapters, type JavascriptPack, planAdapters, runAdapters } from "../src/adapters.ts";
import { definePlumb } from "../src/config.ts";
import type { Execute } from "../src/process.ts";
import { fixture } from "./adapters-support.ts";
import { fakePack } from "./support.ts";

await test("isolated subjects retain the original candidate code boundary", async (t) => {
  const original = fixture(t),
    approved = original.registry();
  const candidateCode = join(original.root, "adapter.mjs");
  writeFileSync(candidateCode, readFileSync(original.script));
  rmSync(original.script);
  symlinkSync(candidateCode, original.script);
  const { ctx } = fixture(t);
  let calls = 0;
  const result = await runAdapters(ctx, planAdapters(ctx, { registry: approved }), {
    registry: approved,
    execute: async () => {
      calls++;
      return { code: 0, stdout: "{}", stderr: "" };
    },
  });
  assert.equal(calls, 0);
  assert.ok(result.diagnostics.some((item) => /outside the candidate/.test(item.message)));
});

await test("checks and doctor reject changes to observed source inputs", async (t) => {
  for (const doctor of [false, true]) {
    const { ctx, registry } = fixture(t);
    const approved = registry(
      "const {writeFileSync} = await import('node:fs'); writeFileSync(resolve(request.root, 'main.py'), 'changed\\n');",
    );
    const result = doctor
      ? await doctorAdapters(ctx, { registry: approved })
      : await runAdapters(ctx, planAdapters(ctx, { registry: approved }), { registry: approved });
    assert.ok(
      result.diagnostics.some(
        (item) => item.status === "incomplete" && /(?:changed|mutated)/i.test(item.message),
      ),
    );
    assert.equal(
      result.checks.some((item) => ["pass", "ready"].includes(item.status)),
      false,
    );
  }
});

await test("doctor probes an external adapter without claiming executed source checks", async (t) => {
  const { ctx, registry } = fixture(t),
    approved = registry();
  const result = await doctorAdapters(ctx, { registry: approved });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.checks[0].status, "ready");
  assert.equal(result.checks[0].evidence, "prerequisites-only");
  const suggestions = await doctorAdapters(
    { ...ctx, config: definePlumb({ schemaVersion: 1, preset: "portable" }) },
    { registry: approved },
  );
  assert.equal(suggestions.suggestions[0].project.profile, "python");
});

await test("native Ruby checks require RuboCop's inspected-file evidence", async (t) => {
  const { ctx } = fixture(
    t,
    { "main.rb": "puts 'ok'\n" },
    { projects: [{ root: ".", profile: "ruby" }] },
  );
  const execute =
    (files: string[]): Execute =>
    async (command) =>
      command.at(-1) === "--version"
        ? { code: 0, stdout: "1.0.0", stderr: "" }
        : {
            code: 0,
            stdout: JSON.stringify({
              files: files.map((path) => ({ path, offenses: [] })),
              summary: { inspected_file_count: files.length },
            }),
            stderr: "",
          };
  const planned = planAdapters(ctx);
  const complete = await runAdapters(ctx, planned, { execute: execute(["main.rb"]) });
  assert.deepEqual(complete.diagnostics, []);
  assert.equal(complete.coverage[0].evidence, "tool-reported");
  const absent = await runAdapters(ctx, planned, { execute: execute([]) });
  assert.ok(absent.diagnostics.some((item) => item.status === "incomplete"));
  const malformed = await runAdapters(ctx, planned, {
    execute: async () => ({ code: 0, stdout: "1.0.0", stderr: "" }),
  });
  assert.ok(malformed.diagnostics.some((item) => item.rule === "adapters.protocol"));
});

await test("C++ coverage identifies explicit translation-unit inputs without claiming header inspection", async (t) => {
  const { ctx, root, write } = fixture(
    t,
    {
      "main.cpp": "int main() {}\n",
      "main.hpp": "",
      ".clang-format-ignore": "# none\n",
      "build/compile_commands.json": "[]",
    },
    { projects: [{ root: ".", profile: "cpp", compileCommands: "build" }] },
  );
  write(
    "build/compile_commands.json",
    JSON.stringify([{ directory: root, file: "main.cpp", arguments: ["c++", "-c", "main.cpp"] }]),
  );
  const result = await runAdapters(ctx, planAdapters(ctx), {
    execute: async (command) => ({
      code: 0,
      stdout: command.at(-1) === "--version" ? "18.1.8" : "",
      stderr: "",
    }),
  });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.coverage.find((item) => item.id === "cpp.lint:.")?.checkedFiles, [
    "main.cpp",
  ]);
  assert.equal(
    result.coverage.every((item) => item.evidence === "explicit-inputs"),
    true,
  );
});

await test("the shared JavaScript contract refuses a pack that omits coverage", async (t) => {
  const { ctx } = fixture(
    t,
    { "main.ts": "export const value = 1;\n" },
    { projects: [{ root: ".", profile: "typescript" }] },
  );
  const planned = planAdapters(ctx);
  const fake = (coverage: CoverageRecord[]) => async (): Promise<JavascriptPack> =>
    fakePack({ check: () => ({ diagnostics: [], coverage }) });
  const missing = await runAdapters(ctx, planned, { loadJavascript: fake([]) });
  assert.ok(missing.diagnostics.some((item) => item.rule === "adapters.coverage"));
  const complete = await runAdapters(ctx, planned, {
    loadJavascript: fake(
      planned.checks.map((check) => ({ id: check.id, checkedFiles: check.files, status: "pass" })),
    ),
  });
  assert.deepEqual(complete.diagnostics, []);
});

await test("coverage outcomes cannot contradict findings or hide an incomplete check", async (t) => {
  const { ctx } = fixture(
    t,
    { "main.ts": "export const value = 1;\n" },
    { projects: [{ root: ".", profile: "typescript" }] },
  );
  const planned = planAdapters(ctx);
  const finding = {
    rule: "javascript/example",
    path: "main.ts",
    message: "source error",
    check: "javascript.lint:.",
  };
  const invoke = (
    rowStatus: string,
    status?: "violation" | "incomplete",
  ): ReturnType<typeof runAdapters> =>
    runAdapters(ctx, planned, {
      loadJavascript: async () =>
        fakePack({
          rules: () => [],
          check: () => ({
            diagnostics: [{ ...finding, ...(status ? { status } : {}) }],
            coverage: planned.checks.map((check) => ({
              id: check.id,
              checkedFiles: check.files,
              status: check.id === finding.check ? rowStatus : "pass",
            })),
          }),
        }),
    });
  const violation = await invoke("pass");
  assert.equal(violation.checks.find((check) => check.id === finding.check)?.status, "violation");
  const incomplete = await invoke("pass", "incomplete");
  assert.equal(incomplete.coverage.find((check) => check.id === finding.check)?.completed, false);
  assert.equal(incomplete.checks.find((check) => check.id === finding.check)?.status, "incomplete");
  const unsupported = await invoke("incomplete");
  assert.ok(
    unsupported.diagnostics.some(
      (item) => item.rule === "adapters.protocol" && item.status === "incomplete",
    ),
  );
  assert.equal(unsupported.coverage.find((check) => check.id === finding.check)?.completed, false);
});

await test("recognized source files without a configured project or adapter are refused under ozmikhail, unless excluded", (t) => {
  const contents = {
    "main.go": "package main\n",
    "tools/run.sh": "echo\n",
    "web/app.vue": "<template />\n",
    "notes.txt": "plain\n",
  };
  const { ctx, registry } = fixture(t, contents, { preset: "ozmikhail", projects: [] });
  const found = planAdapters(ctx, { registry: registry() }).diagnostics.filter(
    (item) => item.rule === "projects.unsupported",
  );
  assert.deepEqual(
    found.map((item) => item.path),
    ["main.go", "tools/run.sh", "web/app.vue"],
  );
  assert.ok(found.every((item) => item.status === "incomplete" && item.suppressible === false));
  const excluded = fixture(t, contents, {
    preset: "ozmikhail",
    projects: [],
    exclude: [{ files: ["tools/**", "web/**"], reason: "vendored tooling" }],
  });
  assert.deepEqual(
    planAdapters(excluded.ctx, { registry: excluded.registry() })
      .diagnostics.filter((item) => item.rule === "projects.unsupported")
      .map((item) => item.path),
    ["main.go"],
  );
  const formatted = fixture(t, contents, {
    preset: "ozmikhail",
    projects: [],
    format: { tools: [{ tool: "shfmt", files: ["tools/**/*.sh"] }] },
    tools: { versions: { shfmt: "3.10.0" } },
  });
  assert.deepEqual(
    planAdapters(formatted.ctx, { registry: formatted.registry() })
      .diagnostics.filter((item) => item.rule === "projects.unsupported")
      .map((item) => item.path),
    ["main.go", "web/app.vue"],
  );
  const portable = fixture(t, contents, { preset: "portable", projects: [] });
  assert.equal(
    planAdapters(portable.ctx, { registry: portable.registry() }).diagnostics.filter(
      (item) => item.rule === "projects.unsupported",
    ).length,
    0,
  );
});
