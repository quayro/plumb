import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import { test } from "node:test";

import { eslintGlobs, scopeProblems, validateOptions } from "../eslint/options.ts";
import { plumbComponentRules } from "../eslint/react/components.ts";
import { plumbCallRules } from "../eslint/rules/calls.ts";
import { plumbCommentRules } from "../eslint/rules/comments.ts";
import { plumbLayoutRules } from "../eslint/rules/layout.ts";
import { scopedRule } from "../eslint/scoped.ts";
import { syntaxSelectors } from "../eslint/syntax.ts";
import type { RuleModule } from "../eslint/types.ts";
import { globMatches } from "../shared/glob.ts";
import { double, listen, type Reported } from "./lint-support.ts";

await test("an opt-in cannot reconfigure another enabled preset contract", () => {
  assert.throws(
    () =>
      validateOptions({
        tailwind: {},
        rules: [{ rules: { "plumb-react/class-set": ["error", { inline: false }] } }],
      }),
    /cannot reconfigure/,
  );
  assert.doesNotThrow(() =>
    validateOptions({
      rules: [{ rules: { "plumb-react/class-set": ["error", { inline: true }] } }],
    }),
  );
});

await test("syntax scopes union and factory allowances never erase other restrictions", () => {
  const options = {
    root: "/repo",
    profile: "react",
    source: ["src/**"],
    errorFactory: { message: "use factory", allowIn: ["src/error.ts"] },
    syntax: [
      {
        selectors: [{ selector: "DebuggerStatement", message: "no debugger" }],
      },
      {
        files: ["src/**"],
        selectors: [{ selector: "WithStatement", message: "no with" }],
      },
      {
        files: ["src/error.ts"],
        selectors: [{ selector: "EmptyStatement", message: "no empty" }],
      },
    ],
  };
  const selected = syntaxSelectors(options, "/repo/src/error.ts");
  for (const message of [
    "no debugger",
    "no with",
    "no empty",
    "Await inside a function: a top-level await holds the entry chunk.",
  ]) {
    assert.ok(selected.some((entry) => entry.message === message));
  }
  assert.ok(!selected.some((entry) => entry.message === "use factory"));
  const other = syntaxSelectors(options, "/repo/tools/error.ts");
  assert.ok(other.some((entry) => entry.message === "use factory"));
  assert.ok(!other.some((entry) => ["no with", "no empty"].includes(entry.message)));
});

await test("overlapping contract rows each preserve their own state", () => {
  const received: unknown[] = [];
  const base: RuleModule = {
    meta: { type: "problem", schema: [], messages: {} },
    create: (context) => {
      let seen = 0;
      return {
        Identifier: () => seen++,
        "Program:exit": () => received.push([context.options[0], seen]),
      };
    },
  };
  const context = Object.freeze({
    filename: "/repo/src/a.ts",
    options: [
      [
        { files: ["src/**"], options: ["outer"] },
        { files: ["src/a.ts"], options: ["inner"] },
        { files: ["tools/**"], options: ["outside"] },
      ],
    ],
  });
  const visitors = listen(scopedRule(base, "/repo").create(double(context)));
  visitors.Identifier({});
  visitors["Program:exit"]({});
  assert.deepEqual(received, [
    ["outer", 1],
    ["inner", 1],
  ]);
});

