import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { definePlumb } from "../src/config.ts";
import { checkDocs, fixDocs } from "../src/docs.ts";
import { inventory } from "../src/files.ts";
import { adr, docs, generated, record, region, rules, summary } from "./docs-support.ts";
import { policy } from "./support.ts";

await test("decision records keep their filename, sections, status and numbering", async () => {
  assert.deepEqual(
    await docs(
      {
        "docs/decisions/index.md": "# Decisions\n",
        "docs/decisions/0001-use-plumb.md": record("Use plumb"),
        "docs/decisions/0002-second.md": record("Second", "## Status\n\nProposed"),
      },
      adr,
    ),
    [],
  );
  assert.deepEqual(
    await docs(
      {
        "docs/decisions/0001-use-plumb.md": record("Use plumb").replace(
          "Status: Accepted",
          "## Status\n\nAccepted",
        ),
      },
      adr,
    ),
    [],
  );
  assert.deepEqual(
    summary(
      await docs({ "docs/decisions/0001-use-plumb.md": record("Use plumb", "Status: Maybe") }, adr),
    ),
    [
      [
        "docs.kinds",
        "docs/decisions/0001-use-plumb.md",
        "Status must be one of Proposed, Accepted, Superseded, Deprecated.",
      ],
    ],
  );
  assert.deepEqual(
    summary(
      await docs(
        {
          "docs/decisions/0001-use-plumb.md": record("Use plumb").replace(
            "## Consequences\n\nQ\n",
            "",
          ),
        },
        adr,
      ),
    ),
    [
      [
        "docs.kinds",
        "docs/decisions/0001-use-plumb.md",
        "Missing or out-of-order section ## Consequences.",
      ],
    ],
  );
  assert.deepEqual(
    summary(
      await docs(
        {
          "docs/decisions/0001-use-plumb.md":
            "# Use\n\nStatus: Accepted\n\n## Decision\n\nD\n\n## Context\n\nC\n\n## Consequences\n\nQ\n",
        },
        adr,
      ),
    ).map(([rule]) => rule),
    ["docs.kinds"],
  );
  assert.deepEqual(
    summary(await docs({ "docs/decisions/decision.md": record("Bad name") }, adr)).map(
      ([rule]) => rule,
    ),
    ["docs.kinds", "docs.kinds"],
  );
});

await test("decision record numbering has no gaps or duplicates", async () => {
  const gap = await docs(
    {
      "docs/decisions/0001-a.md": record("A"),
      "docs/decisions/0002-b.md": record("B"),
      "docs/decisions/0005-c.md": record("C"),
    },
    adr,
  );
  assert.deepEqual(
    gap.map(({ path, message }) => [path, message]),
    [["docs/decisions/0005-c.md", "Sequence should continue at 0003, not 0005."]],
  );
  const duplicate = await docs(
    {
      "docs/decisions/0001-a.md": record("A"),
      "docs/decisions/0002-b.md": record("B"),
      "docs/decisions/0002-c.md": record("C"),
    },
    adr,
  );
  assert.deepEqual(
    duplicate.map(({ path, message }) => [path, message]),
    [["docs/decisions/0002-c.md", "Sequence number 0002 is duplicated."]],
  );
});

await test("a kind or generated entry that matches nothing is incomplete", async () => {
  const problems = await docs(
    { "README.md": "# Readme\n" },
    { preset: "portable", docs: { kinds: [{ files: ["docs/decisions/*.md"], name: "^.*$" }] } },
  );
  assert.deepEqual(
    problems.map(({ rule, status }) => [rule, status]),
    [["docs.scope", "incomplete"]],
  );
});

await test("a configured documentation section that governs no Markdown is incomplete", async () => {
  const problems = await docs({ "src/a.ts": "export {};\n" }, { preset: "portable", docs: {} });
  assert.deepEqual(
    problems.map(({ rule, status, suppressible }) => [rule, status, suppressible]),
    [["docs.scope", "incomplete", false]],
  );
});

await test("a generated region must match its pinned command output", async () => {
  assert.deepEqual(
    await docs({ "docs/reference.md": region("\n```text\nusage: plumb\n```\n") }, generated()),
    [],
  );
  const drift = await docs(
    { "docs/reference.md": region("```text\nusage: old\n```") },
    generated(),
  );
  assert.deepEqual(
    drift.map(({ rule, path }) => [rule, path]),
    [["docs.generated", "docs/reference.md"]],
  );
  const missing = await docs({ "docs/reference.md": "# Reference\n" }, generated());
  assert.deepEqual(
    missing.map(({ rule, status }) => [rule, status]),
    [["docs.generated", "incomplete"]],
  );
  const failing = await docs(
    { "docs/reference.md": region("\n```text\nusage: plumb\n```\n") },
    generated([process.execPath, "-e", "process.exit(3)"]),
  );
  assert.deepEqual(
    failing.map(({ rule, status }) => [rule, status]),
    [["docs.generated", "incomplete"]],
  );
});

