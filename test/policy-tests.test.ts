import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { main } from "../src/cli.ts";
import { definePlumb } from "../src/config.ts";
import type { Report } from "../src/diagnostics.ts";
import { checkRepository, context, testPolicy } from "../src/engine.ts";
import { runPolicyTests } from "../src/policy-tests.ts";
import { at } from "../src/schema.ts";
import { mapped, parseJson } from "./support.ts";

interface Edit {
  path: string;
  content?: string;
  delete?: boolean;
}

interface Expected {
  rule: string;
  path?: string;
  count?: number;
}

interface Case {
  id: string;
  edits: [Edit, ...Edit[]];
  expect: { status: string; diagnostics?: Expected[] };
}

interface Group {
  id: string;
  files: [{ path: string; content: string }];
  cases: [Case, Case, ...Case[]];
}

interface Value {
  schemaVersion: number;
  preset: string;
  files?: unknown;
  policyTests: [Group, ...Group[]];
}

const group = (): Group => ({
  id: "naming",
  files: [{ path: "src/good.txt", content: "one\n" }],
  cases: [
    {
      id: "bad-name",
      edits: [{ path: "src/Bad.txt", content: "one\n" }],
      expect: { status: "violation", diagnostics: [{ rule: "files.names", path: "src/Bad.txt" }] },
    },
    {
      id: "equivalent-content",
      edits: [{ path: "src/good.txt", content: "two\n" }],
      expect: { status: "pass" },
    },
  ],
});

const policy = (): Value => ({
  schemaVersion: 1,
  preset: "portable",
  files: { names: [{ files: ["src/**"], pattern: "^[a-z]+\\.txt$", reason: "lowercase names" }] },
  policyTests: [group()],
});

const first = (value: Value): Case => value.policyTests[0].cases[0];

const expected = (item: Case): Expected => {
  const [diagnostic] = item.expect.diagnostics ?? [];
  assert.ok(diagnostic);
  return diagnostic;
};

function fixture(t: TestContext, value: unknown = policy()): string {
  const temporary = process.env.PLUMB_TEST_TMP ?? tmpdir();
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, "policy-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/good.txt"), "original\n");
  writeFileSync(join(root, "plumb.json"), JSON.stringify(value));
  return root;
}

await test("actual checker policy tests accept baseline, intended violation and equivalent rewrites", async (t) => {
  const root = fixture(t),
    result = await testPolicy({ root });
  assert.equal(result.exitCode, 0, JSON.stringify(result.diagnostics));
  assert.deepEqual(
    mapped(at(result.policyTests, 0, "cases"), (item) => at(item, "actual")),
    ["pass", "violation", "pass"],
  );
  assert.ok(
    mapped(at(result.policyTests, 0, "cases"), (item) => at(item, "snapshot")).every((item) =>
      /^[a-f0-9]{64}$/.test(String(item)),
    ),
  );
  assert.equal(readFileSync(join(root, "src/good.txt"), "utf8"), "original\n");
  const complete = await checkRepository({ root });
  assert.equal(complete.exitCode, 0, JSON.stringify(complete.diagnostics));
  assert.equal(complete.checks?.find((item) => item.id === "policy-test:naming")?.status, "pass");
});

await test("a passing mutation, wrong diagnostic, extra diagnostic or wrong count cannot prove enforcement", async (t) => {
  for (const edit of [
    (value: Value) => {
      first(value).edits[0].path = "src/valid.txt";
    },
    (value: Value) => {
      expected(first(value)).rule = "files.required";
    },
    (value: Value) => {
      expected(first(value)).count = 2;
    },
    (value: Value) => {
      first(value).edits.push({ path: "src/Other.txt", content: "other" });
    },
  ]) {
    const value = policy();
    edit(value);
    const result = await testPolicy({ root: fixture(t, value) });
    assert.equal(result.exitCode, 1, JSON.stringify(result.diagnostics));
    assert.ok(
      result.diagnostics.some(
        (item) => item.rule === "policy-tests.failed" && item.suppressible === false,
      ),
    );
  }
});

