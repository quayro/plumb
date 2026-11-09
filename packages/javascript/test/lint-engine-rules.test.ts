import assert from "node:assert/strict";
import { test } from "node:test";

import { getRuleMetadata } from "../eslint/index.ts";
import { plumbReactRules } from "../eslint/react.ts";
import { plumbTypescriptRules } from "../eslint/rules.ts";
import { isolated, root } from "./lint-engine-support.ts";

await test("rule metadata covers every custom rule and inherited preset identifiers", () => {
  const metadata = getRuleMetadata();
  const ids = new Set(metadata.map((entry) => entry.rule));
  for (const name of Object.keys(plumbTypescriptRules)) {
    assert.ok(ids.has(`plumb/${name}`));
  }
  for (const name of Object.keys(plumbReactRules)) {
    assert.ok(ids.has(`plumb-react/${name}`));
  }
  for (const name of [
    "no-console",
    "no-debugger",
    "max-lines",
    "@typescript-eslint/no-unused-vars",
    "plumb/syntax",
  ]) {
    assert.ok(ids.has(name), name);
  }
  assert.equal(metadata.find((entry) => entry.rule === "plumb/directive")?.suppressible, false);
});

await test("every module edge form is checked by layers and plain loaders, and computed specifiers are refused", () => {
  const options = {
    root,
    layers: [
      ["^src/lib/", 1, "lib"],
      ["^src/state/.*\\.tsx$", 2, "state"],
    ],
  };
  for (const load of [
    'require("../state/card")',
    'module.require("../state/card")',
    '(0, require)("../state/card")',
    'require(`../state/${"card"}`)',
    'createRequire(import.meta.url)("../state/card")',
    'await import("../state/card")',
  ]) {
    const ids = isolated("plumb/layers", `${load};\n`, options, "src/lib/adapter.ts").messages.map(
      (message) => message.messageId,
    );
    assert.deepEqual(ids, [load.startsWith("await import") ? "lazy" : "up"], load);
  }
  for (const load of ["require(name)", "(0, require)(name)", "await import(name)", "require()"]) {
    assert.deepEqual(
      isolated(
        "plumb/layers",
        `const name = process.env.X;\n${load};\n`,
        options,
        "src/lib/adapter.ts",
      ).messages.map((message) => message.messageId),
      ["dynamic"],
      load,
    );
  }
  const plain = { packages: "^lodash$", reason: "a plain loader runs this" };
  for (const load of [
    'await import("lodash")',
    'require("lodash")',
    "require(`lodash`)",
    'import("lo" + "dash")',
  ]) {
    assert.deepEqual(
      isolated("plumb/plain-module", `${load};\n`, plain).messages.map(
        (message) => message.messageId,
      ),
      ["refused"],
      load,
    );
  }
  for (const load of ["import(name)", "require(name)"]) {
    assert.deepEqual(
      isolated(
        "plumb/plain-module",
        `const name = process.env.X;\nexport const value = ${load};\n`,
        plain,
      ).messages.map((message) => message.messageId),
      ["dynamic"],
      load,
    );
  }
  assert.equal(
    isolated(
      "plumb/plain-module",
      'import type { Value } from "lodash";\nexport type Other = import("lodash").Value;\n',
      plain,
    ).messages.length,
    0,
  );
  assert.equal(
    isolated(
      "plumb/layers",
      'import type { Card } from "../state/card";\nexport type Other = typeof import("../state/card");\n',
      options,
      "src/lib/adapter.ts",
    ).messages.length,
    0,
  );
});

await test("nested catch clauses are named, and every built-in error constructor goes through the factory", () => {
  const options = { root, errorFactory: { message: "use the factory" } };
  const nested =
    "try { run(); } catch (error) { try { run(); } catch (inner) { throw inner; } }\nexport {};\n";
  assert.deepEqual(
    isolated("plumb/syntax", nested, options).messages.map((message) => message.message),
    ["Catch as catch (error), or catch { when the error is not read."],
  );
  for (const code of [
    "new Error('x');",
    "new TypeError('x');",
    "throw new RangeError('x');",
    "Error('x');",
    "new AggregateError([]);",
    "Reflect.construct(Error, ['x']);",
    "globalThis.Error('x');",
    "new window['SyntaxError']('x');",
    "const Ctor = URIError; new Ctor('x');",
    "let Ctor; Ctor = EvalError;",
  ]) {
    assert.ok(
      isolated("plumb/syntax", `${code}\nexport {};\n`, options).messages.length >= 1,
      code,
    );
  }
  assert.equal(
    isolated(
      "plumb/syntax",
      "export const message = 'Error: text';\nexport class Failure extends Error {}\n",
      options,
    ).messages.length,
    0,
  );
});

