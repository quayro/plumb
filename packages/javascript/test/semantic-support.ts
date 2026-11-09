import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

import type { Config } from "../../../src/config.ts";
import type { Diagnostic } from "../../../src/diagnostics.ts";
import type { ConventionsContext } from "../src/metrics.ts";

export const compiler = JSON.stringify({
  compilerOptions: {
    module: "ESNext",
    moduleResolution: "Bundler",
    target: "ES2022",
    strict: true,
    allowJs: true,
    verbatimModuleSyntax: true,
    paths: { "@app/*": ["./src/*"] },
  },
});

export const fixture = (
  t: TestContext,
  source: Record<string, string>,
  config: Partial<Config> = {},
): ConventionsContext => {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-semantic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = { "tsconfig.json": compiler, ...source };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return {
    root,
    files: Object.keys(files),
    configFile: "plumb.json",
    config: {
      schemaVersion: 1,
      preset: "portable",
      projects: [],
      exclude: [],
      exceptions: [],
      contracts: {},
      ...config,
    },
  };
};

export const rules = (diagnostics: readonly Diagnostic[], rule: string): Diagnostic[] =>
  diagnostics.filter((item) => item.rule === rule);

export const graph = {
  entries: ["entry.ts"],
  within: ".",
  refuse: { packages: "^forbidden$", extensions: [".tsx"] },
  reason: "the loader cannot execute components",
};

export const catalogue = { file: "src/catalogue.ts", variable: "sources", entry: "./entry.ts" };

export const lazy = {
  loader: "src/router.ts",
  listing: { file: "scripts/pages.ts", pattern: "^src/.+\\.tsx$", root: "." },
  names: { files: "src/**", pattern: "-page\\.tsx$" },
};

export const registration = {
  sources: "src",
  call: { name: "register", from: "src/registry.ts" },
  registrar: { files: "src/jobs.ts", suffix: "RegisterJobs" },
  composition: { file: "src/composition.ts", function: "compose" },
};
export const registrationSources = {
  "src/registry.ts": "export const register = (name: string): void => undefined;",
  "src/jobs.ts":
    'import { register as add } from "./registry"; export const billingRegisterJobs = (): void => { add("sweep"); };',
  "src/composition.ts":
    'import { billingRegisterJobs as jobs } from "./jobs"; export const compose = (): void => { jobs(); };',
};

export const packageProject = {
  root: ".",
  profile: "typescript",
  surface: { snapshot: "api.surface.json" },
};
