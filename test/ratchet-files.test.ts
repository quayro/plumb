import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assetsFor, checkAssets, syncAssets } from "../src/assets.ts";
import { checkRepository, context } from "../src/engine.ts";
import { isPolicyFile } from "../src/files.ts";
import { comparePolicies } from "../src/ratchet.ts";
import {
  bin,
  cli,
  json,
  pin,
  policy,
  rawPolicy,
  repository,
  roots,
  temporary,
  write,
} from "./ratchet-support.ts";
import { parseReport } from "./support.ts";

await test("a missing base revision or base policy file is incomplete, not a pass", async () => {
  const root = repository({ "plumb.json": json(rawPolicy({})) });
  const missingRef = await checkRepository({ root, base: "no-such-ref" });
  assert.equal(missingRef.status, "incomplete");
  assert.ok(
    missingRef.diagnostics.some(
      (item) =>
        item.rule === "policy.base" && item.status === "incomplete" && item.suppressible === false,
    ),
  );
  const bare = repository({ "README.md": "# repo\n" });
  write(bare, { "plumb.json": json(rawPolicy({})) });
  const missingFile = await checkRepository({ root: bare, base: "HEAD" });
  assert.equal(missingFile.status, "incomplete");
  assert.ok(
    missingFile.diagnostics.some(
      (item) => item.rule === "policy.base" && /missing at HEAD/.test(item.message),
    ),
  );
});

await test("--base is check-only, cannot be cached, and --config is refused where the policy could be swapped", async (t) => {
  const root = repository({
    "plumb.json": json(rawPolicy({})),
    "plumb.config.json": json(rawPolicy({})),
    "plumb.local.json": json(rawPolicy({})),
  });
  const saved = process.env.CI;
  t.after(() => {
    if (saved === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = saved;
    }
  });
  assert.match(
    (await cli(["sync", "--root", root, "--base", "HEAD"])).text,
    /--base is only supported by check/,
  );
  assert.match(
    (await cli(["check", "--root", root, "--base", "HEAD", "--cache", join(root, "..")])).text,
    /--base cannot be combined with --cache/,
  );
  delete process.env.CI;
  assert.match(
    (await cli(["check", "--root", root, "--config", "plumb.local.json"])).text,
    /must match a protected policy pattern/,
  );
  assert.match(
    (await cli(["check", "--root", root, "--config", "plumb.config.json", "--base", "HEAD"])).text,
    /refused in CI and with --base/,
  );
  assert.doesNotMatch(
    (await cli(["check", "--root", root, "--config", "plumb.config.json"])).text,
    /refused|must match a protected/,
  );
  process.env.CI = "true";
  assert.match(
    (await cli(["check", "--root", root, "--config", "plumb.config.json"])).text,
    /refused in CI/,
  );
  assert.doesNotMatch(
    (await cli(["check", "--root", root, "--config", "plumb.json"])).text,
    /refused|must match a protected/,
  );
});

await test("a nested policy is reported under git, discovery uses the git top-level, and pinned bundles are exempt", async () => {
  const nested = json(rawPolicy({ exceptions: [] }));
  const root = repository({ "plumb.json": json(rawPolicy({})), "sub/plumb.json": nested });
  const checked = await checkRepository({ root });
  assert.ok(
    checked.diagnostics.some(
      (item) => item.rule === "policy.nested" && item.path === "sub/plumb.json",
    ),
  );
  const discovered = spawnSync(process.execPath, [bin, "check", "--format", "json"], {
    cwd: join(root, "sub"),
    encoding: "utf8",
    env: { ...process.env, CI: "" },
  });
  assert.ok(
    parseReport(discovered.stdout).diagnostics.some(
      (item) => item.rule === "policy.nested" && item.path === "sub/plumb.json",
    ),
  );
  const pinned = repository({
    "plumb.json": json({
      schemaVersion: 1,
      bundles: [{ path: "sub/plumb.json", sha256: pin(nested) }],
    }),
    "sub/plumb.json": nested,
  });
  assert.equal(
    (await checkRepository({ root: pinned })).diagnostics.some(
      (item) => item.rule === "policy.nested",
    ),
    false,
  );
  const vendored = repository({
    "plumb.json": json(
      rawPolicy({ exclude: [{ files: ["tools/plumb/**"], reason: "vendored checker" }] }),
    ),
    "tools/plumb/plumb.json": nested,
  });
  assert.equal(
    (await checkRepository({ root: vendored })).diagnostics.some(
      (item) => item.rule === "policy.nested",
    ),
    false,
  );
  const plain = mkdtempSync(join(temporary, "plumb-ratchet-plain-"));
  roots.push(plain);
  write(plain, { "plumb.json": json(rawPolicy({})), "sub/plumb.json": nested });
  assert.equal(
    (await checkRepository({ root: plain })).diagnostics.some(
      (item) => item.rule === "policy.nested",
    ),
    false,
  );
});

