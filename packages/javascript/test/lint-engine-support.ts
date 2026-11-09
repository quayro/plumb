import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ESLint, Linter } from "eslint";
import globals from "globals";
import tseslint from "typescript-eslint";

import { createConfig, plugin } from "../eslint/index.ts";
import { plumbReactRules } from "../eslint/react.ts";
import { plumbTypescriptRules } from "../eslint/rules.ts";
import { syntaxRule } from "../eslint/syntax.ts";

// one fixture root per test file; awaited top-level tests let a root after() hook run between them,
// so the fixture is written at import and removed at exit
export const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-lint-engine-"));

for (const [file, code] of [
  ["src/lib/helper.ts", "export const helper = 1;\n"],
  ["src/state/card.tsx", "export const Card = () => null;\n"],
  ["src/index.js", "export const value = 1;\n"],
  ["src/package/index.ts", "export const item = 1;\n"],
  ["src/runtime.d.ts", "export declare const value: number;\n"],
  ["src/runtime.js", "export const value = 1;\n"],
  ["src/declaration-only.d.ts", "export declare const value: number;\n"],
]) {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, code);
}

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

export const isolated = (
  rule: string,
  code: string,
  options?: unknown,
  file = "src/module.ts",
): { messages: Linter.LintMessage[]; output: string } => {
  const linter = new Linter({ configType: "flat", cwd: root });
  const config: Linter.Config[] = [
    {
      files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
        globals: { ...globals.node, ...globals.browser },
      },
      linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
      plugins: {
        plumb: plugin("plumb", { ...plumbTypescriptRules, syntax: syntaxRule }),
        "plumb-react": plugin("plumb-react", plumbReactRules),
      },
      rules: { [rule]: options === undefined ? "error" : ["error", options] },
    },
  ];
  const filename = join(root, file);
  const messages = linter.verify(code, config, { filename });
  assert.ok(!messages.some((message) => message.fatal), JSON.stringify(messages));
  return {
    messages: messages.filter((message) => message.ruleId === rule),
    output: linter.verifyAndFix(code, config, { filename }).output,
  };
};

export const preset = async (
  code: string,
  options: Record<string, unknown> = {},
  file = "src/module.ts",
): Promise<Linter.LintMessage[]> => {
  const engine = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: createConfig({ root, ...options }),
  });
  const [result] = await engine.lintText(code, { filePath: join(root, file) });
  assert.ok(!result.messages.some((message) => message.fatal), JSON.stringify(result.messages));
  return result.messages;
};
