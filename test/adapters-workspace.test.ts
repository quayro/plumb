import assert from "node:assert/strict";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { CoverageRecord } from "../src/adapter-native.ts";
import { doctorAdapters, type JavascriptPack, planAdapters, runAdapters } from "../src/adapters.ts";
import { definePlumb } from "../src/config.ts";
import { type Execute, run } from "../src/process.ts";
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
      "const {writeFileSync} = await import('node:fs'); writeFileSync(resolve(request.root, 'main.lua'), 'changed\\n');",
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
  const { ctx, registry } = fixture(t, { "main.lua": "print('ok')\n", "tool.py": "print(1)\n" }),
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

await test("native Python checks pass only when each tool reports its explicit inputs", async (t) => {
  const { ctx } = fixture(
    t,
    { "main.py": "print('ok')\n" },
    { projects: [{ root: ".", profile: "python" }] },
  );
  const planned = planAdapters(ctx);
  const passing: Execute = async (command) => ({
    code: 0,
    stdout: command.at(-1) === "--version" ? "1.0.0" : "",
    stderr: "",
  });
  const result = await runAdapters(ctx, planned, { execute: passing });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.coverage.map((item) => item.id).sort(), [
    "python.format:.",
    "python.lint:.",
    "python.types:.",
  ]);
  assert.ok(
    result.coverage.every(
      (item) => item.evidence === "explicit-inputs" && item.checkedFiles.join() === "main.py",
    ),
  );
  // a tool that cannot finish is incomplete, never a pass
  const crashed = await runAdapters(ctx, planned, {
    execute: (command) =>
      command[0] === "mypy"
        ? Promise.resolve({ code: 2, stdout: "", stderr: "mypy crashed" })
        : passing(command),
  });
  assert.ok(crashed.diagnostics.some((item) => item.status === "incomplete"));
  assert.equal(crashed.coverage.find((item) => item.id === "python.types:.")?.status, "incomplete");
});

await test("native Rust coverage names the files rustfmt checked and clippy's project scope", async (t) => {
  const { ctx, root } = fixture(
    t,
    {
      "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
      "src/main.rs": "fn main() {}\n",
    },
    { projects: [{ root: ".", profile: "rust" }] },
  );
  const result = await runAdapters(ctx, planAdapters(ctx), {
    execute: async (command) => {
      if (command.at(-1) === "--version") {
        return { code: 0, stdout: "1.0.0", stderr: "" };
      }
      if (command.includes("fmt")) {
        return { code: 0, stdout: `Formatting ${join(root, "src/main.rs")}\n`, stderr: "" };
      }
      return {
        code: 0,
        stdout: `${JSON.stringify({ reason: "build-finished", success: true })}\n`,
        stderr: "",
      };
    },
  });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.coverage.find((item) => item.id === "rust.format:.")?.checkedFiles, [
    "src/main.rs",
  ]);
  const lint = result.coverage.find((item) => item.id === "rust.lint:.");
  assert.deepEqual(lint?.checkedFiles, []);
  assert.equal(lint?.evidence, "process-exit");
  assert.equal(lint?.status, "pass");
});

await test("a registry adapter named python runs alongside the python tool checks and validates its options", async (t) => {
  const pythonAdapter = {
    id: "python",
    files: ["**/*.py"],
    capabilities: ["syntax"],
    rules: [
      {
        id: "python/syntax",
        description: "Python syntax is valid",
        remedy: "Correct source syntax",
      },
    ],
    optionsSchema: {
      type: "object",
      properties: { level: { enum: ["strict"] } },
      required: ["level"],
      additionalProperties: false,
    },
  };
  const { ctx, registry, script } = fixture(
    t,
    { "main.py": "print('ok')\n" },
    { projects: [{ root: ".", profile: "python", options: { level: "strict" } }] },
  );
  const approved = registry("", pythonAdapter);
  const planned = planAdapters(ctx, { registry: approved });
  assert.deepEqual(planned.diagnostics, []);
  assert.ok(planned.checks.some((item) => item.id === "python.syntax:."));
  assert.ok(planned.checks.some((item) => item.id === "python.types:."));
  // the external adapter's own process runs for real; the python tools are faked
  const execute: Execute = (command, options) =>
    command.includes(script)
      ? run(command, options)
      : Promise.resolve({
          code: 0,
          stdout: command.at(-1) === "--version" ? "1.0.0" : "",
          stderr: "",
        });
  const result = await runAdapters(ctx, planned, { registry: approved, execute });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.coverage.find((item) => item.id === "python.syntax:.")?.status, "pass");
  assert.equal(result.coverage.find((item) => item.id === "python.lint:.")?.status, "pass");
  // options the adapter schema does not accept are refused
  const invalid = fixture(
    t,
    { "main.py": "print('ok')\n" },
    { projects: [{ root: ".", profile: "python", options: { level: "lax" } }] },
  );
  const refused = planAdapters(invalid.ctx, { registry: invalid.registry("", pythonAdapter) });
  assert.ok(refused.diagnostics.some((item) => item.rule === "projects.scope"));
  // without the adapter, a built-in python project takes no options
  const bare = fixture(
    t,
    { "main.py": "print('ok')\n" },
    { projects: [{ root: ".", profile: "python", options: { level: "strict" } }] },
  );
  assert.ok(
    planAdapters(bare.ctx).diagnostics.some((item) =>
      /do not accept external adapter options/.test(item.message),
    ),
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

await test("removed Ruby and C/C++ sources are refused under ozmikhail until a configured adapter or an exclusion covers them", (t) => {
  const contents = {
    "main.cpp": "int main() {}\n",
    "app.rb": "puts 'ok'\n",
    "src/a.c": "int a;\n",
    "src/a.h": "int a;\n",
    "tasks.rake": "task :t\n",
    "lib.gemspec": "Gem::Specification.new\n",
  };
  const unsupportedPaths = (plan: ReturnType<typeof planAdapters>): (string | undefined)[] =>
    plan.diagnostics
      .filter((item) => item.rule === "projects.unsupported")
      .map((item) => item.path);
  const { ctx, registry } = fixture(t, contents, { preset: "ozmikhail", projects: [] });
  assert.deepEqual(unsupportedPaths(planAdapters(ctx, { registry: registry() })), [
    "app.rb",
    "lib.gemspec",
    "main.cpp",
    "src/a.c",
    "src/a.h",
    "tasks.rake",
  ]);
  const rubyAdapter = {
    id: "ruby",
    files: ["**/*.rb"],
    capabilities: ["syntax"],
    rules: [
      { id: "ruby/syntax", description: "Ruby syntax is valid", remedy: "Correct source syntax" },
    ],
  };
  const configured = fixture(t, contents, {
    preset: "ozmikhail",
    projects: [{ root: ".", profile: "ruby" }],
  });
  const approved = unsupportedPaths(
    planAdapters(configured.ctx, { registry: configured.registry("", rubyAdapter) }),
  );
  assert.ok(!approved.includes("app.rb"));
  assert.ok(approved.includes("main.cpp"));
  const excluded = fixture(t, contents, {
    preset: "ozmikhail",
    projects: [],
    exclude: [
      {
        files: ["**/*.c", "**/*.h", "**/*.cpp", "*.rb", "*.rake", "*.gemspec"],
        reason: "vendored",
      },
    ],
  });
  assert.deepEqual(
    unsupportedPaths(planAdapters(excluded.ctx, { registry: excluded.registry() })),
    [],
  );
});
