import assert from "node:assert/strict";
import test from "node:test";

import { docs, rules, summary } from "./docs-support.ts";

await test("a root README index includes every nested guide", async () => {
  const contents = {
    "README.md": "# Index\n\n[agents](AGENTS.md)\n",
    "AGENTS.md": "# Agents\n",
    "docs/guide.md": "# Guide\n",
  };
  assert.deepEqual(
    summary(await docs(contents, { preset: "ozmikhail", docs: { index: "README.md" } })),
    [["docs.index", "README.md", "Missing guide docs/guide.md."]],
  );
  assert.deepEqual(
    await docs(
      { ...contents, "README.md": contents["README.md"] + "[guide](docs/guide.md)\n" },
      { preset: "ozmikhail", docs: { index: "README.md" } },
    ),
    [],
  );
});

await test("local inline, reference, image, HTML and anchor links resolve", async () => {
  assert.deepEqual(
    await docs({
      "README.md": [
        "# Readme",
        "",
        "[Setup][guide]",
        '[again](docs/guide.md#setup "second setup")',
        "![image](<images/a b.png> 'title')",
        "[balanced](docs/file(1).md)",
        '<a href="docs/guide.md#custom">custom</a>',
        '[guide]: docs/guide.md#setup "guide"',
        "",
        "`[not a link](missing.md)`",
        "",
      ].join("\n"),
      "docs/guide.md": '# Guide\n\n## Setup\n\nText\n\n## Other\n\n<a id="custom"></a>\n',
      "docs/file(1).md": "# File\n",
      "images/a b.png": "\0",
    }),
    [],
  );
});

await test("broken paths, malformed percent escapes and outside links fail with their lines", async () => {
  const problems = await docs({
    "README.md":
      "# Readme\n\n[missing](gone.md)\n[heading](guide.md#absent)\n[outside](../outside.md)\n[encoding](%XX.md)\n",
    "guide.md": "# Here\n",
  });
  assert.deepEqual(rules(problems), ["docs.links", "docs.links", "docs.links", "docs.links"]);
  assert.deepEqual(
    problems.map(({ line }) => line),
    [3, 4, 5, 6],
  );
});

await test("nested list links are checked while fenced examples remain data", async () => {
  const problems = await docs({
    "README.md":
      "# Readme\n\n- guides\n    - [missing](missing.md)\n\n```md\n[example](missing.md)\n```\n",
  });
  assert.deepEqual(
    problems.map(({ rule, line }) => [rule, line]),
    [["docs.links", 4]],
  );
});

await test("fences nested in list items are masked for both backtick and tilde forms", async () => {
  assert.deepEqual(
    await docs({
      "README.md":
        "# Readme\n\n- item\n\n    ~~~md\n    [x](nope.md)\n    ~~~\n\n- item\n\n    ```md\n    [x](nope.md)\n    ```\n",
    }),
    [],
  );
  assert.deepEqual(
    await docs({ "README.md": "# Readme\n\n````md\n```\n[x](nope.md)\n```\n````\n" }),
    [],
  );
});

await test("unfinished code fences and HTML comments produce incomplete results", async () => {
  const problems = await docs({
    "README.md": "# Readme\n\n```md\n[hidden](missing.md)\n",
    "guide.md": "# Guide\n\n<!-- unfinished\n",
  });
  assert.equal(problems.length, 2);
  assert.ok(
    problems.every(
      ({ rule, status, suppressible }) =>
        rule === "docs.syntax" && status === "incomplete" && suppressible === false,
    ),
  );
});

await test("undefined reference labels fail while bare brackets stay ordinary text", async () => {
  const problems = await docs({
    "README.md":
      "# Readme\n\n[ok][guide] [bad][nope] [collapsed][] [plain]\n\n[guide]: guide.md\n[collapsed]: guide.md\n",
    "guide.md": "# Guide\n",
  });
  assert.deepEqual(summary(problems), [
    ["docs.links", "README.md", "Undefined reference label nope."],
  ]);
  assert.equal(problems[0].line, 3);
});

