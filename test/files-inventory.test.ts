import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { inventory } from "../src/files.ts";

const git = (cwd: string, ...args: string[]): ReturnType<typeof spawnSync> =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function repository(t: TestContext, contents: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "plumb-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(contents)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

await test("a git work tree lists tracked and unignored files and omits ignored ones", (t) => {
  const root = repository(t, {
    ".gitignore": "build/\n*.log\n",
    "src/a.ts": "export {};\n",
    "build/out.js": "x\n",
    "debug.log": "x\n",
    "notes.md": "# Notes\n",
  });
  git(root, "init", "-q");
  git(root, "add", "src/a.ts", ".gitignore");
  assert.deepEqual(inventory(root).files, [".gitignore", "notes.md", "src/a.ts"]);
});

await test("a nested node_modules that git does not ignore is inventoried; an ignored one is not", (t) => {
  const root = repository(t, {
    ".gitignore": "/node_modules/\n",
    "node_modules/root.js": "x\n",
    "src/node_modules/x.ts": "export {};\n",
  });
  git(root, "init", "-q");
  assert.deepEqual(inventory(root).files, [".gitignore", "src/node_modules/x.ts"]);
});

await test("a tracked file deleted from the work tree is dropped without a problem", (t) => {
  const root = repository(t, { "a.ts": "export {};\n", "b.ts": "export {};\n" });
  git(root, "init", "-q");
  git(root, "add", "a.ts", "b.ts");
  unlinkSync(join(root, "b.ts"));
  const found = inventory(root);
  assert.deepEqual(found.files, ["a.ts"]);
  assert.deepEqual(found.problems, []);
});

await test("a tracked symbolic link stays a safety problem in git mode", (t) => {
  const root = repository(t, { "a.ts": "export {};\n" });
  symlinkSync(join(root, "a.ts"), join(root, "link.ts"));
  git(root, "init", "-q");
  git(root, "add", "a.ts", "link.ts");
  const found = inventory(root);
  assert.deepEqual(found.files, ["a.ts"]);
  assert.deepEqual(
    found.problems.map(({ rule, path }) => [rule, path]),
    [["inventory.unsafe", "link.ts"]],
  );
});

await test("a folder inside a repository that is not its top level keeps the filesystem walk", (t) => {
  const root = repository(t, {
    ".gitignore": "ignored.txt\n",
    "src/ignored.txt": "x\n",
    "src/a.ts": "export {};\n",
    "src/node_modules/x.ts": "export {};\n",
  });
  git(root, "init", "-q");
  assert.deepEqual(inventory(join(root, "src")).files, ["a.ts", "ignored.txt"]);
});

await test("a folder that is not a repository keeps the filesystem walk and hides dependency folders", (t) => {
  const root = repository(t, {
    "a.ts": "export {};\n",
    "node_modules/x.ts": "export {};\n",
    "src/node_modules/y.ts": "export {};\n",
  });
  assert.deepEqual(inventory(root).files, ["a.ts"]);
});
