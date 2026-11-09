import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

import { ESLint, type Linter } from "eslint";

import { globMatches, safePath } from "../../../src/files.ts";
import { policy } from "../../../test/support.ts";
import { createConfig, typedRuntime } from "../eslint/index.ts";
import type { TypedRuntime } from "../eslint/typed.ts";
import { Analysis } from "../src/analysis.ts";

interface TypedFixture {
  root: string;
  analysis: Analysis;
  runtime: TypedRuntime;
  lint(file?: string): Promise<Linter.LintMessage[]>;
}

export function fixture(
  t: TestContext,
  files: Record<string, string>,
  {
    options = {},
    compilerOptions = {},
    include = ["src/**/*"],
  }: {
    options?: Record<string, unknown>;
    compilerOptions?: Record<string, unknown>;
    include?: string[];
  } = {},
): TypedFixture {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-typed-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const all = {
    ...files,
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        ...compilerOptions,
      },
      include,
    }),
  };
  for (const [file, source] of Object.entries(all)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  const project = { root: ".", profile: "typescript" },
    context = {
      root,
      files: Object.keys(all),
      config: policy({ projects: [project] }),
      safePath: (file: unknown, settings?: { allowMissing?: boolean }) =>
        safePath(root, file, settings),
      matches: globMatches,
      read: (file: string) => readFileSync(safePath(root, file), "utf8"),
    };
  const analysis = new Analysis(context),
    runtime = typedRuntime(analysis, project, Object.keys(files));
  const engine = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: createConfig({ root, ...options }, runtime),
  });
  return {
    root,
    analysis,
    runtime,
    async lint(file = "src/main.ts") {
      const [result] = await engine.lintText(context.read(file), { filePath: join(root, file) });
      assert.ok(!result.messages.some((item) => item.fatal), JSON.stringify(result.messages));
      return result.messages;
    },
  };
}