await test("a directory target fails and must name its index.md", async () => {
  assert.deepEqual(
    rules(await docs({ "README.md": "# Readme\n\n[folder](sub/)\n", "sub/index.md": "# Sub\n" })),
    ["docs.links"],
  );
  assert.deepEqual(
    rules(await docs({ "README.md": "# Readme\n\n[folder](sub)\n", "sub/index.md": "# Sub\n" })),
    ["docs.links"],
  );
  assert.deepEqual(
    await docs({ "README.md": "# Readme\n\n[folder](sub/index.md)\n", "sub/index.md": "# Sub\n" }),
    [],
  );
  assert.deepEqual(
    await docs({ "README.md": "# Readme\n\n[scripts](scripts/)\n", "scripts/run.mjs": "x\n" }),
    [],
    "a source folder without an index may be linked as is",
  );
  assert.deepEqual(
    rules(await docs({ "README.md": "# Readme\n\n[pkg](pkg/)\n", "pkg/README.md": "# Pkg\n" })),
    ["docs.links"],
  );
});

await test("headings need one leading H1, ATX syntax, no skipped levels and no repeats under a parent", async () => {
  assert.deepEqual(
    await docs({
      "README.md":
        "# Title\n\n## One\n\n### Deep\n\n## Two\n\n### Notes\n\n## Three\n\n### Notes\n",
    }),
    [],
  );
  assert.deepEqual(
    await docs({ "README.md": "# Title\n\n## Same\n\n## Same\n" }).then((items) =>
      items.map(({ rule, message }) => [rule, message]),
    ),
    [["docs.headings", 'Heading "Same" repeats under the same parent.']],
  );
  assert.deepEqual(rules(await docs({ "README.md": "## Early\n\n# Late\n" })), ["docs.headings"]);
  assert.deepEqual(rules(await docs({ "README.md": "# One\n\n# Two\n" })), ["docs.headings"]);
  assert.deepEqual(rules(await docs({ "README.md": "Intro\n\n# Late\n" })), ["docs.headings"]);
  assert.deepEqual(rules(await docs({ "README.md": "# Title\n\n#### Skipped\n" })), [
    "docs.headings",
  ]);
  assert.deepEqual(rules(await docs({ "README.md": "# Title\n\nSetext\n------\n" })), [
    "docs.headings",
  ]);
  assert.deepEqual(rules(await docs({ "README.md": "Title\n=====\n" })), ["docs.headings"]);
});

await test("headings inside fences and front matter are not structure", async () => {
  assert.deepEqual(
    await docs({
      "README.md":
        "---\ntitle: Example\n---\n# Title\n\n```text\n## Not a heading\n## Not a heading\n```\n",
    }),
    [],
  );
  assert.deepEqual(
    rules(await docs({ "README.md": "---\ntitle: Example\n---\n## Missing H1\n" })),
    ["docs.headings"],
  );
});

await test("anchors still resolve after a repeated heading, which is itself reported", async () => {
  const problems = await docs({
    "README.md": "# Readme\n\n[again](docs/guide.md#setup-1)\n[first](docs/guide.md#setup)\n",
    "docs/guide.md": "# Guide\n\n## Setup\n\n## Setup\n",
  });
  assert.deepEqual(rules(problems), ["docs.headings"]);
});

await test("every fence names its language, and text is a valid language", async () => {
  assert.deepEqual(rules(await docs({ "README.md": "# Readme\n\n```\ncode\n```\n" })), [
    "docs.fences",
  ]);
  assert.deepEqual(rules(await docs({ "README.md": "# Readme\n\n~~~\ncode\n~~~\n" })), [
    "docs.fences",
  ]);
  assert.deepEqual(await docs({ "README.md": "# Readme\n\n```text\ncode\n```\n" }), []);
});

