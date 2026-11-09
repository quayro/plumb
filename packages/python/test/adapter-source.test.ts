import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { adapterPath, readAdapterSource } from "../../../scripts/adapter-source.ts";

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
    cwd,
    stdio: "ignore",
  });
};

await test("the pinned adapter is read from a git revision, not the working tree", (t) => {
  const root = mkdtempSync(join(tmpdir(), "plumb-adapter-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  mkdirSync(join(root, "packages/python"), { recursive: true });
  const file = join(root, adapterPath);
  const commit = (message: string) => {
    git(root, "add", ".");
    git(root, "commit", "-q", "--no-verify", "--no-gpg-sign", "-m", message);
  };

  writeFileSync(file, "reviewed\n");
  commit("feat: reviewed adapter");
  git(root, "branch", "reviewed");
  writeFileSync(file, "merged next\n");
  commit("feat: next adapter");
  // an edit under review that is not committed must never reach the checker
  writeFileSync(file, "working tree only\n");

  assert.equal(readAdapterSource(root, "HEAD").toString(), "merged next\n");
  assert.equal(readAdapterSource(root, "reviewed").toString(), "reviewed\n");
});

await test("an unreadable adapter ref or file fails instead of falling back", (t) => {
  const root = mkdtempSync(join(tmpdir(), "plumb-adapter-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  writeFileSync(join(root, "other.txt"), "not the adapter\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "test: other file");

  assert.throws(() => readAdapterSource(root, "missing-ref"), /cannot read .* at missing-ref/);
  assert.throws(() => readAdapterSource(root, "HEAD"), /cannot read packages\/python\/adapter\.py/);
  assert.throws(() => readAdapterSource(root, ""), /not a git revision/);
  assert.throws(() => readAdapterSource(root, "--output=x"), /not a git revision/);
});
