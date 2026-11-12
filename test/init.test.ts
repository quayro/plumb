import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { schema, validateSchema } from "../src/config.ts";
import { digest } from "../src/files.ts";
import { init } from "../src/init.ts";
import { listPacks } from "../src/packs.ts";
import { at } from "../src/schema.ts";
import { bin, cli, repository, roots, temporary, write } from "./ratchet-support.ts";
import { mapped, parseJson, parseReport } from "./support.ts";

function directory(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(temporary, "plumb-init-"));
  roots.push(root);
  write(root, files);
  return root;
}

const policyOf = (root: string): unknown =>
  parseJson(readFileSync(join(root, "plumb.json"), "utf8"));

const run = async (root: string, ...args: string[]) => {
  const { code, text } = await cli([...args, "--root", root]);
  return { code, result: parseJson(text) };
};

await test("init detects the languages a repository already uses", async () => {
  const cases: [Record<string, string>, unknown[], string[]][] = [
    [{}, [], []],
    [{ "src/a.ts": "" }, [{ root: ".", profile: "typescript" }], []],
    [{ "src/a.tsx": "", "b.ts": "" }, [{ root: ".", profile: "react" }], []],
    [
      { "src/lib.rs": "", "tool.py": "" },
      [
        { root: ".", profile: "python" },
        { root: ".", profile: "rust" },
      ],
      [],
    ],
    // a removed language is neither configured nor reported as an external profile
    [{ "lib/a.rb": "", "main.go": "" }, [], []],
  ];
  for (const [files, projects, external] of cases) {
    const root = directory(files),
      { code, result } = await run(root, "init");
    assert.equal(code, 0);
    assert.deepEqual(at(policyOf(root), "projects"), projects);
    // a language without a built-in profile is never silently configured
    assert.deepEqual(at(result, "detected", "external"), external);
  }
  // an explicit profile wins over detection
  const root = directory({ "src/a.ts": "" });
  await run(root, "init", "--profile", "generic");
  assert.deepEqual(at(policyOf(root), "projects"), []);
});

await test("init copies the chosen packs and pins them as bundles the check enforces", async () => {
  const root = directory({ "notes.txt": "fine\n" }),
    { code, result } = await run(root, "init", "--preset", "portable", "--pack", "hygiene,secrets");
  assert.equal(code, 0);
  assert.deepEqual(at(result, "written"), [
    ".plumb/packs/hygiene.json",
    ".plumb/packs/secrets.json",
    "plumb.json",
  ]);
  const bundles = at(policyOf(root), "bundles");
  for (const pack of listPacks().filter((entry) => ["hygiene", "secrets"].includes(entry.name))) {
    assert.ok(mapped(bundles, (entry) => at(entry, "sha256")).includes(pack.sha256));
    assert.equal(digest(readFileSync(join(root, pack.path))), pack.sha256);
  }
  assert.equal((await run(root, "check")).code, 0);
  write(root, {
    "a.orig": "x\n",
    "merge.txt": "<<<<<<< HEAD\nours\n",
    "key.txt": "-----BEGIN RSA PRIVATE KEY-----\n",
    "aws.txt": `id = ${"AKIA"}${"A".repeat(16)}\n`,
  });
  const failed = await cli(["check", "--root", root]);
  assert.equal(failed.code, 1);
  assert.deepEqual(
    parseReport(failed.text).diagnostics.map((item) => [item.rule, item.path]),
    [
      ["files.forbidden", "a.orig"],
      ["custom.no-cloud-keys", "aws.txt"],
      ["custom.no-private-keys", "key.txt"],
      ["custom.no-conflict-markers", "merge.txt"],
    ],
  );
  // an edited pack no longer matches its pin, so the policy is invalid rather than weaker
  write(root, { ".plumb/packs/hygiene.json": '{"schemaVersion":1}\n' });
  assert.equal((await run(root, "check")).code, 2);
});