await test("keyed numbers are refused in object, class field, assignment and default positions, never in tokens", () => {
  const options = { keys: ["duration"] };
  for (const code of [
    "export const a = { duration: 300 };",
    "export class A { duration = 300; }",
    "export const b = {}; b.duration = 300;",
    "export const c = {}; c['duration'] = -300;",
    "export function d(duration = 300) { return duration; }",
    "export const { duration = 300 } = {};",
    "export const { duration: e = 300 } = {};",
  ]) {
    assert.equal(isolated("plumb/keyed-numbers", `${code}\n`, options).messages.length, 1, code);
  }
  for (const code of [
    "export const a = { duration: 'fast' };",
    "export class A { duration = token; }",
    "export const b = {}; b.duration = 0;",
    "export const b = {}; b.other = 300;",
    "export function d(other = 300) { return other; }",
    "export const c = { duration: TOKEN_FAST };",
  ]) {
    assert.equal(isolated("plumb/keyed-numbers", `${code}\n`, options).messages.length, 0, code);
  }
});

await test("every matching literal-calls row is enforced, not only the first", () => {
  const options = {
    calls: [
      { callee: "^register$", args: ["literal"] },
      { callee: "^register$", args: ["literal", "literal"] },
    ],
  };
  assert.equal(
    isolated("plumb/literal-calls", 'export const value = register("known");\n', options).messages
      .length,
    1,
  );
  assert.equal(
    isolated("plumb/literal-calls", 'export const value = register("known", 1);\n', options)
      .messages.length,
    2,
  );
});

await test("words in conditionals, templates and every attribute label are refused, catalogue keys are not", () => {
  const tsx = "src/view.tsx";
  for (const code of [
    'export const View = ({ ok }) => <button>{ok ? "Save" : null}</button>;\n',
    'export const View = ({ ok }) => <button title={ok ? "buttons.save" : "Cancel now"} />;\n',
    "export const View = ({ n }) => <input placeholder={`Enter ${n} items`} />;\n",
    'export const View = () => <input aria-description="Search here" />;\n',
    'export const View = () => <input helperText="Required field" />;\n',
    'export const View = () => <input errorMessage={"Too " + "long"} />;\n',
  ]) {
    assert.equal(isolated("plumb-react/words", code, undefined, tsx).messages.length, 1, code);
  }
  for (const code of [
    'export const View = ({ ok }) => <button title={ok ? "buttons.save" : "buttons.cancel"} />;\n',
    'export const View = ({ ok }) => <button>{ok ? t("save") : null}</button>;\n',
    'export const View = () => <input data-label="Search here" />;\n',
  ]) {
    assert.equal(isolated("plumb-react/words", code, undefined, tsx).messages.length, 0, code);
  }
  assert.equal(
    isolated(
      "plumb-react/words",
      'export const View = () => <input label="Search here" />;\n',
      { attributes: ["title"] },
      tsx,
    ).messages.length,
    0,
  );
});

await test("float and clear physical classes are refused like left and right", () => {
  for (const name of ["float-left", "float-right", "clear-left", "clear-right", "md:float-right"]) {
    assert.equal(
      isolated(
        "plumb-react/class-set",
        `export const View = () => <div className="${name} p-2" />;\n`,
        { physical: true },
        "src/view.tsx",
      ).messages.length,
      1,
      name,
    );
  }
  assert.equal(
    isolated(
      "plumb-react/class-set",
      'export const View = () => <div className="float-start p-2" />;\n',
      { physical: true },
      "src/view.tsx",
    ).messages.length,
    0,
  );
});

await test("default-exported declarations carry the owner prefix like named exports", () => {
  const options = () => ({ root, map: [{ match: "^src/", names: ["$file"] }] });
  assert.equal(
    isolated("plumb/export-prefix", "export default function wrongName() {}\n", options()).messages
      .length,
    1,
  );
  assert.equal(
    isolated("plumb/export-prefix", "export default class WrongName {}\n", options()).messages
      .length,
    1,
  );
  assert.equal(
    isolated("plumb/export-prefix", "export default function moduleRun() {}\n", options()).messages
      .length,
    0,
  );
  assert.equal(
    isolated("plumb/export-prefix", "export default function () {}\n", options()).messages.length,
    0,
  );
});

