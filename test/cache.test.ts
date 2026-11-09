import assert from "node:assert/strict";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { prepareCache } from "../src/cache.ts";
import type { Report } from "../src/diagnostics.ts";
import { checkerIdentity, checkRepository, context } from "../src/engine.ts";
import { canonical, digest } from "../src/files.ts";
import { at, isRecord } from "../src/schema.ts";
import { parseJson } from "./support.ts";

let ciBefore: string | undefined;

beforeEach(() => {
  ciBefore = process.env.CI;
  delete process.env.CI;
});

afterEach(() => {
  if (ciBefore === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = ciBefore;
  }
});

function fixture(
  t: TestContext,
  policy: Record<string, unknown> = {},
  files: Record<string, string> = { "source.txt": "source\n" },
) {
  const parent =
    process.env.PLUMB_TEST_TMP ?? fileURLToPath(new URL("../../.plumb-tests/", import.meta.url));
  mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(join(parent, "cache-")),
    root = join(folder, "candidate"),
    cache = join(folder, "receipts");
  mkdirSync(root);
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const configure = (value: Record<string, unknown>): void =>
    write("plumb.json", `${JSON.stringify({ schemaVersion: 1, preset: "portable", ...value })}\n`);
  configure(policy);
  for (const [path, text] of Object.entries(files)) {
    write(path, text);
  }
  return {
    folder,
    root,
    cache,
    write,
    configure,
    check: (options: Parameters<typeof checkRepository>[0] | Record<string, never> = {}) =>
      checkRepository({ root, cache, ...options }),
  };
}

function passed(result: Report, hit: boolean): void {
  assert.equal(result.exitCode, 0, JSON.stringify(result, null, 2));
  assert.equal(at(result.cache, "enabled"), true, JSON.stringify(result.cache));
  assert.equal(at(result.cache, "hit"), hit, JSON.stringify(result.cache));
}

await test("pure core results reuse a complete receipt and source or policy changes invalidate it", async (t) => {
  const project = fixture(t, { files: { maxLines: 10 } });
  const first = await project.check();
  passed(first, false);
  const second = await project.check();
  passed(second, true);
  assert.deepEqual(second.coverage, first.coverage);
  assert.equal(canonical(second.identity), canonical(first.identity));
  assert.equal(readdirSync(project.cache).length, 1);
  project.write("source.txt", "changed\n");
  const source = await project.check();
  passed(source, false);
  assert.notEqual(at(source.cache, "key"), at(first.cache, "key"));
  project.configure({ files: { forbidden: ["source.txt"] } });
  const policy = await project.check();
  assert.equal(policy.exitCode, 1);
  assert.equal(at(policy.cache, "hit"), false);
  assert.ok(policy.diagnostics.some((item) => item.rule === "files.forbidden"));
});

await test("approved external policy contents are part of the receipt identity", async (t) => {
  const project = fixture(t),
    policy = join(project.folder, "approved.json");
  const writePolicy = (required: string[]): void =>
    writeFileSync(
      policy,
      JSON.stringify({ schemaVersion: 1, preset: "portable", files: { required } }),
    );
  writePolicy(["source.txt"]);
  passed(await project.check({ policy }), false);
  passed(await project.check({ policy }), true);
  writePolicy(["absent.txt"]);
  const result = await project.check({ policy });
  assert.equal(at(result.cache, "hit"), false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.diagnostics.some((item) => item.rule === "files.required"));
});

await test("Markdown targets and empty directory targets invalidate a previous pass", async (t) => {
  for (const directory of [false, true]) {
    const project = fixture(
      t,
      { docs: {} },
      {
        "README.md": directory
          ? "# Readme\n\n[Artifacts](generated/index.md)\n"
          : "# Readme\n\n[Generated guide](generated/guide.md#present)\n",
      },
    );
    project.write(directory ? "generated/index.md" : "generated/guide.md", "# Present\n");
    const original = await project.check();
    passed(original, false);
    passed(await project.check(), true);
    if (directory) {
      rmSync(join(project.root, "generated"), { recursive: true });
    } else {
      project.write("generated/guide.md", "# Changed\n");
    }
    const result = await project.check();
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.equal(at(result.cache, "hit"), false);
    assert.notEqual(at(result.cache, "key"), at(original.cache, "key"));
    assert.ok(result.diagnostics.some((item) => item.rule === "docs.links"));
  }
});

await test("malformed, checksum-invalid and incomplete receipts are safe misses", async (t) => {
  const project = fixture(t),
    first = await project.check();
  passed(first, false);
  const path = join(project.cache, `${at(first.cache, "key")}.json`);
  const original = parseJson(readFileSync(path, "utf8"));
  assert.ok(isRecord(original));
  const broken = [
    "{not-json",
    JSON.stringify({ ...original, sha256: "0".repeat(64) }),
    JSON.stringify({ ...original, key: "0".repeat(64) }),
  ];
  const missingCoverage = structuredClone(original),
    result = missingCoverage.result;
  assert.ok(isRecord(result));
  delete result.coverage;
  missingCoverage.sha256 = digest(canonical(result));
  broken.push(JSON.stringify(missingCoverage));
  for (const receipt of broken) {
    writeFileSync(path, receipt);
    const fresh = await project.check();
    passed(fresh, false);
    assert.match(String(at(fresh.cache, "reason")), /Receipt was not reused/);
    passed(await project.check(), true);
  }
});

