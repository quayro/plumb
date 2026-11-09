import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { main } from "../src/cli.ts";
import { checkMessage, checkRange, normalizeMessage } from "../src/commits.ts";
import { at } from "../src/schema.ts";
import { parseJson, parseReport } from "./support.ts";

const policy = { types: ["feat", "fix", "chore", "revert"], maxLength: 72 };

const rulesOf = (text: string, options: Parameters<typeof checkMessage>[1] = policy): string[] =>
  checkMessage(text, options).map((item) => item.rule);

function repository(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "plumb-commits-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const git = (root: string, ...args: string[]): string => {
  const result = spawnSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Plumb",
      "-c",
      "user.email=plumb@example.test",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function config(root: string, value: Record<string, unknown>): void {
  writeFileSync(
    join(root, "plumb.json"),
    JSON.stringify({ schemaVersion: 1, preset: "portable", ...value }),
  );
}

await test("normalization removes git comments, scissors and trailing blank lines", () => {
  assert.equal(
    normalizeMessage("feat: x\r\n\r\n# comment\r\nbody line\r\n\r\n\r\n"),
    "feat: x\n\nbody line",
  );
  assert.equal(
    normalizeMessage(
      "feat: x\n# ------------------------ >8 ------------------------\ndiff --git a b\n",
    ),
    "feat: x",
  );
  assert.equal(normalizeMessage("feat: x\n; kept\n", ";"), "feat: x");
  assert.equal(normalizeMessage("# only comments\n\n"), "");
  assert.equal(normalizeMessage("#123: keep it\n", null), "#123: keep it");
});

await test("valid subjects pass with the default and configured types, scopes and length", () => {
  for (const subject of [
    "feat: add parser",
    "fix(api): handle `null` values",
    "chore(deps)!: drop node 18",
    "revert(api): undo the parser",
    "feat: 2fa support",
    "fix: handle emoji 😀 limits",
  ]) {
    assert.deepEqual(checkMessage(subject, policy), [], subject);
  }
  assert.deepEqual(checkMessage("feat(api): add", { types: ["feat"], scopes: ["api", "web"] }), []);
  assert.deepEqual(checkMessage("feat: x", { maxLength: 7 }), []);
  assert.deepEqual(checkMessage("feat(x): add 😀😀", { maxLength: 17 }), []);
});

await test("bypass attempts with extra lines, trailers, comments and tricks are refused", () => {
  assert.deepEqual(rulesOf("feat: x\n\nLonger body"), ["commits.body"]);
  assert.deepEqual(rulesOf("feat: x\nSigned-off-by: A <a@example.test>"), ["commits.body"]);
  assert.deepEqual(rulesOf("feat: x\n\nBREAKING CHANGE: removed"), ["commits.body"]);
  assert.deepEqual(rulesOf("feat: x\n\nCo-authored-by: A <a@example.test>"), ["commits.body"]);
  assert.deepEqual(rulesOf("feat: x\n# a comment only\n"), []);
  assert.deepEqual(
    rulesOf("feat: x\n# ------------------------ >8 ------------------------\nextra"),
    [],
  );
  assert.deepEqual(rulesOf("fixup! feat: x"), ["commits.fixup"]);
  assert.deepEqual(rulesOf("squash! feat: x"), ["commits.fixup"]);
  assert.deepEqual(rulesOf("amend! feat: x"), ["commits.fixup"]);
  assert.deepEqual(rulesOf("Merge branch 'main'"), ["commits.merge"]);
  assert.deepEqual(rulesOf('Revert "feat: x"'), ["commits.format"]);
  assert.deepEqual(rulesOf("   "), ["commits.format"]);
  assert.deepEqual(rulesOf(""), ["commits.format"]);
  assert.deepEqual(rulesOf("# only comment"), ["commits.format"]);
});

await test("grammar, type, scope and length refusals are distinct", () => {
  assert.deepEqual(rulesOf("feat:x"), ["commits.format"]);
  assert.deepEqual(rulesOf("feat:  two spaces"), ["commits.format"]);
  assert.deepEqual(rulesOf("feat : x"), ["commits.format"]);
  assert.deepEqual(rulesOf("feat: Capital start"), ["commits.format"]);
  assert.deepEqual(rulesOf("feat: ends with dot."), ["commits.format"]);
  assert.deepEqual(rulesOf("feat: trailing space "), ["commits.format"]);
  assert.deepEqual(rulesOf(" feat: leading space"), ["commits.format", "commits.format"]);
  assert.deepEqual(rulesOf("Feat: x"), ["commits.type"]);
  assert.deepEqual(rulesOf("wip: x"), ["commits.type"]);
  assert.deepEqual(rulesOf("feat(Api): x"), ["commits.scope"]);
  assert.deepEqual(rulesOf("feat(): x"), ["commits.scope"]);
  assert.deepEqual(rulesOf("feat(a b): x"), ["commits.format"]);
  assert.deepEqual(rulesOf("feat(api): x", { types: ["feat"], scopes: ["web"] }), [
    "commits.scope",
  ]);
  assert.deepEqual(rulesOf("feat: x", { types: ["feat"], scopes: ["web"] }), ["commits.scope"]);
  assert.deepEqual(rulesOf("feat: " + "a".repeat(100), { types: ["feat"] }), ["commits.length"]);
  assert.deepEqual(rulesOf("feat: a" + "😀".repeat(69), { types: ["feat"], maxLength: 76 }), []);
});

await test("the default type list and mandatory scope list are enforced", () => {
  assert.deepEqual(checkMessage("build: x"), []);
  assert.deepEqual(checkMessage("style(ui): x"), []);
  assert.deepEqual(
    checkMessage("perf: x").map((item) => item.rule),
    [],
  );
  assert.deepEqual(
    checkMessage("wip(x): y").map((item) => item.rule),
    ["commits.type"],
  );
  assert.deepEqual(
    checkMessage("feat: x", { scopes: ["api"] }).map((item) => item.rule),
    ["commits.scope"],
  );
  assert.deepEqual(checkMessage("feat(api): x", { scopes: ["api"] }), []);
});

await test("range checks read every commit, refuse merges and report short shas", async (t) => {
  const root = repository(t);
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "feat: first");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", "side");
  git(root, "commit", "-q", "--allow-empty", "-m", "fix: side");
  git(root, "checkout", "-q", "-");
  git(root, "commit", "-q", "--allow-empty", "-m", "feat: main");
  git(root, "merge", "-q", "--no-ff", "-m", "feat: join", "side");
  const range = `${base}..HEAD`;
  const merged = await checkRange(policy, range, { root });
  assert.deepEqual(
    merged.map((item) => item.rule),
    ["commits.merge"],
  );
  assert.equal(merged[0].path, git(root, "rev-parse", "--short=7", "HEAD"));
  git(root, "commit", "-q", "--allow-empty", "-m", "Refactor the thing");
  git(root, "commit", "-q", "--allow-empty", "-m", "feat: good\n\nBody text");
  const bad = await checkRange(policy, range, { root });
  assert.ok(bad.some((item) => item.rule === "commits.format" && item.path?.length === 7));
  assert.ok(bad.some((item) => item.rule === "commits.body"));
  git(root, "reset", "-q", "--hard", base);
  git(root, "commit", "-q", "--allow-empty", "-m", "feat: ok");
  assert.deepEqual(await checkRange(policy, `${base}..HEAD`, { root }), []);
});

