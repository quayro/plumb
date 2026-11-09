import assert from "node:assert/strict";
import test from "node:test";

import { definePlumb } from "../src/config.ts";
import { at } from "../src/schema.ts";
import { classes, cli, json, rawPolicy, repository, write } from "./ratchet-support.ts";
import { parseJson, parseReport } from "./support.ts";

const NO_TOKEN = {
  id: "no-token",
  files: ["src/**"],
  forbid: "SECRET_[A-Z]+",
  reason: "Credentials stay out of source.",
};

const fixture = (rules: unknown[], files: Record<string, string>, extra = {}): string =>
  repository({ "plumb.json": json(rawPolicy({ rules, ...extra })), ...files });

const check = async (root: string, ...args: string[]) => {
  const { code, text } = await cli(["check", "--root", root, ...args]);
  return { code, result: parseReport(text) };
};

await test("a forbidden pattern fails on its line and a clean file passes", async () => {
  const root = fixture([NO_TOKEN], { "src/a.txt": "ok\nuse SECRET_KEY here\n" }),
    failed = await check(root);
  assert.equal(failed.code, 1);
  assert.deepEqual(
    failed.result.diagnostics.map((item) => [item.rule, item.path, item.line, item.remedy]),
    [
      [
        "custom.no-token",
        "src/a.txt",
        2,
        "Change the file to satisfy the rule; the rule changes only by review.",
      ],
    ],
  );
  write(root, { "src/a.txt": "ok\n" });
  assert.equal((await check(root)).code, 0);
});

await test("a required pattern and a document mention are both enforced", async () => {
  const rules = [
    {
      id: "licensed",
      files: ["src/*.txt"],
      require: "^Copyright",
      reason: "Sources are licensed.",
    },
    {
      id: "documented",
      files: ["commands/*.txt"],
      mentionedIn: "README.md",
      reason: "Every command is documented.",
      remedy: "Describe the command in README.md.",
    },
  ];
  const root = fixture(rules, {
    "src/a.txt": "Copyright me\n",
    "src/b.txt": "no header\n",
    "commands/build.txt": "x\n",
    "commands/ship.txt": "x\n",
    // a longer word that merely contains the name is not a mention
    "README.md": "Run `build`. Read about shipping and ship-it.\n",
  });
  const { code, result } = await check(root);
  assert.equal(code, 1);
  assert.deepEqual(
    result.diagnostics.map((item) => [item.rule, item.path, item.remedy]),
    [
      ["custom.documented", "commands/ship.txt", "Describe the command in README.md."],
      [
        "custom.licensed",
        "src/b.txt",
        "Change the file to satisfy the rule; the rule changes only by review.",
      ],
    ],
  );
});

await test("a rule that cannot see its subject is incomplete, never a pass", async () => {
  const rules = [
    { ...NO_TOKEN, files: ["missing/**"] },
    { id: "documented", files: ["src/*.txt"], mentionedIn: "GONE.md", reason: "Documented." },
  ];
  const { code, result } = await check(fixture(rules, { "src/a.txt": "x\n" }));
  assert.equal(code, 2);
  assert.deepEqual(
    result.diagnostics.map((item) => [item.rule, item.status]),
    [
      ["rules.scope", "incomplete"],
      ["rules.scope", "incomplete"],
    ],
  );
});

await test("custom rules take budgeted exceptions; their fixed rules and unknown ids do not", async () => {
  const exception = (rule: string) => ({
    id: "legacy",
    rules: [rule],
    files: ["src/a.txt"],
    reason: "predates the rule",
    max: 1,
  });
  const files = { "src/a.txt": "SECRET_KEY\n" };
  const budgeted = await check(
    fixture([NO_TOKEN], files, { exceptions: [exception("custom.no-token")] }),
  );
  assert.equal(budgeted.code, 0);
  assert.equal(budgeted.result.suppressed?.length, 1);
  for (const rule of ["custom.other", "rules.scope"]) {
    const refused = await check(fixture([NO_TOKEN], files, { exceptions: [exception(rule)] }));
    assert.equal(refused.code, 1);
    assert.ok(refused.result.diagnostics.some((item) => item.rule === "exceptions.invalid"));
  }
});

await test("a coupled change needs its companion change against the base", async () => {
  const rules = [
    {
      id: "migrated",
      files: ["db/schema.sql"],
      changesWith: ["db/migrations/*.sql"],
      reason: "A schema change ships with its migration.",
    },
  ];
  const root = fixture(rules, { "db/schema.sql": "a\n", "db/migrations/1.sql": "a\n" });
  // nothing changed, and without a base nothing is compared
  assert.equal((await check(root, "--base", "HEAD")).code, 0);
  write(root, { "db/schema.sql": "b\n" });
  assert.equal((await check(root)).code, 0);
  const failed = await check(root, "--base", "HEAD");
  assert.equal(failed.code, 1);
  assert.deepEqual(
    failed.result.diagnostics.map((item) => [item.rule, item.path]),
    [["custom.migrated", "db/schema.sql"]],
  );
  // touching an unrelated file is not the companion change; a new, untracked migration is
  write(root, { "db/notes.sql": "x\n" });
  assert.equal((await check(root, "--base", "HEAD")).code, 1);
  write(root, { "db/migrations/2.sql": "b\n" });
  assert.equal((await check(root, "--base", "HEAD")).code, 0);
});

await test("explain and inspect know a policy's own rules", async () => {
  const root = fixture([NO_TOKEN], { "src/a.txt": "ok\n" }),
    explained = await cli(["explain", "custom.no-token", "--root", root]);
  assert.equal(explained.code, 0);
  assert.equal(
    at(parseJson(explained.text), "rule", "description"),
    "Credentials stay out of source.",
  );
  const inspected = parseJson((await cli(["inspect", "--root", root, "--file", "src/a.txt"])).text);
  assert.deepEqual(at(inspected, "file", "checks"), ["files", "rules"]);
});

await test("rules need an assertion and unique ids, and only ever tighten by addition", () => {
  const define = (rules: unknown[]) => () => definePlumb(rawPolicy({ rules }));
  assert.throws(define([{ id: "empty", files: ["**"], reason: "nothing to check" }]), /needs one/);
  assert.throws(define([NO_TOKEN, { ...NO_TOKEN, forbid: "x" }]), /Duplicate rule no-token/);
  assert.throws(define([{ ...NO_TOKEN, forbid: "(" }]), TypeError);
  assert.deepEqual(classes({}, { rules: [NO_TOKEN] }), ["tighten /rules/0"]);
  assert.deepEqual(classes({ rules: [NO_TOKEN] }, {}), ["weaken /rules/0"]);
});