await test("sections form a closed set and every folder keeps its index", async () => {
  const config = {
    preset: "portable",
    docs: { index: "docs/index.md", sections: ["guides", "reference"] },
  };
  const pass = {
    "docs/index.md": "# Docs\n\n[Guides](guides/index.md)\n[Reference](reference/index.md)\n",
    "docs/guides/index.md": "# Guides\n\n[Start](start.md)\n",
    "docs/guides/start.md": "# Start\n",
    "docs/reference/index.md": "# Reference\n\n[Flow](flow.svg)\n",
    "docs/reference/flow.svg": "<svg/>\n",
  };
  assert.deepEqual(await docs(pass, config), []);
  assert.deepEqual(
    rules(await docs({ ...pass, "docs/misc/index.md": "# Misc\n" }, config)).sort(),
    ["docs.index", "docs.layout", "docs.layout"],
  );
  assert.deepEqual(
    rules(
      await docs({ ...pass, "docs/index.md": "# Docs\n\n[Guides](guides/index.md)\n" }, config),
    ).sort(),
    ["docs.index", "docs.layout"],
  );
  assert.deepEqual(
    summary(await docs({ ...pass, "docs/guides/index.md": "# Guides\n" }, config)).filter(
      ([rule]) => rule === "docs.index",
    ),
    [["docs.index", "docs/guides/index.md", "Missing guide docs/guides/start.md."]],
  );
});

await test("ozmikhail requires the root index to link AGENTS.md even when the layout is sectioned", async () => {
  const config = { preset: "ozmikhail", docs: { index: "docs/index.md", sections: ["guides"] } };
  const pages = {
    "docs/index.md": "# Docs\n\n[Guides](guides/index.md)\n",
    "docs/guides/index.md": "# Guides\n",
    "AGENTS.md": "# Agents\n",
  };
  assert.deepEqual(
    summary(await docs(pages, config)).filter(([rule]) => rule === "docs.index"),
    [["docs.index", "docs/index.md", "Missing guide AGENTS.md."]],
  );
  assert.deepEqual(
    await docs(
      {
        ...pages,
        "docs/index.md": "# Docs\n\n[Guides](guides/index.md)\n[Agents](../AGENTS.md)\n",
      },
      config,
    ),
    [],
  );
});

await test("a folder without index.md, and an unlinked asset, fail the layout", async () => {
  const config = { preset: "portable", docs: { index: "docs/index.md", sections: ["guides"] } };
  const problems = await docs(
    {
      "docs/index.md": "# Docs\n",
      "docs/guides/start.md": "# Start\n",
      "docs/guides/diagram.svg": "<svg/>\n",
    },
    config,
  );
  assert.ok(
    problems.some(({ rule, path }) => rule === "docs.layout" && path === "docs/guides/index.md"),
  );
  assert.ok(
    problems.some(({ rule, path }) => rule === "docs.layout" && path === "docs/guides/diagram.svg"),
  );
});

await test("a page that no index or link reaches is an orphan", async () => {
  const config = {
    preset: "portable",
    docs: { index: "docs/index.md", sections: ["guides", "notes"] },
  };
  const problems = await docs(
    {
      "docs/index.md": "# Docs\n\n[Guides](guides/index.md)\n",
      "docs/guides/index.md": "# Guides\n",
      "docs/notes/index.md": "# Notes\n\n[Orphan](orphan.md)\n",
      "docs/notes/orphan.md": "# Orphan\n",
    },
    config,
  );
  assert.ok(
    problems.some(
      ({ rule, path, message }) =>
        rule === "docs.index" &&
        path === "docs/index.md" &&
        message === "Missing folder index docs/notes/index.md.",
    ),
  );
  assert.ok(
    problems.some(({ rule, path }) => rule === "docs.layout" && path === "docs/notes/orphan.md"),
  );
});
