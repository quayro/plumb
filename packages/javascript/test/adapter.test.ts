import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { displayWidth } from "../../../src/align.ts";
import type { Diagnostic } from "../../../src/diagnostics.ts";
import { context } from "../../../src/engine.ts";
import { check, fix } from "../index.ts";

const config = (files: string[]): string =>
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      jsx: "react-jsx",
    },
    files,
  });

function fixture(
  t: TestContext,
  files: Record<string, string | undefined>,
  projects: unknown[] = [{ root: ".", profile: "typescript" }],
  preset = "portable",
): ReturnType<typeof context> {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entries = {
    "plumb.json": JSON.stringify({ schemaVersion: 1, preset, projects }),
    "tsconfig.json": config(["entry.ts"]),
    ...files,
  };
  for (const [path, content] of Object.entries(entries)) {
    if (content === undefined) {
      continue;
    } // an explicit undefined leaves the file absent
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return context({ root });
}

await test("actual adapter distinguishes type violations from missing compiler inputs", async (t) => {
  const valid = await check(fixture(t, { "entry.ts": "export const answer: number = 1;\n" }));
  assert.ok(
    !valid.diagnostics.some((item) => item.status === "incomplete"),
    JSON.stringify(valid.diagnostics),
  );
  assert.ok(
    !valid.diagnostics.some((item) => item.rule === "javascript/types"),
    JSON.stringify(valid.diagnostics),
  );
  const invalid = await check(
    fixture(t, { "entry.ts": 'export const answer: number = "wrong";\n' }),
  );
  const typeError = invalid.diagnostics.find(
    (item) => item.rule === "javascript/types" && item.message.startsWith("TS2322:"),
  );
  assert.ok(typeError, JSON.stringify(invalid.diagnostics));
  assert.notEqual(typeError.status, "incomplete");
  const missing = await check(
    fixture(t, {
      "entry.ts": 'import { value } from "./missing";\nexport const answer = value;\n',
    }),
  );
  const unavailable = missing.diagnostics.find(
    (item) => item.rule === "javascript/types" && item.message.startsWith("TS2307:"),
  );
  assert.ok(unavailable, JSON.stringify(missing.diagnostics));
  assert.equal(unavailable.status, "incomplete");
  assert.equal(unavailable.suppressible, false);
});

await test("actual adapter lints a one-character nested project only under its owner", async (t) => {
  const ctx = fixture(
    t,
    {
      "entry.ts": "export const answer = 1;\n",
      "a/entry.tsx": "debugger;\nexport {};\n",
      "a/tsconfig.json": config(["entry.tsx"]),
    },
    [
      { root: ".", profile: "typescript" },
      { root: "a", profile: "react" },
    ],
  );
  const checked = await check(ctx);
  assert.ok(
    !checked.diagnostics.some((item) => item.status === "incomplete"),
    JSON.stringify(checked.diagnostics),
  );
  const findings = checked.diagnostics.filter(
    (item) => item.rule === "javascript/no-debugger" && item.path === "a/entry.tsx",
  );
  assert.equal(findings.length, 1, JSON.stringify(checked.diagnostics));
});

await test("a project's own javascript block replaces the top-level block for that project", async (t) => {
  const ban = (name: string, files?: string[]): unknown => ({
    syntax: [{ files, selectors: [{ selector: `Identifier[name='${name}']`, message: name }] }],
  });
  const files = (own: unknown): Record<string, string> => ({
    "plumb.json": JSON.stringify({
      schemaVersion: 1,
      preset: "portable",
      javascript: ban("shared"),
      projects: [
        { root: "a", profile: "typescript", javascript: own },
        { root: "b", profile: "typescript" },
      ],
    }),
    "a/entry.ts": "export const shared = 1;\nexport const local = 2;\n",
    "a/tsconfig.json": config(["entry.ts"]),
    "b/entry.ts": "export const shared = 1;\nexport const local = 2;\n",
    "b/tsconfig.json": config(["entry.ts"]),
  });
  const checked = await check(fixture(t, files(ban("local"))));
  const found = checked.diagnostics
    .filter((item) => item.rule === "javascript/plumb/syntax")
    .map((item) => `${item.path} ${item.message}`);
  assert.deepEqual(found.sort(), ["a/entry.ts local", "b/entry.ts shared"], JSON.stringify(found));
  const unused = await check(fixture(t, files(ban("local", ["missing/**"]))));
  assert.ok(
    unused.diagnostics.some((item) =>
      item.message.startsWith("projects a: javascript.syntax[0].files: matches no selected source"),
    ),
    JSON.stringify(unused.diagnostics),
  );
  await assert.rejects(
    check(fixture(t, files({ dependencies: { allowed: ["react"] } }))),
    /^Error: projects a: javascript\.dependencies is repo-wide/,
  );
});

await test("Markdown tables stay aligned after Prettier, even when wider than the print width", async (t) => {
  const wide = "x".repeat(60);
  const ctx = fixture(
    t,
    {
      "entry.ts": "export const answer = 1;\n",
      "docs/guide.md": `# Guide\n\n| a | b |\n|---|---|\n| ${wide} | ${wide} |\n| 1 |\n`,
    },
    undefined,
    "ozmikhail",
  );
  await fix(ctx);
  const rows = readFileSync(join(ctx.root, "docs/guide.md"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("|"));
  assert.ok(rows[0].length > 100);
  assert.equal(new Set(rows.map(displayWidth)).size, 1, rows.join("\n"));
  const again = await fix(context({ root: ctx.root }));
  assert.ok(!again.written.includes("docs/guide.md"));
  const checked = await check(context({ root: ctx.root }));
  assert.ok(
    !checked.diagnostics.some(
      (item) => item.rule === "javascript/format" && item.path === "docs/guide.md",
    ),
    JSON.stringify(checked.diagnostics),
  );
});

await test("fix leaves a badly formatted source file passing the format check", async (t) => {
  const ctx = fixture(t, { "entry.ts": "export   const   answer=1\n" });
  const before = await check(context({ root: ctx.root }));
  assert.ok(
    before.diagnostics.some(
      (item) => item.rule === "javascript/format" && item.path === "entry.ts",
    ),
    JSON.stringify(before.diagnostics),
  );
  assert.ok((await fix(ctx)).written.includes("entry.ts"));
  const after = await check(context({ root: ctx.root }));
  assert.ok(
    !after.diagnostics.some(
      (item) => item.rule === "javascript/format" && item.path === "entry.ts",
    ),
    JSON.stringify(after.diagnostics),
  );
});

await test("the portable preset leaves Markdown tables to Prettier alone", async (t) => {
  const ctx = fixture(t, {
    "entry.ts": "export const answer = 1;\n",
    "guide.md": "| a | b |\n|---|---|\n| 1 |\n",
  });
  await fix(ctx);
  assert.equal(
    readFileSync(join(ctx.root, "guide.md"), "utf8"),
    "| a   | b   |\n| --- | --- |\n| 1   |\n",
  );
});

await test("ozmikhail dependency policy refuses ranges, unpinned managers, missing lockfiles and unlisted dependencies", async (t) => {
  const manifest = (extra = {}, dependencies = { "left-pad": "1.3.0" }) =>
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      packageManager: "bun@1.2.3",
      dependencies,
      ...extra,
    });
  const policy = (
    files: Record<string, string | undefined>,
    preset = "ozmikhail",
  ): Promise<Diagnostic[]> =>
    check(
      fixture(
        t,
        {
          "entry.ts": "export const answer = 1;\n",
          "bun.lock": "{}",
          "package.json": manifest(),
          ...files,
        },
        [{ root: ".", profile: "typescript" }],
        preset,
      ),
    ).then((result) =>
      result.diagnostics.filter((item) => item.rule === "javascript/dependencies"),
    );
  assert.deepEqual(await policy({}), []);
  assert.deepEqual(
    await policy({ "package.json": manifest({}, { "left-pad": "workspace:1.0.0" }) }),
    [],
  );
  assert.deepEqual(
    await policy({ "package.json": manifest({}, { "left-pad": "workspace:*" }) }),
    [],
    "workspace:* links the local package the lockfile records",
  );
  for (const peer of ["^19.2.8", "~1.3.0", ">=18", "^18.0.0 || ^19.0.0"]) {
    assert.deepEqual(
      await policy({ "package.json": manifest({ peerDependencies: { react: peer } }) }),
      [],
      peer,
    );
  }
  for (const peer of [
    "*",
    "latest",
    "x",
    "git+https://example.com/react.git",
    "file:../react",
    "workspace:^",
  ]) {
    assert.ok(
      (await policy({ "package.json": manifest({ peerDependencies: { react: peer } }) })).length >=
        1,
      peer,
    );
  }
  assert.ok(
    (await policy({ "package.json": manifest({ devDependencies: { react: "^19.2.8" } }) }))
      .length >= 1,
    "only peers may be ranges",
  );
  for (const range of [
    "^1.3.0",
    "~1.3.0",
    "*",
    "x",
    ">1.0.0",
    "1.0.0 || 2.0.0",
    "latest",
    "next",
    "git+https://example.com/left-pad.git",
    "file:../left-pad",
    "link:../left-pad",
    "https://example.com/left-pad.tgz",
    "workspace:^",
    "workspace:~",
  ]) {
    assert.ok(
      (await policy({ "package.json": manifest({}, { "left-pad": range }) })).length >= 1,
      range,
    );
  }
  assert.ok(
    (await policy({ "package.json": manifest({ packageManager: undefined }) })).some((item) =>
      /packageManager/.test(item.message),
    ),
  );
  assert.ok(
    (await policy({ "package.json": manifest({ packageManager: "bun" }) })).some((item) =>
      /packageManager/.test(item.message),
    ),
  );
  assert.ok(
    (await policy({ "bun.lock": undefined })).some((item) => /lockfile/.test(item.message)),
  );
  assert.ok(
    (
      await policy({
        "plumb.json": JSON.stringify({
          schemaVersion: 1,
          preset: "ozmikhail",
          projects: [{ root: ".", profile: "typescript" }],
          javascript: { dependencies: { allowed: ["@scope/*", "other"] } },
        }),
      })
    ).some((item) => /allow-list/.test(item.message)),
  );
  assert.deepEqual(
    await policy({
      "plumb.json": JSON.stringify({
        schemaVersion: 1,
        preset: "ozmikhail",
        projects: [{ root: ".", profile: "typescript" }],
        javascript: { dependencies: { allowed: ["left-pad", "@scope/*"] } },
      }),
    }),
    [],
  );
  assert.ok(
    (await policy({ "package.json": "{ not json" })).some((item) => item.status === "incomplete"),
  );
  assert.deepEqual(
    await policy({ "package.json": manifest({}, { "left-pad": "^1.3.0" }) }, "portable"),
    [],
  );
});