await test("a repository type selects its packs; unknown names write nothing", async () => {
  const library = directory();
  await run(library, "init", "--type", "library");
  assert.deepEqual(
    mapped(at(policyOf(library), "bundles"), (entry) => at(entry, "path")),
    ["hygiene", "secrets", "conventional-commits", "open-source"].map(
      (name) => `.plumb/packs/${name}.json`,
    ),
  );
  for (const flags of [
    ["--pack", "nope"],
    ["--type", "spaceship"],
    ["--profile", "cobol"],
    ["--preset", "lax"],
  ]) {
    const root = directory();
    assert.equal((await run(root, "init", ...flags)).code, 2);
    assert.equal(existsSync(join(root, "plumb.json")), false);
    assert.equal(existsSync(join(root, ".plumb")), false);
  }
  const existing = directory({ "plumb.json": "{}\n" });
  assert.equal((await run(existing, "init", "--pack", "hygiene")).code, 2);
  assert.equal(readFileSync(join(existing, "plumb.json"), "utf8"), "{}\n");
});

await test("init reuses the conventions it finds and suggests the packs that fit", async () => {
  const history = (subject: string): string => {
    const root = repository({ ".husky/pre-commit": "npx test\n" });
    for (let index = 0; index < 6; index++) {
      const made = spawnSync(
        "git",
        [
          ...["-c", "user.name=plumb", "-c", "user.email=plumb@example.test"],
          ...["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m"],
          `${subject} ${index}`,
        ],
        { cwd: root },
      );
      assert.equal(made.status, 0);
    }
    return root;
  };
  const conventional = await run(history("feat: step"), "init");
  assert.equal(at(conventional.result, "detected", "conventionalCommits"), true);
  assert.equal(at(conventional.result, "detected", "hookManager"), "husky");
  assert.deepEqual(at(conventional.result, "suggestedPacks"), [
    "hygiene",
    "secrets",
    "conventional-commits",
  ]);
  // free-form history and a directory outside git suggest only what suits every repository
  for (const root of [history("wip"), directory()]) {
    const { result } = await run(root, "init");
    assert.equal(at(result, "detected", "conventionalCommits"), false);
    assert.deepEqual(at(result, "suggestedPacks"), ["hygiene", "secrets"]);
  }
});

await test("interactive answers replace the detected defaults and are validated the same way", async () => {
  const root = directory({ "src/a.ts": "" }),
    asked: [string, string][] = [],
    answers = ["portable", "none", "open-source"];
  const result = await init({ command: "init", rest: [], root }, (question, fallback) => {
    asked.push([question, fallback]);
    return Promise.resolve(answers[asked.length - 1] ?? fallback);
  });
  // each question offers what the repository analysis found
  assert.deepEqual(
    asked.map(([, fallback]) => fallback),
    ["ozmikhail", "typescript", "hygiene,secrets"],
  );
  assert.deepEqual(result.written, [".plumb/packs/open-source.json", "plumb.json"]);
  assert.deepEqual(at(policyOf(root), "projects"), []);
  assert.equal(at(policyOf(root), "preset"), "portable");
  const refused = directory();
  await assert.rejects(
    init({ command: "init", rest: [], root: refused }, () => Promise.resolve("cobol")),
    /Unknown/,
  );
  assert.equal(existsSync(join(refused, "plumb.json")), false);
});

await test("init --interactive reads answers piped on stdin, and the end of input keeps defaults", () => {
  const interactive = (input: string) => {
    const root = directory({ "src/a.ts": "" }),
      child = spawnSync(process.execPath, [bin, "init", "--interactive", "--root", root], {
        encoding: "utf8",
        input,
      });
    assert.equal(child.status, 0, child.stdout);
    return policyOf(root);
  };
  // the answers arrive before the first question is asked
  const answered = interactive("portable\nnone\nhygiene\n");
  assert.equal(at(answered, "preset"), "portable");
  assert.deepEqual(at(answered, "projects"), []);
  const defaults = interactive("portable\n");
  assert.deepEqual(at(defaults, "projects"), [{ root: ".", profile: "typescript" }]);
});