await test("plumb fix rewrites only the drifted generated region", async () => {
  const root = mkdtempSync(join(tmpdir(), "plumb-docs-fix-"));
  try {
    const before =
      "# Reference\n\nKeep this.\n\n<!-- plumb:generated cli -->\n```text\nusage: old\n```\n<!-- /plumb:generated -->\n\nAnd this.\n";
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/reference.md"), before);
    const files = inventory(root).files,
      context = { root, files, config: policy(generated()), writableFiles: files };
    const fixed = await fixDocs(context);
    assert.deepEqual(fixed.written, ["docs/reference.md"]);
    assert.equal(
      readFileSync(join(root, "docs/reference.md"), "utf8"),
      "# Reference\n\nKeep this.\n\n<!-- plumb:generated cli -->\n\n```text\nusage: plumb\n```\n\n<!-- /plumb:generated -->\n\nAnd this.\n",
    );
    assert.deepEqual(await checkDocs(context), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("a generated region in a file that cannot be rewritten is reported, not written", async () => {
  const root = mkdtempSync(join(tmpdir(), "plumb-docs-lock-"));
  try {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/reference.md"), region("```text\nold\n```"));
    const files = inventory(root).files;
    const result = await fixDocs({ root, files, config: policy(generated()), writableFiles: [] });
    assert.deepEqual(result.written, []);
    assert.deepEqual(
      result.diagnostics.map(({ rule }) => rule),
      ["docs.generated"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("ozmikhail documentation with a clean AGENTS.md passes", async () => {
  assert.deepEqual(
    await docs({ "AGENTS.md": "# Agents\n\nRules.\n" }, { preset: "ozmikhail" }),
    [],
  );
  assert.deepEqual(rules(await docs({ "AGENTS.md": "Agents\n" }, { preset: "ozmikhail" })), [
    "docs.headings",
  ]);
});

await test("the documentation and comment policy keys validate their shapes", () => {
  const valid = {
    schemaVersion: 1,
    docs: {
      index: "./docs/index.md",
      root: "docs",
      sections: ["guides"],
      kinds: [
        {
          files: ["docs/decisions/*.md"],
          name: "^\\d{4}-.+\\.md$",
          sections: ["Context"],
          status: ["Accepted"],
          sequence: true,
        },
      ],
      generated: [
        { file: "docs/reference.md", region: "cli", command: ["node", "bin/plumb.ts", "--help"] },
      ],
    },
    comments: { tasks: "TODO\\(#\\d+\\)" },
  };
  assert.equal(definePlumb(valid).docs?.index, "docs/index.md");
  assert.throws(() => definePlumb({ ...valid, docs: { ...valid.docs, sections: ["Guides"] } }));
  assert.throws(() =>
    definePlumb({
      ...valid,
      docs: { generated: [{ file: "docs/reference.md", region: "cli", command: [] }] },
    }),
  );
  assert.throws(() => definePlumb({ ...valid, comments: { tasks: "(" } }));
});

await test("equivalent rewrites cannot slip past the link, heading and status rules", async () => {
  assert.deepEqual(
    rules(await docs({ "README.md": "# Readme\n\n[folder](./sub/)\n", "sub/index.md": "# Sub\n" })),
    ["docs.links"],
  );
  assert.deepEqual(
    await docs({
      "README.md": "# Readme\n\n[ok][GUIDE]\n\n[guide]: guide.md\n",
      "guide.md": "# Guide\n",
    }),
    [],
  );
  assert.deepEqual(rules(await docs({ "README.md": "#Readme\n" })), ["docs.headings"]);
  assert.deepEqual(rules(await docs({ "README.md": "# Title\n\n## Setup\n\n## setup\n" })), [
    "docs.headings",
  ]);
  assert.deepEqual(rules(await docs({ "README.md": "\n---\ntitle: x\n---\n# Title\n" })), [
    "docs.headings",
    "docs.headings",
  ]);
  assert.deepEqual(rules(await docs({ "README.md": "# Title\n\n```\n# not structure\n```\n" })), [
    "docs.fences",
  ]);
  const hidden =
    "# Use\n\n```text\nStatus: Accepted\n```\n\n## Context\n\nC\n\n## Decision\n\nD\n\n## Consequences\n\nQ\n";
  assert.deepEqual(
    summary(await docs({ "docs/decisions/0001-use.md": hidden }, adr)).map(([rule]) => rule),
    ["docs.kinds", "docs.kinds"],
  );
});
