import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { vendor, verifyInstall } from "../src/install.ts";
import { at } from "../src/schema.ts";
import { cli, repository, write } from "./ratchet-support.ts";
import { parseJson } from "./support.ts";

const git = (root: string, ...args: string[]): string => {
  const result = spawnSync(
    "git",
    [
      ...["-c", "user.name=plumb", "-c", "user.email=plumb@example.test"],
      ...["-c", "commit.gpgsign=false", ...args],
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

// a consumer that vendored an upstream checker the documented way, with its revision recorded
function vendored(): { root: string; checker: string; revision: string } {
  const upstream = repository({ "bin/plumb.ts": "export {};\n", "src/a.ts": "export {};\n" }),
    root = repository({ "README.md": "# Consumer\n" });
  git(root, "fetch", "-q", upstream, "HEAD");
  git(root, "read-tree", "--prefix=tools/plumb/", "-u", "FETCH_HEAD");
  const revision = git(root, "rev-parse", "FETCH_HEAD");
  writeFileSync(join(root, "tools/plumb.revision"), `${revision}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "build: vendor plumb");
  return { root, checker: join(root, "tools/plumb"), revision };
}

const rules = async (checker: string): Promise<unknown[]> =>
  (await verifyInstall(checker)).diagnostics.map((item) => [item.rule, item.status]);

await test("a vendored checker that equals its pinned revision verifies", async () => {
  const { checker, revision } = vendored(),
    verified = await verifyInstall(checker);
  assert.deepEqual(verified, { revision, diagnostics: [] });
  // a checker that is not vendored has nothing to compare
  assert.deepEqual(await verifyInstall(join(checker, "src")), { diagnostics: [] });
});

await test("an edited checker, committed or not, is refused", async () => {
  const uncommitted = vendored();
  write(uncommitted.root, { "tools/plumb/src/a.ts": "export const lax = true;\n" });
  assert.deepEqual(await rules(uncommitted.checker), [["install.modified", "violation"]]);
  const committed = vendored();
  write(committed.root, { "tools/plumb/src/extra.ts": "export {};\n" });
  git(committed.root, "add", "-A");
  git(committed.root, "commit", "-q", "-m", "chore: patch the checker");
  assert.deepEqual(await rules(committed.checker), [["install.modified", "violation"]]);
});

await test("a revision that cannot be compared is incomplete, never verified", async () => {
  for (const revision of ["f".repeat(40), "main", ""]) {
    const { root, checker } = vendored();
    writeFileSync(join(root, "tools/plumb.revision"), `${revision}\n`);
    assert.deepEqual(await rules(checker), [["install.revision", "incomplete"]], revision);
  }
});

await test("plumb --version reports the checker identity", async () => {
  const { code, text } = await cli(["--version"]);
  assert.equal(code, 0, text);
  assert.match(String(at(parseJson(text), "checker", "sha256")), /^[0-9a-f]{64}$/);
  assert.equal(at(parseJson(text), "node"), process.versions.node);
});

const commit = (root: string, subject: string): string => {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", subject);
  return git(root, "rev-parse", "HEAD");
};

await test("vendor installs a pinned revision, updates it and verifies afterwards", async () => {
  const upstream = repository({ "bin/plumb.ts": "export {};\n", "src/a.ts": "export {};\n" }),
    first = git(upstream, "rev-parse", "HEAD"),
    root = repository({ "README.md": "# Consumer\n" }),
    checker = join(root, "tools/plumb");
  git(upstream, "tag", "v1");
  write(upstream, { "src/b.ts": "export {};\n" });
  const second = commit(upstream, "feat: add b");
  // a tag pins the release it names, not the newest commit
  assert.deepEqual(await vendor(root, upstream, "v1"), {
    revision: first,
    written: ["tools/plumb", "tools/plumb.revision"],
  });
  assert.equal(existsSync(join(checker, "src/b.ts")), false);
  commit(root, "build: vendor plumb");
  assert.deepEqual(await verifyInstall(checker), { revision: first, diagnostics: [] });
  // an update replaces the tree exactly: files the new revision adds or drops follow it
  assert.equal((await vendor(root, upstream)).revision, second);
  assert.equal(readFileSync(join(root, "tools/plumb.revision"), "utf8"), `${second}\n`);
  assert.equal(existsSync(join(checker, "src/b.ts")), true);
  commit(root, "build: pull plumb");
  assert.deepEqual(await verifyInstall(checker), { revision: second, diagnostics: [] });
  assert.equal(git(root, "status", "--porcelain"), "");
});

await test("vendor refuses to discard local edits or to run on anything but a repository root", async () => {
  const { root } = vendored(),
    upstream = repository({ "bin/plumb.ts": "export {};\n" });
  write(root, { "tools/plumb/src/a.ts": "export const patched = true;\n" });
  await assert.rejects(vendor(root, upstream), /uncommitted changes/);
  assert.equal(
    readFileSync(join(root, "tools/plumb/src/a.ts"), "utf8"),
    "export const patched = true;\n",
  );
  const clean = repository({ "README.md": "# Consumer\n", "docs/a.md": "# A\n" });
  await assert.rejects(vendor(join(clean, "docs"), upstream), /root of the repository/);
  await assert.rejects(vendor(clean, upstream, "no-such-revision"), /git fetch failed/);
  await assert.rejects(vendor(clean, "--upload-pack=touch pwned"), /not options/);
  await assert.rejects(vendor(clean, upstream, "--force"), /not options/);
  assert.equal(existsSync(join(clean, "tools")), false);
});

await test("plumb vendor installs through the command line from a local clone", async () => {
  const upstream = repository({ "bin/plumb.ts": "export {};\n" }),
    root = repository({ "README.md": "# Consumer\n" });
  const { code, text } = await cli(["vendor", "--root", root, "--from", upstream]);
  assert.equal(code, 0, text);
  assert.equal(at(parseJson(text), "revision"), git(upstream, "rev-parse", "HEAD"));
  assert.equal(existsSync(join(root, "tools/plumb/bin/plumb.ts")), true);
  assert.equal((await cli(["check", "--root", root, "--from", upstream])).code, 2);
});
