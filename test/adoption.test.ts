import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { main } from "../src/cli.ts";
import { at } from "../src/schema.ts";
import {
  changesOf,
  cli,
  json,
  rawPolicy,
  repository,
  roots,
  temporary,
  write,
} from "./ratchet-support.ts";
import { mapped, parseJson, parseReport } from "./support.ts";

const FORBID = { files: { forbidden: ["**/*.orig"] } };

const LEGACY = {
  id: "legacy",
  rules: ["files.forbidden"],
  files: ["a.orig", "b.orig"],
  reason: "predates the policy",
  max: 2,
};

const fixture = (policy: Record<string, unknown>, files: Record<string, string> = {}): string =>
  repository({ "plumb.json": json(rawPolicy(policy)), ...files });

await test("observing reports violations without failing, and never hides an incomplete run", async () => {
  const root = fixture(FORBID, { "a.orig": "x\n" }),
    enforced = await cli(["check", "--root", root]),
    observed = await cli(["check", "--root", root, "--observe"]);
  assert.equal(enforced.code, 1);
  assert.equal(observed.code, 0);
  const result = parseReport(observed.text);
  // the verdict is unchanged: only the exit code is relaxed, and the report says so
  assert.equal(result.status, "violation");
  assert.equal(result.observed, true);
  assert.equal(result.diagnostics.length, 1);
  let text = "";
  await main(["check", "--root", root, "--observe"], (chunk) => (text += chunk));
  assert.match(text, /Plumb: violation \(observed, not enforced\)/);
  const broken = fixture({ files: { names: [{ files: ["none/**"], pattern: "x", reason: "r" }] } });
  assert.equal((await cli(["check", "--root", broken, "--observe"])).code, 2);
  // observing is a property of one check, not a way to relax another command
  for (const command of ["fix", "baseline", "progress"]) {
    assert.equal((await cli([command, "--root", root, "--observe"])).code, 2);
  }
});

await test("progress counts what fails, what each budget hides and how budgets moved", async () => {
  const root = fixture(
    { ...FORBID, exceptions: [LEGACY] },
    { "a.orig": "x\n", "b.orig": "x\n", "c.orig": "x\n" },
  );
  const first = await cli(["progress", "--root", root]),
    summary = parseJson(first.text);
  // a summary keeps the check's exit code
  assert.equal(first.code, 1);
  assert.deepEqual(at(summary, "totals"), {
    violations: 1,
    incomplete: 0,
    suppressed: 2,
    budget: 2,
  });
  assert.deepEqual(at(summary, "rules"), [
    { rule: "files.forbidden", violations: 1, suppressed: 2 },
  ]);
  assert.deepEqual(at(summary, "exceptions"), [{ id: "legacy", used: 2, max: 2 }]);
  assert.equal(at(summary, "budgetChange"), undefined);
  // one legacy file is fixed and its budget shrinks with it
  write(root, {
    "plumb.json": json(
      rawPolicy({ ...FORBID, exceptions: [{ ...LEGACY, files: ["a.orig"], max: 1 }] }),
    ),
  });
  rmSync(join(root, "b.orig"));
  rmSync(join(root, "c.orig"));
  const next = await cli(["progress", "--root", root, "--base", "HEAD"]);
  assert.equal(next.code, 0);
  assert.equal(at(parseJson(next.text), "budgetChange"), -1);
});

await test("upgrade previews a candidate policy: its changes, new violations and their budget", async () => {
  const root = fixture(FORBID, { "a.orig": "x\n", "notes.tmp": "x\n" }),
    outside = mkdtempSync(join(temporary, "plumb-candidate-")),
    candidate = join(outside, "candidate.json");
  roots.push(outside);
  writeFileSync(candidate, json(rawPolicy({ files: { forbidden: ["**/*.orig", "**/*.tmp"] } })));
  const { code, text } = await cli(["upgrade", "--root", root, "--policy", candidate]),
    result = parseReport(text);
  // only what the candidate adds is reported: a.orig already fails today
  assert.equal(code, 1);
  assert.deepEqual(
    result.diagnostics.map((item) => item.path),
    ["notes.tmp"],
  );
  assert.deepEqual(changesOf(result.changes), ["tighten /files/forbidden/1"]);
  assert.deepEqual(
    mapped(result.exceptions, (entry) => at(entry, "files")),
    [["a.orig", "notes.tmp"]],
  );
  // a looser candidate resolves today's violation and is classified as a weakening
  writeFileSync(candidate, json(rawPolicy({})));
  const loose = await cli(["upgrade", "--root", root, "--policy", candidate]),
    relaxed = parseReport(loose.text);
  assert.equal(loose.code, 0);
  assert.deepEqual(changesOf(relaxed.changes), ["weaken /files/forbidden/0"]);
  assert.deepEqual(
    mapped(relaxed.resolved, (item) => at(item, "path")),
    ["a.orig"],
  );
  // a candidate that cannot be checked completely is never a clean upgrade
  writeFileSync(
    candidate,
    json(rawPolicy({ files: { names: [{ files: ["none/**"], pattern: "x", reason: "r" }] } })),
  );
  assert.equal((await cli(["upgrade", "--root", root, "--policy", candidate])).code, 2);
  assert.equal((await cli(["upgrade", "--root", root])).code, 2);
});

await test("every rule says whether it is a guarantee or a convention", async () => {
  const root = fixture(FORBID),
    kind = async (rule: string) =>
      at(parseJson((await cli(["explain", rule, "--root", root])).text), "rule", "kind");
  assert.equal(await kind("files.forbidden"), "convention");
  assert.equal(await kind("files.scope"), "guarantee");
  assert.equal(await kind("policy.weakened"), "guarantee");
  const rules = at(parseJson((await cli(["inspect", "--root", root])).text), "rules");
  assert.ok(mapped(rules, (rule) => at(rule, "kind")).every((value) => typeof value === "string"));
});