await test("range checks are explicit about empty, malformed and unavailable history", async (t) => {
  const root = repository(t);
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "feat: only");
  const head = git(root, "rev-parse", "HEAD");
  const empty = await checkRange(policy, `${head}..HEAD`, { root });
  assert.deepEqual(
    empty.map((item) => [item.rule, item.status]),
    [["commits.range", "incomplete"]],
  );
  assert.match(empty[0].message, /selects no commits/);
  for (const range of ["..HEAD", "HEAD..", "a..b..c", "--all..HEAD", "HEAD"]) {
    const result = await checkRange(policy, range, { root });
    assert.deepEqual(
      result.map((item) => [item.rule, item.status]),
      [["commits.range", "incomplete"]],
      range,
    );
  }
  const missing = await checkRange(policy, "origin/never-fetched..HEAD", { root });
  assert.equal(missing[0].status, "incomplete");
  assert.match(missing[0]?.remedy ?? "", /Fetch the base/);
  const outside = repository(t);
  const notRepo = await checkRange(policy, "HEAD~1..HEAD", { root: outside });
  assert.equal(notRepo[0].status, "incomplete");
});

await test("commit-msg and --message CLI report precise exit codes and json", async (t) => {
  const root = repository(t);
  config(root, { commits: { types: ["feat", "fix"], maxLength: 72 } });
  const file = join(root, "COMMIT_EDITMSG");
  const run = async (args: string[]): Promise<{ code: number; text: string }> => {
    let text = "";
    const code = await main([...args, "--root", root], (chunk) => {
      text += chunk;
    });
    return { code, text };
  };
  writeFileSync(file, "feat: add parser\n\n# Please enter the commit message\n");
  assert.equal((await run(["commit-msg", file])).code, 0);
  writeFileSync(file, "feat: add parser\nSigned-off-by: A <a@example.test>\n");
  const body = await run(["commit-msg", file, "--format", "json"]);
  assert.equal(body.code, 1);
  assert.deepEqual(
    parseReport(body.text).diagnostics.map((item) => item.rule),
    ["commits.body"],
  );
  writeFileSync(file, "fixup! feat: add parser\n");
  assert.equal((await run(["commit-msg", file])).code, 1);
  assert.equal((await run(["commits", "--message", "feat: release 1.2"])).code, 0);
  assert.equal((await run(["commits", "--message", "Feat: Release"])).code, 1);
  const unconfigured = repository(t);
  config(unconfigured, {});
  let text = "";
  const missing = await main(
    ["commits", "--message", "feat: x", "--root", unconfigured, "--format", "json"],
    (chunk) => {
      text += chunk;
    },
  );
  assert.equal(missing, 2);
  assert.equal(at(parseJson(text), "diagnostics", 0, "rule"), "config.invalid");
  assert.equal(await main(["commits", "--root", root], () => {}), 2);
});

await test("commit range CLI checks history and rejects invalid combinations", async (t) => {
  const root = repository(t);
  config(root, { commits: {} });
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "feat: base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "commit", "-q", "--allow-empty", "-m", "fix: next");
  let text = "";
  assert.equal(
    await main(["commits", "--range", `${base}..HEAD`, "--root", root], (chunk) => {
      text += chunk;
    }),
    0,
  );
  assert.match(text, /Plumb: pass/);
  assert.equal(await main(["commits", "--range", "HEAD..HEAD", "--root", root], () => {}), 2);
  assert.equal(await main(["check", "--range", "HEAD..HEAD", "--root", root], () => {}), 2);
});