await test("every shipped pack is a valid policy with a stable pin", async () => {
  const listed = at((await run(directory(), "packs")).result, "packs");
  assert.deepEqual(
    mapped(listed, (pack) => at(pack, "name")),
    ["hygiene", "secrets", "conventional-commits", "open-source"],
  );
  for (const pack of listPacks()) {
    validateSchema(parseJson(pack.content), schema);
    assert.equal(pack.sha256, digest(pack.content));
    assert.ok(pack.suits.length);
  }
});

const ORG_PACK = `${JSON.stringify({
  schemaVersion: 1,
  preset: "portable",
  files: { forbidden: ["**/*.bak"] },
})}\n`;

// a registry an organization hosts: an index beside the packs it pins
function registry(packs: Record<string, string>, pin = digest): string {
  const folder = directory(packs),
    index = join(folder, "index.json");
  writeFileSync(
    index,
    JSON.stringify({
      schemaVersion: 1,
      packs: Object.entries(packs).map(([path, content]) => ({
        name: path.replace(/\.json$/, "").replaceAll("/", "-"),
        description: "An organization pack.",
        suits: ["application"],
        path,
        sha256: pin(content),
      })),
    }),
  );
  return index;
}

await test("the shipped registry exports to a directory that reads back identically", async () => {
  const target = join(directory(), "registry"),
    exported = await run(directory(), "packs", "--export", target);
  assert.equal(exported.code, 0);
  assert.equal(mapped(at(exported.result, "written"), String).length, 5);
  const listed = at(
    (await run(directory(), "packs", "--index", join(target, "index.json"))).result,
    "packs",
  );
  assert.deepEqual(listed, at((await run(directory(), "packs")).result, "packs"));
  // an export never replaces what is already published
  assert.equal((await run(directory(), "packs", "--export", target)).code, 2);
  // the registry published in this repository is that export
  const published = new URL("../packs/", import.meta.url);
  assert.deepEqual(
    parseJson(readFileSync(new URL("index.json", published), "utf8")),
    parseJson(readFileSync(join(target, "index.json"), "utf8")),
  );
  for (const pack of listPacks()) {
    assert.equal(readFileSync(new URL(`${pack.name}.json`, published), "utf8"), pack.content);
  }
});

await test("init installs a pack from another registry, pinned and enforced", async () => {
  const index = registry({ "org-base.json": ORG_PACK }),
    root = directory({ "old.bak": "x\n" });
  const { code, result } = await run(
    root,
    ...["init", "--preset", "portable", "--index", index, "--pack", "org-base"],
  );
  assert.equal(code, 0);
  assert.deepEqual(at(result, "written"), [".plumb/packs/org-base.json", "plumb.json"]);
  assert.equal(at(policyOf(root), "bundles", 0, "sha256"), digest(ORG_PACK));
  const checked = await cli(["check", "--root", root]);
  assert.equal(checked.code, 1);
  assert.equal(parseReport(checked.text).diagnostics[0]?.rule, "files.forbidden");
  // a shipped pack is not in this registry
  assert.equal((await run(directory(), "init", "--index", index, "--pack", "hygiene")).code, 2);
});

await test("a registry that cannot be trusted lists nothing", async () => {
  const outside = directory({ "secret.json": ORG_PACK });
  for (const index of [
    // the pack was edited after it was pinned
    registry({ "org-base.json": ORG_PACK }, () => "0".repeat(64)),
    // the pack is not a policy
    registry({ "org-base.json": '{"rules":"everything"}\n' }),
    // a copied pack cannot carry imports of its own
    registry({
      "org-base.json": `${JSON.stringify({ schemaVersion: 1, bundles: [{ path: "x.json", sha256: "0".repeat(64) }] })}\n`,
    }),
    // the index points outside its own directory
    registry({ [`../${outside.split("/").at(-1) ?? ""}/secret.json`]: ORG_PACK }),
    join(directory(), "missing.json"),
  ]) {
    const { code, result } = await run(directory(), "packs", "--index", index);
    assert.equal(code, 2, index);
    assert.equal(at(result, "packs"), undefined);
    const root = directory();
    assert.equal((await run(root, "init", "--index", index, "--pack", "org-base")).code, 2);
    assert.equal(existsSync(join(root, "plumb.json")), false);
  }
});
