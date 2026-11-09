import assert from "node:assert/strict";
import { test } from "node:test";

import { fixture } from "./typed-lint-support.ts";

await test("ownership follows aliases, destructuring and static keys without confusing shadows", async (t) => {
  const rows = [{ now: true, owner: ["src/clock.ts"], message: "use clock" }],
    options = { rules: [{ files: ["src/**"], rules: { "plumb/owners": ["error", { rows }] } }] };
  for (const code of [
    "const clock = Date; export const time: number = clock.now();",
    "const { now: read } = Date; export const time: number = read();",
    'const clock = Date; const key = "now"; export const time: number = clock[key]();',
    "const box = { clock: Date }; export const time: number = box.clock.now();",
  ]) {
    assert.ok(
      (await fixture(t, { "src/main.ts": code }, { options }).lint()).some(
        (item) => item.ruleId === "plumb/owners",
      ),
      code,
    );
  }
  const shadow = "export function read(Date: { now(): number }): number { return Date.now(); }\n";
  assert.ok(
    !(await fixture(t, { "src/main.ts": shadow }, { options }).lint()).some(
      (item) => item.ruleId === "plumb/owners",
    ),
  );
  for (const code of [
    "const clock = Date; declare const key: string; export const time = clock[key];",
    "let clock = Date; clock = Date; export const time: number = clock.now();",
  ]) {
    assert.ok(
      (await fixture(t, { "src/main.ts": code }, { options }).lint()).some(
        (item) => item.ruleId === "plumb/owners" && item.messageId === "unresolved",
      ),
    );
  }
});

await test("compiler symbol identity follows renamed reexports and refuses same-name spoofing", async (t) => {
  const options = {
    rules: [
      {
        files: ["src/main.ts"],
        rules: {
          "plumb/owners": [
            "error",
            {
              rows: [
                {
                  importFrom: "./raw.js",
                  name: "read",
                  owner: ["src/raw.ts"],
                  message: "use adapter",
                },
              ],
            },
          ],
        },
      },
    ],
  };
  const files = {
    "src/raw.ts": "export function read(): number { return 1; }\n",
    "src/bridge.ts": 'export { read as renamed } from "./raw.js";\n',
    "src/main.ts":
      'import { renamed as load } from "./bridge.js";\nexport const value: number = load();\n',
  };
  assert.ok(
    (await fixture(t, files, { options }).lint()).some((item) => item.ruleId === "plumb/owners"),
  );
  const shadow = {
    ...files,
    "src/main.ts": "function read(): number { return 2; }\nexport const value: number = read();\n",
  };
  assert.ok(
    !(await fixture(t, shadow, { options }).lint()).some((item) => item.ruleId === "plumb/owners"),
  );
});

await test("error factories are imported symbols and result signatures use the approved type", async (t) => {
  const supporting = {
    "src/errors.ts":
      "export function failure(message: string): Error { return new Error(message); }\n",
    "src/bridge.ts": 'export { failure as failed } from "./errors.js";\n',
  };
  const options = {
    errorHandling: {
      files: ["src/main.ts"],
      factories: [{ from: "./errors.js", name: "failure" }],
    },
  };
  const accepted = {
    ...supporting,
    "src/main.ts":
      'import { failed as fail } from "./bridge.js";\nexport function read(): never { throw fail("bad"); }\n',
  };
  assert.ok(
    !(await fixture(t, accepted, { options }).lint()).some(
      (item) => item.ruleId === "plumb/errors",
    ),
  );
  const rejected = {
    ...supporting,
    "src/main.ts":
      'function failure(message: string): Error { return new Error(message); }\nexport function read(): never { throw failure("bad"); }\n',
  };
  assert.ok(
    (await fixture(t, rejected, { options }).lint()).some(
      (item) => item.ruleId === "plumb/errors" && item.messageId === "factory",
    ),
  );
  const resultOptions = {
    errorHandling: { files: ["src/main.ts"], result: { from: "./result.js", name: "Result" } },
  };
  const result = {
    "src/result.ts":
      "export type Result<T> = { ok: true; value: T } | { ok: false; error: Error };\n",
    "src/main.ts":
      'import type { Result } from "./result.js";\nexport function read(): Result<number> { return { ok: true, value: 1 }; }\n',
  };
  assert.ok(
    !(await fixture(t, result, { options: resultOptions }).lint()).some(
      (item) => item.ruleId === "plumb/errors",
    ),
  );
  assert.ok(
    (
      await fixture(
        t,
        { ...result, "src/main.ts": "export function read(): number { return 1; }\n" },
        { options: resultOptions },
      ).lint()
    ).some((item) => item.ruleId === "plumb/errors" && item.messageId === "result"),
  );
});

await test("empty catches and non-Error throws fail; detached work requires a typed approved wrapper", async (t) => {
  const source =
    'export function read(): void { try { throw "bad"; } catch { /* deliberately swallowed */ } }\n';
  const caught = await fixture(t, { "src/main.ts": source }).lint();
  assert.ok(caught.some((item) => item.ruleId === "plumb/errors" && item.messageId === "empty"));
  assert.ok(caught.some((item) => item.ruleId === "@typescript-eslint/only-throw-error"));
  const options = {
    errorHandling: {
      files: ["src/main.ts"],
      background: [{ from: "./background.js", name: "run" }],
    },
  };
  const supporting = {
    "src/background.ts": "export declare function run(work: () => Promise<void>): void;\n",
  };
  const accepted = {
    ...supporting,
    "src/main.ts":
      'import { run as schedule } from "./background.js";\nasync function work(): Promise<void> { await Promise.resolve(); }\nschedule(work);\n',
  };
  assert.ok(
    !(await fixture(t, accepted, { options }).lint()).some(
      (item) => item.ruleId === "plumb/errors",
    ),
  );
  const rejected = {
    ...supporting,
    "src/main.ts":
      'async function work(): Promise<void> { await Promise.resolve(); }\nwork().catch((error: unknown) => { if (error instanceof Error) { throw error; } throw new Error("unknown"); });\n',
  };
  assert.ok(
    (await fixture(t, rejected, { options }).lint()).some(
      (item) => item.ruleId === "plumb/errors" && item.messageId === "background",
    ),
  );
});
