import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.ts";
import { definePlumb } from "../src/config.ts";
import { comparePolicies } from "../src/ratchet.ts";
import { at } from "../src/schema.ts";
import { mapped } from "./support.ts";

export const temporary = process.env.PLUMB_TEST_TMP ?? tmpdir();
export const roots: string[] = [];

// awaited top-level tests let a root after() hook run between them, so clean up at exit
process.on("exit", () => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

export const bin = fileURLToPath(new URL("../bin/plumb.ts", import.meta.url));

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const pin = (text: string): string => createHash("sha256").update(text).digest("hex");

export const rawPolicy = (extra: Record<string, unknown>): Record<string, unknown> => ({
  schemaVersion: 1,
  preset: "portable",
  ...extra,
});

export const E = {
  id: "legacy",
  rules: ["files.names"],
  files: ["src/a/*"],
  reason: "legacy names",
  max: 2,
};

// each policy change a report records, as classification and pointer
export const changesOf = (value: unknown): string[] =>
  mapped(value, (item) => `${String(at(item, "classification"))} ${String(at(item, "pointer"))}`);

export function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=plumb",
      "-c",
      "user.email=plumb@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// a repository whose committed files are the base revision; later writes stay uncommitted.
export function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(temporary, "plumb-ratchet-test-"));
  roots.push(root);
  git(root, "init", "-q");
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

export async function cli(args: string[]): Promise<{ code: number; text: string }> {
  const output: string[] = [];
  const code = await main([...args, "--format", "json"], (text) => output.push(text));
  return { code, text: output.join("") };
}

export const policy = (extra: Record<string, unknown>): ReturnType<typeof definePlumb> =>
  definePlumb({ schemaVersion: 1, preset: "portable", ...extra });

export const classes = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] =>
  comparePolicies(policy(before), policy(after))
    .map((item) => `${item.classification} ${item.pointer}`)
    .sort();

export const raw = (before: unknown, after: unknown): string[] =>
  comparePolicies(before, after)
    .map((item) => `${item.classification} ${item.pointer}`)
    .sort();