await test("the baseline must pass and missing tools or unreadable fixture inputs stay incomplete", async (t) => {
  const value = policy();
  value.policyTests[0].files[0].path = "src/Bad.txt";
  const baseline = await testPolicy({ root: fixture(t, value) });
  assert.equal(baseline.exitCode, 2);
  assert.match(baseline.diagnostics[0].message, /baseline/);
  const ctx = context({ root: fixture(t) });
  const result = await runPolicyTests(ctx, async (): Promise<Report> => ({
    schemaVersion: 1,
    status: "incomplete",
    exitCode: 2,
    checks: [],
    diagnostics: [{ rule: "tools.missing", path: ".", status: "incomplete", message: "missing" }],
  }));
  assert.equal(result.checks[0]?.status, "incomplete");
  for (const status of ["incomplete", "violation", "unknown"]) {
    const contradictory = await runPolicyTests(ctx, async (): Promise<Report> => ({
      schemaVersion: 1,
      status: "pass",
      exitCode: 0,
      checks: [{ id: "required", status }],
      diagnostics: [],
    }));
    assert.equal(contradictory.checks[0]?.status, "incomplete");
  }
});

await test("policy fixture execution rejects source mutation and starts every case from clean data", async (t) => {
  const ctx = context({ root: fixture(t) });
  const result = await runPolicyTests(ctx, async ({ root }): Promise<Report> => {
    writeFileSync(join(root, "src/good.txt"), "mutated by checker");
    return { schemaVersion: 1, status: "pass", exitCode: 0, checks: [], diagnostics: [] };
  });
  assert.equal(result.checks[0]?.status, "incomplete");
  assert.match(result.diagnostics[0]?.message ?? "", /changed its fixture/);
  const value = policy();
  value.policyTests[0].cases = [
    {
      id: "delete",
      edits: [{ path: "src/good.txt", delete: true }],
      expect: { status: "violation", diagnostics: [{ rule: "files.scope" }] },
    },
    {
      id: "fresh",
      edits: [{ path: "src/good.txt", content: "fresh" }],
      expect: { status: "pass" },
    },
  ];
  const checked = await testPolicy({ root: fixture(t, value) });
  const fresh = mapped(at(checked.policyTests, 0, "cases"), (item) => item).find(
    (item) => at(item, "id") === "fresh",
  );
  assert.equal(at(fresh, "status"), "pass");
});

await test("fixture policy shape refuses ambiguity, overwritten policy and overlapping expectations", () => {
  for (const edit of [
    (value: Value) => {
      first(value).id = "baseline";
    },
    (value: Value) => {
      value.policyTests.push(group());
    },
    (value: Value) => {
      value.policyTests[0].files[0].path = "../escape";
    },
    (value: Value) => {
      value.policyTests[0].files[0].path = "plumb.json";
    },
    (value: Value) => {
      first(value).edits[0].delete = true;
    },
    (value: Value) => {
      first(value).expect.diagnostics?.push({ rule: "files.names" });
    },
    (value: Value) => {
      value.policyTests[0].cases[1].expect.diagnostics = [{ rule: "files.names" }];
    },
    (value: Value) => {
      delete first(value).expect.diagnostics;
    },
  ]) {
    const value = policy();
    edit(value);
    assert.throws(() => definePlumb(value));
  }
});

await test("CLI runs declared policy acceptance tests and refuses an empty test selection", async (t) => {
  let text = "";
  assert.equal(
    await main(["policy-test", "--root", fixture(t), "--format", "json"], (chunk) => {
      text += chunk;
    }),
    0,
  );
  assert.equal(at(parseJson(text), "command"), "policy-test");
  assert.equal(
    (await testPolicy({ root: fixture(t, { schemaVersion: 1, preset: "portable" }) })).exitCode,
    2,
  );
});

await test("fixtures preserve source policy bytes and normalize custom policy paths before guarding edits", async (t) => {
  const root = fixture(t),
    formatted = `${JSON.stringify(policy(), null, 2)}\n`;
  writeFileSync(join(root, "custom.json"), formatted);
  const ctx = context({ root, configFile: "./custom.json" });
  assert.equal(ctx.configFile, "custom.json");
  let observed = false;
  await runPolicyTests(ctx, async (candidate) => {
    assert.equal(readFileSync(join(candidate.root, "custom.json"), "utf8"), formatted);
    observed = true;
    return await checkRepository(candidate);
  });
  assert.equal(observed, true);
  const value = policy();
  first(value).edits = [{ path: "custom.json", content: "{}" }];
  writeFileSync(join(root, "custom.json"), JSON.stringify(value));
  await assert.rejects(
    runPolicyTests(context({ root, configFile: "./custom.json" }), async () => {
      throw new Error("must not execute");
    }),
    /policy-replacing/,
  );
});