await test("generated CODEOWNERS lists policy-protected files, reports drift, and sync restores it", () => {
  const config = policy({
    policy: {
      owners: ["@ozmikhail/security", "ops@example.com"],
      protected: ["src/**", "docs/guide/**", "**/secrets/**"],
    },
  });
  const asset = assetsFor(config).find((item) => item.path === ".github/CODEOWNERS");
  assert.ok(asset);
  assert.equal(asset.executable, false);
  const [header, ...rules] = asset.content.trimEnd().split("\n");
  assert.equal(header, "# generated by plumb from policy.protected; edit plumb.json");
  for (const line of [
    "/plumb.json @ozmikhail/security ops@example.com",
    "/src/ @ozmikhail/security ops@example.com",
    "/docs/guide/ @ozmikhail/security ops@example.com",
    "**/secrets/ @ozmikhail/security ops@example.com",
    "/.github/workflows/ @ozmikhail/security ops@example.com",
    "**/tsconfig*.json @ozmikhail/security ops@example.com",
  ]) {
    assert.ok(rules.includes(line), line);
  }
  assert.deepEqual(rules, [...new Set(rules)].sort());
  assert.throws(() => policy({ policy: { owners: ["alice"] } }), TypeError);
  const root = repository({
    "plumb.json": json({
      schemaVersion: 1,
      preset: "portable",
      policy: { owners: ["@ozmikhail/security"] },
    }),
  });
  assert.ok(
    checkAssets({ root, config: policy({ policy: { owners: ["@ozmikhail/security"] } }) }).some(
      (item) => item.rule === "generated.drift" && item.path === ".github/CODEOWNERS",
    ),
  );
  const current = policy({ policy: { owners: ["@ozmikhail/security"] } });
  assert.ok(syncAssets({ root, config: current }).written.includes(".github/CODEOWNERS"));
  assert.deepEqual(checkAssets({ root, config: current }), []);
  write(root, { ".github/CODEOWNERS": "* @attacker\n" });
  assert.ok(checkAssets({ root, config: current }).some((item) => item.rule === "generated.drift"));
  assert.ok(syncAssets({ root, config: current }).written.includes(".github/CODEOWNERS"));
  assert.deepEqual(checkAssets({ root, config: current }), []);
});

await test("generated hooks, CI and tool configs are protected from repair writes", () => {
  const config = policy({});
  for (const path of [
    ".githooks/pre-commit",
    ".husky/pre-push",
    ".github/CODEOWNERS",
    ".github/workflows/ci.yml",
    "tsconfig.base.json",
    ".prettierrc.json",
    "knip.jsonc",
    ".editorconfig",
    ".gitattributes",
  ]) {
    assert.equal(isPolicyFile(config, path), true, path);
  }
  assert.equal(isPolicyFile(config, "src/a.mjs"), false);
  const root = repository({
    "plumb.json": json(rawPolicy({})),
    ".githooks/pre-commit": "#!/bin/sh\n",
    "src/a.mjs": "export {};\n",
  });
  const ctx = context({ root });
  assert.equal(ctx.writableFiles.includes(".githooks/pre-commit"), false);
  assert.equal(ctx.writableFiles.includes("src/a.mjs"), true);
});

await test("opting into a new section or suite tightens, while editing an existing one is classified field by field", () => {
  const base = { schemaVersion: 1, projects: [], exclude: [], exceptions: [] };
  const classes = (after: unknown): [string, string][] =>
    comparePolicies(base, after).map(({ pointer, classification }) => [pointer, classification]);
  assert.deepEqual(classes({ ...base, commits: { types: ["feat"] } }), [["/commits", "tighten"]]);
  assert.deepEqual(classes({ ...base, hooks: { command: ["plumb"] } }), [["/hooks", "tighten"]]);
  assert.deepEqual(
    classes({
      ...base,
      contracts: { boundaries: [{ from: ["a/**"], deny: ["b/**"], reason: "r" }] },
    }),
    [["/contracts/boundaries/0", "tighten"]],
  );
  const hooked = {
    ...base,
    hooks: { command: ["plumb"] },
    commits: { types: ["feat"], maxLength: 100 },
  };
  assert.deepEqual(
    comparePolicies(hooked, { ...hooked, hooks: { command: ["true"] } }).map(
      ({ classification }) => classification,
    ),
    ["weaken", "weaken"],
  );
  assert.deepEqual(
    comparePolicies(hooked, { ...hooked, commits: { types: ["feat", "wip"], maxLength: 120 } }).map(
      ({ classification }) => classification,
    ),
    ["weaken", "weaken"],
  );
});