await test("a complete violation or an incomplete check is never stored as reusable success", async (t) => {
  for (const [policy, exitCode] of [
    [{ files: { required: ["missing.txt"] } }, 1],
    [
      {
        files: {
          names: [{ files: ["missing/**"], pattern: ".*", reason: "declared scope must exist" }],
        },
      },
      2,
    ],
  ] as const) {
    const project = fixture(t, policy),
      result = await project.check();
    assert.equal(result.exitCode, exitCode);
    assert.equal(at(result.cache, "hit"), false);
    assert.equal(existsSync(project.cache), false);
  }
});

await test("language and behavioral modes execute on every invocation with caching disabled", async (t) => {
  const ruby = fixture(
    t,
    { projects: [{ root: ".", profile: "ruby" }] },
    { "source.rb": "puts 1\n" },
  );
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await ruby.check({
      execute: async () => {
        calls++;
        return { error: "controlled missing tool", code: null, stdout: "", stderr: "" };
      },
    });
    assert.equal(at(result.cache, "enabled"), false);
    assert.equal(result.exitCode, 2);
  }
  assert.equal(calls, 2);
  const behavioral = fixture(t, {
    verification: [
      {
        id: "unit",
        command: [
          process.execPath,
          "-e",
          'process.stdout.write(JSON.stringify({schemaVersion:1,suite:"unit",tests:[{id:"behavior",status:"passed"}]}))',
        ],
        format: "plumb-json",
      },
    ],
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await behavioral.check();
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(at(result.cache, "enabled"), false);
    assert.equal(at(result.tests, 0, "passed"), 1);
  }
  assert.equal(existsSync(behavioral.cache), false);
});

await test("task, adapter and approved-input modes cannot return cached evidence", (t) => {
  const project = fixture(t),
    ctx = context({ root: project.root });
  for (const options of [
    { loadedTask: {} },
    { task: "task.json" },
    { subjectContext: {} },
    { inputBundle: {} },
    { inputManifest: "inputs.json" },
    { adapters: "adapters.json" },
    { registry: {} },
  ]) {
    const memo = prepareCache(ctx, { cache: project.cache, ...options }, checkerIdentity());
    assert.equal(memo?.info.enabled, false, JSON.stringify(options));
    assert.equal(memo?.result, undefined);
    assert.equal(memo?.save, undefined);
  }
  assert.equal(
    prepareCache(
      {
        ...ctx,
        registry: { path: "adapters.json", sha256: "", candidateRoot: ctx.root, adapters: [] },
      },
      { cache: project.cache },
      checkerIdentity(),
    )?.info.enabled,
    false,
  );
});

await test("CI disables local caching while false and zero retain conventional local behavior", async (t) => {
  const project = fixture(t);
  for (const value of ["true", "1", "yes"]) {
    process.env.CI = value;
    const result = await project.check();
    assert.equal(result.exitCode, 0);
    assert.equal(at(result.cache, "enabled"), false);
    assert.match(String(at(result.cache, "reason")), /CI/);
  }
  for (const value of ["false", "0", "FALSE"]) {
    process.env.CI = value;
    const result = await project.check();
    assert.equal(at(result.cache, "enabled"), true);
  }
});

await test("cache destinations inside the checkout, including aliases, are refused", async (t) => {
  const project = fixture(t);
  const direct = join(project.root, "receipts");
  assert.equal((await project.check({ cache: direct })).exitCode, 2);
  assert.equal(existsSync(direct), false);
  const alias = join(project.folder, "alias");
  symlinkSync(project.root, alias, "junction");
  assert.equal((await project.check({ cache: join(alias, "receipts") })).exitCode, 2);
});

await test("cache input drift has a distinct failure and is never reduced to an advisory cache error", async (t) => {
  const project = fixture(t),
    ctx = context({ root: project.root });
  const memo = prepareCache(ctx, { cache: project.cache }, checkerIdentity());
  project.write("source.txt", "changed\n");
  assert.ok(memo);
  assert.throws(() => memo.verify?.(), { code: "PLUMB_CACHE_MUTATED" });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    const result = rename(from, to);
    if (String(to).startsWith(project.cache)) {
      project.write("source.txt", "changed during receipt write\n");
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    const result = await project.check();
    assert.equal(result.exitCode, 2, JSON.stringify(result));
    assert.ok(result.diagnostics.some((item) => item.rule === "run.mutated"));
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
});

await test("ordinary external cache write failures leave completed core results usable", async (t) => {
  const project = fixture(t);
  writeFileSync(project.cache, "not a directory");
  const result = await project.check();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(at(result.cache, "hit"), false);
  assert.match(String(at(result.cache, "reason")), /Cache was not saved/);
});
