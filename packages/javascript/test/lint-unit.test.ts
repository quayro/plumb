import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { at } from "../../../src/schema.ts";
import { errorHandlingRule } from "../eslint/errors.ts";
import { scopeProblems, validateOptions } from "../eslint/options.ts";
import { plumbBoundaryRules } from "../eslint/rules/boundaries.ts";
import { plumbValueRules } from "../eslint/rules/values.ts";
import { typeCheckedRules, typeInformationRule } from "../eslint/typed-policy.ts";
import { createCompilerIO } from "../shared/compiler-host.ts";
import { double, identifier, listen, member, ownership, type Reported } from "./lint-support.ts";

await test("compiler I/O records source, dependencies and missing probes without crossing its root", async () => {
  const { context } = await import("../../../src/engine.ts");
  const parent = await mkdtemp(
    join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-compiler-inputs-"),
  );
  try {
    const root = join(parent, "candidate"),
      library = join(parent, "typescript");
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    mkdirSync(library);
    writeFileSync(join(root, "plumb.json"), '{"schemaVersion":1,"preset":"portable"}\n');
    writeFileSync(join(root, "main.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "node_modules/pkg/package.json"), '{"types":"index.d.ts"}\n');
    writeFileSync(join(library, "lib.d.ts"), "declare const standard: number;\n");
    writeFileSync(join(parent, "outside.ts"), "export const outside = 1;\n");
    const compiler = {
      getDefaultLibFilePath: () => join(library, "lib.d.ts"),
      sys: {
        readFile: (file: string) => readFileSync(file, "utf8"),
        useCaseSensitiveFileNames: true,
      },
    };
    const ctx = context({ root }),
      io = createCompilerIO(root, ctx, double(compiler));
    assert.equal(io.fileExists(join(root, "main.ts")), true);
    assert.equal(io.fileExists(join(root, "missing.ts")), false);
    assert.match(io.readFile(join(root, "node_modules/pkg/package.json")) ?? "", /index\.d\.ts/);
    assert.equal(ctx.compilerInputs.get("missing.ts"), null);
    assert.ok(ctx.compilerInputs.has("node_modules/pkg/package.json"));
    assert.equal(io.directoryExists(join(root, "missing-directory")), false);
    assert.ok(ctx.compilerDirectories.has("."));
    assert.equal(io.fileExists(join(parent, "outside.ts")), false);
    assert.throws(() => io.readFile(join(parent, "outside.ts")), /escapes/);
    assert.match(io.readFile(join(library, "lib.d.ts")) ?? "", /standard/);
    assert.throws(() => io.readFile(join(root, ".git/config")), /reserved|unsafe/i);
    if (process.platform !== "win32") {
      symlinkSync(join(parent, "outside.ts"), join(root, "linked.ts"));
      const unsafe = createCompilerIO(root, context({ root }), double(compiler));
      assert.throws(() => unsafe.fileExists(join(root, "linked.ts")), /unsupported|symbolic/i);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

await test("typed lint requires a trusted Program containing the current source", () => {
  const node = { type: "Program" },
    reports: Reported[] = [],
    program = { getSourceFile: () => ({ text: "export const value = 1;" }) };
  const context = {
    filename: "/repo/a.ts",
    report: (item: Reported) => reports.push(item),
    settings: { plumbTrustedPrograms: [program] },
    sourceCode: {
      text: "export const value = 1;",
      parserServices: { program, esTreeNodeToTSNodeMap: new Map() },
    },
  };
  listen(typeInformationRule.create(double(context))).Program(node);
  assert.equal(reports.length, 0);
  for (const changed of [
    { ...context, settings: {} },
    {
      ...context,
      sourceCode: { ...context.sourceCode, text: "export const value = 2;" },
    },
    { ...context, sourceCode: { ...context.sourceCode, parserServices: {} } },
  ]) {
    listen(typeInformationRule.create(double(changed))).Program(node);
  }
  assert.equal(reports.length, 3);
  assert.ok(reports.every((item) => item.messageId === "unresolved"));
  const floating = at(typeCheckedRules, "@typescript-eslint/no-floating-promises", 1);
  assert.equal(at(floating, "ignoreVoid"), false);
  assert.equal(at(floating, "checkThenables"), true);
});

await test("ownership follows immutable aliases, destructuring and literal computed properties", () => {
  const row = {
    member: "process.env",
    owner: ["src/config.ts"],
    message: "use config",
  };
  const env = ownership([row]);
  env.bind("host", identifier("process"));
  env.bind("key", { type: "Literal", value: "env" });
  env.visitors.MemberExpression(member(identifier("host"), identifier("key"), true));
  assert.equal(env.reports[0].messageId, "owner");
  const clock = ownership([{ now: true, owner: ["src/clock.ts"], message: "use clock" }]);
  clock.bind("Clock", identifier("Date"));
  clock.visitors.MemberExpression(member(identifier("Clock"), "now", true));
  assert.equal(clock.reports[0].messageId, "owner");
  const pattern = {
    type: "ObjectPattern",
    properties: [
      {
        type: "Property",
        key: identifier("env"),
        value: identifier("configuration"),
        computed: false,
      },
    ],
  };
  const destructured = ownership([row]);
  const { node } = destructured.bind("configuration", identifier("process"), pattern);
  destructured.visitors.VariableDeclarator(node);
  assert.equal(destructured.reports[0].messageId, "owner");
  const boxed = ownership([row]);
  boxed.bind("box", {
    type: "ObjectExpression",
    properties: [
      {
        type: "Property",
        key: identifier("host"),
        value: identifier("process"),
        computed: false,
      },
    ],
  });
  boxed.visitors.MemberExpression(member(member(identifier("box"), "host"), "env"));
  assert.equal(boxed.reports[0].messageId, "owner");
});

await test("governed computed and reassigned references are incomplete; local shadows are not effects", () => {
  const row = { member: "process.env", owner: [], message: "use config" };
  const computed = ownership([row]);
  computed.visitors.MemberExpression(member(identifier("process"), identifier("unknownKey"), true));
  assert.equal(computed.reports[0].messageId, "unresolved");
  const reassigned = ownership([row]),
    { value } = reassigned.bind("host", identifier("process"));
  value.references.push({
    isWrite: () => true,
    init: false,
    identifier: {
      parent: { type: "AssignmentExpression", right: identifier("other") },
    },
  });
  reassigned.visitors.MemberExpression(member(identifier("host"), "env"));
  assert.equal(reassigned.reports[0].messageId, "unresolved");
  const shadow = ownership([
    row,
    { now: true, construct: ["Date"], owner: [], message: "use clock" },
  ]);
  shadow.bindings.set("process", { defs: [{ type: "Parameter" }], references: [] });
  shadow.bindings.set("Date", { defs: [{ type: "ClassName" }], references: [] });
  shadow.visitors.MemberExpression(member(identifier("process"), "env"));
  shadow.visitors.NewExpression({ callee: identifier("Date"), arguments: [] });
  shadow.visitors.MemberExpression(
    member(
      {
        type: "MetaProperty",
        meta: identifier("import"),
        property: identifier("meta"),
      },
      "env",
    ),
  );
  assert.deepEqual(shadow.reports, []);
});

await test("error conventions reject invalid descriptors and missing typed evidence", () => {
  for (const errorHandling of [
    { factories: [] },
    { result: { name: "Result" } },
    { result: { from: "model", name: "*" } },
    { background: [{ from: "async", name: "run", safe: true }] },
    { files: ["../outside"], factories: [{ from: "errors", name: "fail" }] },
  ]) {
    assert.throws(() => validateOptions({ errorHandling }));
  }
  assert.doesNotThrow(() =>
    validateOptions({
      errorHandling: {
        files: ["src/**"],
        factories: [{ from: "@app/errors", name: "fail" }],
        result: { from: "@app/result", name: "Result" },
        background: [{ from: "@app/async", name: "background" }],
      },
    }),
  );
  const reports: Reported[] = [],
    context = {
      cwd: "/repo",
      filename: "/repo/src/a.ts",
      options: [{ result: { from: "model", name: "Result" } }],
      sourceCode: {},
      settings: {},
      report: (item: Reported) => reports.push(item),
    };
  const visitors = listen(errorHandlingRule.create(double(context)));
  visitors.Program({ type: "Program" });
  visitors.CatchClause({ body: { type: "BlockStatement", body: [] } });
  visitors.ThrowStatement({
    argument: { type: "Literal", value: "bare failure" },
  });
  assert.ok(reports.some((item) => item.messageId === "unresolved"));
  assert.ok(reports.some((item) => item.messageId === "empty"));
  assert.ok(reports.some((item) => item.messageId === "thrown"));
  assert.equal(scopeProblems({ errorHandling: { files: ["missing/**"] } }, ["src/a.ts"]).length, 1);
});

await test("resolved semantic edges cannot leave the root, independent of compiler resolution", async () => {
  // this unit isolates the resolved-path guard; the semantic suite exercises the actual compiler
  const compiler = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "typescript") {
        return {
          url: "data:text/javascript,export default Object.freeze({});",
          shortCircuit: true,
        };
      }
      return next(specifier, context);
    },
  });
  const { Analysis } = await import("../src/analysis.ts").finally(() => compiler.deregister());
  const root = resolve("resolved-edge-unit");
  const analysis = new Analysis({
    root,
    files: ["entry.ts", "inside.ts"],
    config: double({}),
    safePath: (file: unknown) => resolve(root, String(file)),
  });
  const outside = resolve(root, "../outside.ts");
  analysis.resolver = double({ resolve: () => outside });
  for (const specifier of ["@outside", outside, "../outside.ts"]) {
    assert.throws(() => analysis.target("entry.ts", specifier, {}), /leaves the checked root/);
  }
  analysis.resolver = double({ resolve: () => join(root, "inside.ts") });
  assert.equal(analysis.target("entry.ts", "@inside", {}), "inside.ts");
  analysis.resolver = double({
    resolve: () => join(root, "node_modules", "external", "index.d.ts"),
  });
  assert.equal(analysis.target("entry.ts", "external", {}), undefined);
  analysis.context.config.projects = [
    { root: ".", profile: "typescript" },
    { root: "a", profile: "typescript" },
  ];
  analysis.compilerConfig = (file: string) =>
    double({ fileNames: [join(root, "a", "entry.ts")], options: { configFilePath: file } });
  assert.equal(analysis.options("a/entry.ts").configFilePath, join(root, "a", "tsconfig.json"));
  analysis.context.config.projects.reverse();
  assert.equal(analysis.options("a/entry.ts").configFilePath, join(root, "a", "tsconfig.json"));
});

await test("inline type imports retain runtime layer and loader restrictions", () => {
  const reports: Reported[] = [];
  const runtime = () => "/repo/src/state/card.tsx";
  const base = {
    cwd: "/repo",
    filename: "/repo/src/lib/helper.ts",
    settings: { plumbResolver: { runtime, isLocal: () => true } },
    report: (entry: Reported) => reports.push(entry),
  };
  const layers = listen(
    plumbBoundaryRules.layers.create(
      double({
        ...base,
        options: [
          {
            root: "/repo",
            layers: [
              ["^src/lib/", 1, "lib"],
              ["^src/state/", 2, "state"],
            ],
          },
        ],
      }),
    ),
  );
  const loader = listen(
    plumbValueRules["plain-module"].create(
      double({
        ...base,
        options: [{ extensions: [".tsx"], reason: "the loader cannot execute components" }],
      }),
    ),
  );
  const inline = {
    type: "ImportDeclaration",
    importKind: "value",
    source: { type: "Literal", value: "../state/card" },
    specifiers: [{ type: "ImportSpecifier", importKind: "type" }],
  };
  layers.ImportDeclaration(inline);
  loader.ImportDeclaration(inline);
  assert.deepEqual(
    reports.map((entry) => entry.messageId),
    ["up", "refused"],
  );
  reports.length = 0;
  const erased = { ...inline, importKind: "type" };
  layers.ImportDeclaration(erased);
  loader.ImportDeclaration(erased);
  assert.equal(reports.length, 0);
});

await test("options reject unknown nested keys and every preset reconfiguration route", () => {
  const rejected = [
    { plugins: {} },
    { exceptions: [] },
    { ignores: ["**"] },
    { source: ["../elsewhere/**"] },
    { source: ["!src/**"] },
    { errorFactory: { message: "use the factory", allowln: ["src/error.ts"] } },
    { rules: [{ extends: [{ rules: { "no-console": "off" } }] }] },
    {
      rules: [{ languageOptions: {}, rules: { "plumb/class-style": "error" } }],
    },
    { rules: [{ rules: { "no-debugger": "off" } }] },
    { rules: [{ rules: { "@typescript-eslint/no-unused-vars": "warn" } }] },
    { rules: [{ rules: { "plumb/class-style": "off" } }] },
    {
      rules: [
        {
          rules: {
            "plumb/keyed-numbers": ["error", { keys: ["delay"], typo: true }],
          },
        },
      ],
    },
    {
      rules: [
        {
          rules: {
            "plumb/owners": [
              "error",
              {
                root: "/elsewhere",
                rows: [{ global: "fetch", owner: [], message: "use http" }],
              },
            ],
          },
        },
      ],
    },
    {
      rules: [
        {
          rules: {
            "plumb/literal-calls": ["error", { calls: [{ callee: "[", args: [] }] }],
          },
        },
      ],
    },
    JSON.parse('{"constructor":{}}'),
    JSON.parse('{"__proto__":{}}'),
  ];
  for (const options of rejected) {
    assert.throws(() => validateOptions(options), TypeError, JSON.stringify(options));
  }
  assert.doesNotThrow(() =>
    validateOptions({
      source: ["./src/**"],
      rules: [
        {
          files: ["src/**"],
          rules: { "plumb/keyed-numbers": ["error", { keys: ["delay"] }] },
        },
      ],
    }),
  );
});