await test("imports-first diagnoses order without changing real ESM dependency evaluation", async () => {
  const root = await mkdtemp(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-lint-order-"));
  try {
    const source = 'export { ready } from "./initialize.mjs";\nimport "./consume.mjs";\n';
    await writeFile(
      join(root, "initialize.mjs"),
      "globalThis.ready = true; export const ready = true;\n",
    );
    await writeFile(
      join(root, "consume.mjs"),
      'if (!globalThis.ready) throw new Error("initializer has not run");\n',
    );
    await writeFile(join(root, "entry.mjs"), source);
    const reports: Reported[] = [];
    const rule = plumbLayoutRules["imports-first"];
    const visitor = listen(
      rule.create(double({ report: (value: Reported) => reports.push(value) })),
    );
    visitor.Program({
      body: [{ type: "ExportNamedDeclaration" }, { type: "ImportDeclaration" }],
    });
    assert.equal(reports.length, 1);
    assert.equal(rule.meta.fixable, undefined);
    assert.equal(reports[0].fix, undefined);
    assert.equal(
      spawnSync(process.execPath, [join(root, "entry.mjs")], {
        encoding: "utf8",
      }).status,
      0,
    );
    const pass: Reported[] = [];
    listen(rule.create(double({ report: (value: Reported) => pass.push(value) }))).Program({
      body: [{ type: "ImportDeclaration" }, { type: "ExportNamedDeclaration" }],
    });
    assert.deepEqual(pass, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("client boundaries are retained for wrapper modules and missing directives require review", () => {
  const rule = plumbComponentRules["client-directive"];
  const reports: Reported[] = [];
  const visitors = listen(
    rule.create(double({ report: (entry: Reported) => reports.push(entry) })),
  );
  visitors["Program:exit"]({
    body: [
      { type: "ExpressionStatement", directive: "use client" },
      {
        type: "ExportNamedDeclaration",
        source: { value: "third-party-carousel" },
      },
    ],
  });
  assert.equal(reports.length, 0);
  visitors.JSXElement({});
  visitors["Program:exit"]({ body: [{ type: "ExportNamedDeclaration" }] });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].fix, undefined);
  assert.equal(rule.meta.fixable, undefined);
});

await test("a client marker can share a directive prologue and a later string is not a directive", () => {
  const reports: Reported[] = [];
  const visitors = listen(
    plumbComponentRules["client-directive"].create(
      double({
        report: (entry: Reported) => reports.push(entry),
      }),
    ),
  );
  visitors.JSXElement({});
  visitors["Program:exit"]({
    body: [
      { type: "ExpressionStatement", directive: "use strict" },
      { type: "ExpressionStatement", directive: "use client" },
      { type: "ExportNamedDeclaration" },
    ],
  });
  assert.equal(reports.length, 0);
  visitors["Program:exit"]({
    body: [{ type: "ImportDeclaration" }, { type: "ExpressionStatement", directive: "use client" }],
  });
  assert.equal(reports.length, 1);
});

await test("module-scope registrations refuse instance field initializers", () => {
  const reports: Reported[] = [];
  const options = [{ calls: [{ callee: "^register$", args: ["literal"], moduleScope: true }] }];
  const call = {
    type: "CallExpression",
    callee: { type: "Identifier", name: "register" },
    arguments: [{ type: "Literal", value: "known" }],
  };
  const field = listen(
    plumbCallRules["literal-calls"].create(
      double({
        options,
        report: (entry: Reported) => reports.push(entry),
        sourceCode: {
          getAncestors: () => [{ type: "PropertyDefinition", static: false }],
        },
      }),
    ),
  );
  field.CallExpression(call);
  assert.deepEqual(
    reports.map((entry) => entry.messageId),
    ["scope"],
  );
  reports.length = 0;
  listen(
    plumbCallRules["literal-calls"].create(
      double({
        options,
        report: (entry: Reported) => reports.push(entry),
        sourceCode: { getAncestors: () => [{ type: "Program" }] },
      }),
    ),
  ).CallExpression(call);
  assert.equal(reports.length, 0);
});

await test("visible literal expressions and non-component re-exports cannot bypass React contracts", () => {
  const reports: Reported[] = [];
  const words = listen(
    plumbComponentRules.words.create(
      double({
        options: [],
        report: (entry: Reported) => reports.push(entry),
      }),
    ),
  );
  words.JSXExpressionContainer({
    parent: { type: "JSXElement" },
    expression: { type: "Literal", value: "Hello world" },
  });
  assert.equal(reports.length, 1);
  reports.length = 0;
  const refresh = listen(
    plumbComponentRules["refresh-boundary"].create(
      double({
        filename: "/repo/card.tsx",
        report: (entry: Reported) => reports.push(entry),
      }),
    ),
  );
  refresh.ExportNamedDeclaration({
    exportKind: "value",
    declaration: { type: "FunctionDeclaration", id: { name: "Card" } },
    specifiers: [],
  });
  refresh.ExportNamedDeclaration({
    exportKind: "value",
    source: { type: "Literal", value: "./data" },
    specifiers: [{ type: "ExportSpecifier", exported: { name: "cardSize" } }],
  });
  refresh["Program:exit"]();
  assert.equal(reports.length, 1);
});

await test("glob matching normalizes root prefixes and platform path separators", () => {
  assert.equal(globMatches(["./src/**/*.{ts,tsx}"], "src/a.tsx"), true);
  assert.equal(globMatches(["src/**"], "src\\deep\\a.ts"), true);
  assert.equal(globMatches(["src/**"], "other/a.ts"), false);
  assert.equal(globMatches(["."], "src/a.ts"), true);
});

await test("inline type, formatter and coverage suppressions cannot bypass policy", () => {
  const reports: Reported[] = [];
  const comments = [
    " @ts-nocheck",
    " @ts-ignore",
    " / @ts-ignore",
    "** @ts-nocheck",
    " @ts-expect-error because legacy",
    " prettier-ignore",
    " c8 ignore next",
    " eslint-disable-line plumb/directive -- self suppression",
    " a normal explanation",
  ].map((value) => ({
    type: "Line",
    value,
    loc: { start: { line: 1 }, end: { line: 1 } },
  }));
  listen(
    plumbCommentRules.directive.create(
      double({
        sourceCode: { getAllComments: () => comments },
        report: (entry: Reported) => reports.push(entry),
      }),
    ),
  ).Program();
  assert.equal(reports.length, comments.length - 1);
});

await test("explicit language scopes cannot silently select nothing", () => {
  const options = {
    source: ["source/**"],
    tailwind: { files: ["missing/**"] },
    clientDirective: ["missing/**"],
    words: ["missing/**"],
    lines: ["missing/**"],
    rules: [{ files: ["missing/**"], rules: { "plumb/class-style": "error" } }],
    syntax: [
      {
        files: ["missing/**"],
        selectors: [{ selector: "DebuggerStatement", message: "no debugger" }],
      },
    ],
  };
  assert.equal(scopeProblems(options, ["src/card.tsx"]).length, 7);
  assert.deepEqual(scopeProblems({}, ["tools/build.mjs"]), []);
  assert.deepEqual(
    scopeProblems({ source: ["."], rules: [{ rules: { "plumb/class-style": "error" } }] }, [
      "tools/build.mjs",
    ]),
    [],
  );
  assert.equal(scopeProblems({ words: ["src/**"] }, []).length, 1);
});

await test("scopes are checked across the combined project-relative inventory", () => {
  const options = {
    words: ["ui/**"],
    lines: ["catalogue/**"],
    rules: [{ files: ["services/**"], rules: { "plumb/class-style": "error" } }],
  };
  assert.deepEqual(
    scopeProblems(options, ["ui/card.tsx", "catalogue/en.ts", "services/user.ts"]),
    [],
  );
  assert.equal(scopeProblems(options, ["ui/card.tsx", "services/user.ts"]).length, 1);
});

await test("flat-config scopes retain dot roots, trailing folders, and literal route brackets", () => {
  for (const [pattern, file] of [
    [".", "tools/build.ts"],
    ["./src/**", "src/card.tsx"],
    ["src/", "src/card.tsx"],
    ["app/[slug]/*.tsx", "app/[slug]/page.tsx"],
  ]) {
    assert.equal(globMatches(pattern, file), true);
    assert.equal(matchesGlob(file, eslintGlobs([pattern])[0]), true, pattern);
  }
});
