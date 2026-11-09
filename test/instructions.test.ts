import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli.ts";
import { at } from "../src/schema.ts";
import { cli, json, rawPolicy, repository } from "./ratchet-support.ts";
import { parseJson } from "./support.ts";

const POLICY = rawPolicy({
  files: {
    required: ["README.md"],
    forbidden: ["**/*.orig"],
    names: [{ files: ["src/**"], pattern: "^[a-z-]+\\.txt$", reason: "kebab-case sources" }],
  },
  rules: [
    {
      id: "no-token",
      files: ["src/**"],
      forbid: "SECRET",
      reason: "Credentials stay out of source.",
      remedy: "Read them from the environment.",
    },
  ],
  commits: { scopes: ["api"], maxLength: 72 },
  policy: { protected: ["vendor/**"] },
  exceptions: [
    { id: "legacy", rules: ["files.names"], files: ["src/Old.txt"], reason: "old", max: 1 },
  ],
});

const fixture = (): string =>
  repository({
    "plumb.json": json(POLICY),
    "README.md": "# Fixture\n",
    "src/a.txt": "x\n",
    "src/Old.txt": "x\n",
    "vendor/lib.txt": "x\n",
  });

async function text(root: string): Promise<string> {
  let out = "";
  assert.equal(await main(["instructions", "--root", root], (chunk) => (out += chunk)), 0);
  return out;
}

await test("instructions state the effective policy and are stable between runs", async () => {
  const root = fixture(),
    markdown = await text(root);
  assert.equal(markdown, await text(root));
  for (const line of [
    "# Repository conventions",
    "- Required: `README.md`.",
    "- Never add files matching `**/*.orig`.",
    "- `src/**` are named `^[a-z-]+\\.txt$`: kebab-case sources",
    "- Change `vendor/**` only with an owner's review.",
    "- `custom.no-token` (`src/**`): Credentials stay out of source. Read them from the environment.",
    "- Scopes: `api`.",
    "- At most 72 characters.",
    "- 1 budgeted exceptions exist for older code. Budgets only shrink: fix what you touch and never add or widen one.",
  ]) {
    assert.ok(markdown.includes(`${line}\n`), line);
  }
  // a section the policy does not configure is not invented
  assert.doesNotMatch(markdown, /## (?:Tests|Boundaries|Roles|Projects)/);
});

await test("inspecting a file lists exactly the conventions that govern it", async () => {
  const root = fixture(),
    conventions = async (path: string) =>
      at(
        parseJson((await cli(["inspect", "--root", root, "--file", path])).text),
        "file",
        "conventions",
      );
  const source = await conventions("src/Old.txt");
  assert.equal(at(source, "writable"), true);
  assert.deepEqual(at(source, "names"), [
    { pattern: "^[a-z-]+\\.txt$", reason: "kebab-case sources" },
  ]);
  assert.equal(at(source, "rules", 0, "id"), "custom.no-token");
  assert.deepEqual(at(source, "exceptions"), [{ id: "legacy", rules: ["files.names"], max: 1 }]);
  const readme = await conventions("README.md");
  assert.deepEqual(at(readme, "rules"), []);
  assert.deepEqual(at(readme, "exceptions"), []);
  // protected and policy files are flagged before an agent tries to edit them
  assert.equal(at(await conventions("vendor/lib.txt"), "writable"), false);
  assert.equal(at(await conventions("plumb.json"), "writable"), false);
  // a file that does not exist yet still gets the conventions it would fall under
  assert.equal(at(await conventions("src/new.txt"), "rules", 0, "id"), "custom.no-token");
});

await test("instructions fail closed on an invalid policy", async () => {
  const root = repository({ "plumb.json": "{" });
  let out = "";
  assert.equal(await main(["instructions", "--root", root], (chunk) => (out += chunk)), 2);
  assert.match(out, /run\.failed/);
});