await test("ozmikhail assertion policy reaches the pack through javascript.tests.assertions", async (t) => {
  const plumb = (tests?: Record<string, unknown>): string =>
    JSON.stringify({
      schemaVersion: 1,
      preset: "ozmikhail",
      projects: [{ root: ".", profile: "typescript" }],
      javascript: { ...(tests && { tests }) },
    });
  const violations = async (
    files: Record<string, string>,
    tests?: Record<string, unknown>,
  ): Promise<Diagnostic[]> =>
    (
      await check(
        fixture(t, {
          "entry.ts": "export const answer = 1;\n",
          "bun.lock": "{}",
          "package.json": JSON.stringify({
            name: "app",
            version: "1.0.0",
            packageManager: "bun@1.2.3",
          }),
          "plumb.json": plumb(tests),
          "tsconfig.json": config(["entry.ts", "src/a.test.ts"]),
          ...files,
        }),
      )
    ).diagnostics.filter((item) => item.rule === "javascript/plumb/test-assertions");
  assert.equal(
    (
      await violations({
        "src/a.test.ts": 'import { test } from "node:test";\ntest("x", () => {});\n',
      })
    ).length,
    1,
  );
  assert.equal(
    (
      await violations({
        "src/a.test.ts":
          'import { test } from "node:test";\ntest("x", () => { expect(1).toBe(1); });\n',
      })
    ).length,
    0,
  );
  assert.equal(
    (
      await violations(
        {
          "src/a.test.ts": 'import { test } from "node:test";\ntest("x", () => { verify(1); });\n',
        },
        { assertions: "^verify" },
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await violations(
        {
          "src/a.test.ts":
            'import { test } from "node:test";\ntest("x", () => { expect(1).toBe(1); });\n',
        },
        { assertions: "^verify" },
      )
    ).length,
    1,
  );
});