await test("reflective and constant-folded reads of a governed global are owned, and unknown keys are incomplete", () => {
  const opts = { root, rows: [{ global: "process", owner: ["src/env.ts"], message: "env owner" }] };
  for (const code of [
    'Reflect.get(globalThis, "process");',
    'Object.getOwnPropertyDescriptor(globalThis, "process").value;',
    'globalThis["pro" + "cess"].env;',
    'Reflect.get(window, "process");',
  ]) {
    assert.ok(
      isolated("plumb/owners", `export const a = ${code}\n`, opts).messages.some(
        (message) => message.messageId === "owner",
      ),
      code,
    );
  }
  for (const code of [
    "Reflect.get(globalThis, name);",
    "Object.getOwnPropertyDescriptors(globalThis);",
    "globalThis[name];",
  ]) {
    assert.ok(
      isolated(
        "plumb/owners",
        `const name = process.argv[2];\nexport const a = ${code}\n`,
        opts,
      ).messages.some((message) => message.messageId === "unresolved"),
      code,
    );
  }
  assert.equal(
    isolated(
      "plumb/owners",
      'export const name = "other";\nexport const a = Reflect.get(globalThis, name);\n',
      opts,
    ).messages.length,
    0,
  );
});

await test("every test callback asserts, and nested tests or unrelated calls never satisfy their parent", () => {
  const file = "src/module.test.ts",
    options = { root };
  const refused = [
    'import { test } from "node:test";\ntest("x", () => {});\n',
    'import { test } from "node:test";\ntest("x", () => { const value = 1; console.log(value); });\n',
    'import { test } from "node:test";\ntest("x", () => { helper(); });\n',
    'import { test } from "node:test";\ntest("x", (t) => { t.test("inner", () => { expect(1).toBe(1); }); });\n',
    'import { it } from "node:test";\nit("x", function () { foo.bar(); });\n',
    'import { test } from "node:test";\ntest("x", () => { const check = (value) => value; check(1); });\n',
  ];
  for (const code of refused) {
    assert.equal(
      isolated("plumb/test-assertions", code, options, file).messages.length >= 1,
      true,
      code,
    );
  }
  const passing = [
    'import { test } from "node:test";\ntest("x", () => { expect(1).toBe(1); });\n',
    'import { test } from "node:test";\ntest("x", () => { assert.strictEqual(1, 1); });\n',
    'import { test } from "node:test";\ntest("x", (t) => { t.assert.ok(true); });\n',
    'import { test } from "node:test";\ntest("x", () => { rejectionExpect(promise); });\n',
    'import { it } from "node:test";\nit("x", () => { assertShape(value); });\n',
    'import { test } from "node:test";\ntest.each([1])("x", (value) => { expect(value).toBe(1); });\n',
    'import { test } from "node:test";\ntest("x", (t) => { t.test("inner", () => { expect(1).toBe(1); }); t.assert.ok(true); });\n',
  ];
  for (const code of passing) {
    assert.equal(isolated("plumb/test-assertions", code, options, file).messages.length, 0, code);
  }
  assert.equal(
    isolated("plumb/test-assertions", "export const value = () => 1;\n", options, "src/module.ts")
      .messages.length,
    0,
  );
  assert.equal(
    isolated(
      "plumb/test-assertions",
      'import { test } from "node:test";\ntest("x", () => { verify(1); });\n',
      { root, assertions: "^verify" },
      file,
    ).messages.length,
    0,
  );
  assert.equal(
    isolated(
      "plumb/test-assertions",
      'import { test } from "node:test";\ntest("x", () => { expect(1).toBe(1); });\n',
      { root, assertions: "^verify" },
      file,
    ).messages.length,
    1,
  );
});

await test("module spacing fixes indented class members without moving their indentation", () => {
  const code = [
    "export class Box {",
    "  value = 1;",
    "  get v(): number { return this.value }",
    "  // note",
    "  method(): void {}",
    "}",
    "",
  ].join("\n");
  const { messages, output } = isolated("plumb/module-spacing", code);
  assert.equal(messages.length, 2);
  assert.equal(
    output,
    [
      "export class Box {",
      "  value = 1;",
      "",
      "  get v(): number { return this.value }",
      "",
      "  // note",
      "  method(): void {}",
      "}",
      "",
    ].join("\n"),
  );
});
