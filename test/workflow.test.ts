import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { main } from "../src/cli.ts";
import {
  checkerIdentity,
  checkRepository,
  context,
  doctor,
  inspect,
  planRepository,
} from "../src/engine.ts";
import { digest } from "../src/files.ts";
import { inputDigest } from "../src/inputs.ts";
import { previewRepairs } from "../src/repair.ts";
import { at, isRecord } from "../src/schema.ts";
import { lengthOf, mapped, parseJson } from "./support.ts";

function fixture(
  t: TestContext,
  policy: Record<string, unknown> = {},
  files: Record<string, string> = {},
): { root: string; parent: string; write: (path: string, value: string, base?: string) => string } {
  const temporary = process.env.PLUMB_TEST_TMP ?? tmpdir();
  mkdirSync(temporary, { recursive: true });
  const parent = mkdtempSync(join(temporary, "workflow-")),
    root = join(parent, "candidate");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const write = (path: string, value: string, base = root): string => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), value);
    return join(base, path);
  };
  write("plumb.json", JSON.stringify({ schemaVersion: 1, preset: "portable", ...policy }));
  for (const [path, value] of Object.entries(files)) {
    write(path, value);
  }
  return { root, parent, write };
}

async function cli(args: string[], format = "json"): Promise<{ code: number; body: unknown }> {
  let text = "";
  const code = await main([...args, "--format", format], (chunk) => {
    text += chunk;
  });
  return { code, body: parseJson(text) };
}

await test("plan and doctor disclose readiness without executing configured behavioral tests", async (t) => {
  const f = fixture(
    t,
    {
      verification: [
        {
          id: "behavior",
          command: [process.execPath, "-e", "throw Error('must execute only on check')"],
          format: "junit",
        },
      ],
    },
    { "source.txt": "source" },
  );
  const plan = planRepository({ root: f.root });
  assert.equal(plan.exitCode, 0);
  assert.equal(plan.executed, false);
  assert.equal(plan.complete, false);
  assert.ok(plan.checks?.some((check) => check.id === "test:behavior"));
  const ready = await doctor({ root: f.root });
  assert.equal(ready.exitCode, 0);
  assert.equal(at(ready.verification, 0, "status"), "not-run");
  const selected = await inspect({ root: f.root, file: "source.txt" });
  assert.ok(mapped(at(selected.file, "checks"), String).includes("files"));
  assert.equal(at((await inspect({ root: f.root, file: "absent.txt" })).file, "present"), false);
  assert.equal((await checkRepository({ root: f.root })).exitCode, 2);
});

await test("external tasks bind real suite evidence and required checks", async (t) => {
  const f = fixture(
    t,
    {
      verification: [
        {
          id: "behavior",
          command: [process.execPath, "--test", "--test-reporter=junit", "test/behavior.test.mjs"],
          format: "junit",
        },
      ],
    },
    {
      "test/behavior.test.mjs":
        'import test from "node:test"; import assert from "node:assert/strict"; test("behavior", () => assert.equal(2 + 2, 4));\n',
    },
  );
  const task = f.write(
    "task.json",
    JSON.stringify({
      schemaVersion: 1,
      id: "value-change",
      requireChecks: ["files"],
      requireTests: ["behavior"],
    }),
    f.parent,
  );
  assert.equal(planRepository({ root: f.root, task }).exitCode, 0);
  const complete = await checkRepository({ root: f.root, task });
  assert.equal(complete.exitCode, 0, JSON.stringify(complete.diagnostics));
  assert.equal(at(complete.tests, 0, "passed"), 1);
  assert.deepEqual(at(complete.tests, 0, "subject"), at(complete.identity, "subject"));
  assert.match(String(at(complete.identity, "task", "sha256")), /^[a-f0-9]{64}$/);
});

await test("pinned policy templates, provenance and effective policy diffs work through the CLI", async (t) => {
  const f = fixture(t, {}, { "src/readme.txt": "ready" });
  const bundle = f.write(
    "bundle.json",
    JSON.stringify({
      schemaVersion: 1,
      preset: "portable",
      files: { required: ["${root}/readme.txt"] },
    }),
    f.parent,
  );
  const pinned = await cli(["pin-policy", bundle, "--root", f.root]);
  assert.equal(pinned.code, 0);
  assert.equal(at(pinned.body, "sha256"), digest(readFileSync(bundle)));
  f.write(
    "plumb.json",
    JSON.stringify({
      schemaVersion: 1,
      bundles: [{ ...(isRecord(pinned.body) ? pinned.body : {}), bindings: { root: "src" } }],
    }),
  );
  const checked = await checkRepository({ root: f.root });
  assert.equal(checked.exitCode, 0, JSON.stringify(checked.diagnostics));
  assert.equal(lengthOf(at(checked.identity, "policySources")), 2);
  const previous = f.write("previous.json", '{"schemaVersion":1,"preset":"portable"}', f.parent);
  const diff = await cli(["policy-diff", "--root", f.root, "--against", previous]);
  assert.equal(diff.code, 0);
  assert.ok(
    mapped(at(diff.body, "changes"), (change) => [at(change, "path"), at(change, "kind")]).some(
      ([path, kind]) => path === "/files" && kind === "added",
    ),
  );
  f.write("bundle.json", '{"schemaVersion":1,"preset":"portable"}', f.parent);
  assert.equal((await checkRepository({ root: f.root })).exitCode, 2);
});

