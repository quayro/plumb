import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Config } from "../src/config.ts";
import { parseJUnit } from "../src/junit.ts";
import { parseVerification, verifySuites } from "../src/verification.ts";
import { policy } from "./support.ts";

type Suites = NonNullable<Config["verification"]>;

function fixture(
  t: TestContext,
  files: Record<string, string>,
  verification: Suites,
): Parameters<typeof verifySuites>[0] {
  const parent = process.env.PLUMB_TEST_TMP ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "verification-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return {
    root,
    // suites stay as written so a test can hand the runner a malformed one; the rest is a valid policy
    config: { ...policy(), verification },
    allFiles: Object.keys(files),
  };
}

const json = (tests: readonly unknown[], suite = "unit"): string =>
  JSON.stringify({ schemaVersion: 1, suite, tests });

const command = (body: string): string[] => [process.execPath, "--input-type=module", "-e", body];

const row = (status: string, id = status): { id: string; status: string } => ({ id, status });

await test("JUnit reports retain real failures/skips and reject contradictory or unsupported evidence", () => {
  const text =
    '<?xml version="1.0"?><testsuites tests="3" failures="1"><testsuite name="unit" tests="3" failures="1" skipped="1"><testcase name="pass"/><testcase name="bad"><failure message="a &lt; b"><![CDATA[details]]></failure></testcase><testcase name="skip"><skipped/></testcase></testsuite></testsuites>';
  assert.deepEqual(
    parseJUnit(text).map((test) => test.status),
    ["passed", "failed", "skipped"],
  );
  assert.equal(parseJUnit(text)[1].message, "a < b");
  for (const invalid of [
    text.replace('tests="3"', 'tests="0"'),
    text.replace('failures="1"', 'failures="0"'),
    "<!DOCTYPE x><testsuite/>",
    '<testsuite><testcase name="a"></testsuite>',
    '<testsuite><testcase name="a" status="unknown"/></testsuite>',
    '<testsuite><testcase name="a"><failure/><skipped/></testcase></testsuite>',
    '<testsuite><testcase name="a">&unknown;</testcase></testsuite>',
  ]) {
    assert.throws(() => parseJUnit(invalid));
  }
});

await test("JSON suite reports reject wrong identities, duplicate cases and invented statuses", () => {
  assert.deepEqual(parseVerification(json([row("passed")]), "plumb-json", "unit"), [row("passed")]);
  for (const source of [
    json([row("passed")], "other"),
    json([row("passed", "same"), row("passed", "same")]),
    json([row("ignored")]),
    '{"schemaVersion":1,"suite":"unit","tests":[],"passed":true}',
  ]) {
    assert.throws(() => parseVerification(source, "plumb-json", "unit"));
  }
});

await test("real Node tests execute in an isolated source snapshot and produce named JUnit evidence", async (t) => {
  const ctx = fixture(
    t,
    {
      "case.test.mjs":
        'import test from "node:test"; import assert from "node:assert/strict"; test("behavior", () => assert.equal(2 + 2, 4));\n',
    },
    [
      {
        id: "unit",
        command: [process.execPath, "--test", "--test-reporter=junit", "case.test.mjs"],
        format: "junit",
      },
    ],
  );
  const subject = { kind: "worktree", sha256: "source-identity" };
  const result = await verifySuites(ctx, { subject });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.results[0].status, "pass");
  assert.equal(result.results[0].passed, 1);
  assert.deepEqual(result.results[0].subject, subject);
  assert.match(result.results[0]?.reportSha256 ?? "", /^[a-f0-9]{64}$/);
});

await test("successful empty commands, stale/malformed reports and skipped-only suites cannot pass", async (t) => {
  const cases: Omit<Suites[number], "id">[] = [
    { command: command(""), format: "plumb-json" },
    { command: command(`process.stdout.write(${JSON.stringify(json([]))})`), format: "plumb-json" },
    {
      command: command(`process.stdout.write(${JSON.stringify(json([row("skipped")]))})`),
      format: "plumb-json",
      maxSkipped: 10,
    },
    { command: command(""), format: "plumb-json", report: "file" },
    {
      command: command(
        `process.stdout.write(${JSON.stringify(json([row("passed")]))}); process.exitCode=1`,
      ),
      format: "plumb-json",
    },
  ];
  for (const suite of cases) {
    const result = await verifySuites(
      fixture(t, { "source.txt": "unchanged" }, [{ id: "unit", ...suite }]),
    );
    assert.equal(result.results[0].status, "incomplete", JSON.stringify(result));
    assert.equal(result.diagnostics[0].suppressible, false);
  }
});

await test("test failures and excess skips are explicit violations, including zero-exit failed reports", async (t) => {
  for (const [tests, expected] of [
    [[row("failed")], "verification.failed"],
    [[row("passed"), row("skipped")], "verification.skipped"],
  ] as const) {
    const ctx = fixture(t, { "source.txt": "unchanged" }, [
      {
        id: "unit",
        command: command(`process.stdout.write(${JSON.stringify(json(tests))})`),
        format: "plumb-json",
      },
    ]);
    const result = await verifySuites(ctx);
    assert.equal(result.results[0].status, "violation");
    assert.equal(result.diagnostics[0].rule, expected);
  }
});

await test("tests may write fresh external artifacts but cannot mutate checked source or inherit undeclared environment", async (t) => {
  const old = process.env.PLUMB_TEST_SECRET;
  process.env.PLUMB_TEST_SECRET = "must-not-leak";
  t.after(() => {
    if (old === undefined) {
      delete process.env.PLUMB_TEST_SECRET;
    } else {
      process.env.PLUMB_TEST_SECRET = old;
    }
  });
  const report = json([row("passed")]);
  const body = `import {writeFileSync} from 'node:fs'; if(process.env.PLUMB_TEST_SECRET) throw Error('leaked'); writeFileSync(process.env.PLUMB_REPORT,${JSON.stringify(report)});`;
  const ctx = fixture(t, { "source.txt": "original" }, [
    { id: "unit", command: command(body), format: "plumb-json", report: "file" },
  ]);
  assert.equal((await verifySuites(ctx)).results[0].status, "pass");
  const [suite] = ctx.config.verification ?? [];
  assert.ok(suite);
  suite.command = command(body + "writeFileSync('source.txt','changed');");
  const result = await verifySuites(ctx);
  assert.equal(result.results[0].status, "incomplete");
  assert.match(result.diagnostics[0].message, /changed checked source/);
  assert.equal(readFileSync(join(ctx.root, "source.txt"), "utf8"), "original");
});