await test("approved input overlays are isolated, fingerprinted and mutation checked during tests", async (t) => {
  const f = fixture(t, {}, { "source.txt": "source" });
  const dependency = f.write("inputs/dependency.txt", "approved dependency", f.parent);
  const inputManifest = f.write(
    "inputs.json",
    JSON.stringify({
      schemaVersion: 1,
      files: [
        { path: "node_modules/data.txt", source: dependency, sha256: inputDigest(dependency) },
      ],
    }),
    f.parent,
  );
  const configure = (mutate: boolean): string =>
    f.write(
      "plumb.json",
      JSON.stringify({
        schemaVersion: 1,
        preset: "portable",
        verification: [
          {
            id: "behavior",
            format: "plumb-json",
            command: [
              process.execPath,
              "--input-type=module",
              "-e",
              `import {readFileSync,writeFileSync} from 'node:fs'; if(readFileSync('node_modules/data.txt','utf8')!=='approved dependency') throw Error('bad input'); ${mutate ? "writeFileSync('node_modules/data.txt','changed');" : ""} process.stdout.write(JSON.stringify({schemaVersion:1,suite:'behavior',tests:[{id:'reads input',status:'passed'}]}));`,
            ],
          },
        ],
      }),
    );
  configure(false);
  const ready = await checkRepository({ root: f.root, inputManifest });
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.diagnostics));
  assert.ok(at(ready.identity, "approvedInputs"));
  configure(true);
  const changed = await checkRepository({ root: f.root, inputManifest });
  assert.equal(changed.exitCode, 2);
  assert.ok(changed.diagnostics.some((item) => item.rule === "verification.incomplete"));
  assert.equal(readFileSync(dependency, "utf8"), "approved dependency");
  assert.throws(() => readFileSync(join(f.root, "node_modules/data.txt")), { code: "ENOENT" });
});

await test("saved repair plans pass through CLI validation and cannot apply stale source", async (t) => {
  const f = fixture(t, {}, { "source.txt": "before\n" });
  const preview = await cli([
    "fix",
    "--root",
    f.root,
    "--dry-run",
    "--output",
    join(f.parent, "empty-plan.json"),
  ]);
  assert.equal(preview.code, 0);
  assert.equal(at(preview.body, "plan", "kind"), "plumb-repair");
  assert.equal(
    at(parseJson(readFileSync(join(f.parent, "empty-plan.json"), "utf8")), "kind"),
    "plumb-repair",
  );
  const plan = await previewRepairs(
    context({ root: f.root }),
    async (root) => {
      writeFileSync(join(root, "source.txt"), "after\n");
      return { diagnostics: [] };
    },
    { checker: checkerIdentity() },
  );
  const path = f.write("repair.json", JSON.stringify(plan), f.parent);
  const applied = await cli(["fix", "--root", f.root, "--apply", path]);
  assert.equal(applied.code, 0, JSON.stringify(applied.body));
  assert.deepEqual(at(applied.body, "written"), ["source.txt"]);
  assert.equal((await cli(["fix", "--root", f.root, "--apply", path])).code, 2);
  assert.equal(readFileSync(join(f.root, "source.txt"), "utf8"), "after\n");
});

await test("SARIF preserves exit status and output cannot change the checked repository", async (t) => {
  const f = fixture(t, { files: { required: ["missing.txt"] } });
  const path = join(f.parent, "findings.sarif");
  const sarif = await cli(["check", "--root", f.root, "--output", path], "sarif");
  assert.equal(sarif.code, 1);
  assert.equal(at(sarif.body, "version"), "2.1.0");
  assert.equal(at(sarif.body, "runs", 0, "results", 0, "ruleId"), "files.required");
  assert.equal(at(parseJson(readFileSync(path, "utf8")), "version"), "2.1.0");
  assert.equal(
    (await cli(["check", "--root", f.root, "--output", join(f.root, "new.json")])).code,
    2,
  );
  assert.throws(() => readFileSync(join(f.root, "new.json")), { code: "ENOENT" });
});
