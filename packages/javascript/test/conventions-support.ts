import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

import type { Config } from "../../../src/config.ts";
import type { Conventions } from "../../../src/convention-schema.ts";
import type { Diagnostic } from "../../../src/diagnostics.ts";
import { globMatches, safePath } from "../../../src/files.ts";
import { Analysis } from "../src/analysis.ts";
import type { NodeAssertion } from "../src/convention-view.ts";
import { checkConventions } from "../src/conventions.ts";
import type { ConventionsContext } from "../src/metrics.ts";

export const compiler = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    allowJs: true,
    paths: { "@shared/*": ["./shared/*"] },
  },
};

export type Role = Conventions["roles"][number];

export interface Fixture extends ConventionsContext {
  config: Config & { conventions: Conventions };
  read: (path: string) => string;
}

export function fixture(
  t: TestContext,
  sources: Record<string, string>,
  role: Partial<Role> = {},
  changes: Partial<Config> = {},
): Fixture {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-js-conventions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = { "tsconfig.json": JSON.stringify(compiler), ...sources };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const config: Config & { conventions: Conventions } = {
    schemaVersion: 1,
    preset: "portable",
    projects: [],
    exclude: [],
    exceptions: [],
    conventions: { files: ["src/**"], roles: [{ id: "source", files: ["src/**"], ...role }] },
    ...changes,
  };
  return {
    root,
    config,
    allFiles: Object.keys(files).sort(),
    files: Object.keys(files)
      .filter((path) => !config.exclude.some((entry) => globMatches(entry.files, path)))
      .sort(),
    matches: globMatches,
    configFile: "plumb.json",
    safePath: (path: unknown, options?: { allowMissing?: boolean }) =>
      safePath(root, path, options),
    read: (path: string) => readFileSync(safePath(root, path), "utf8"),
  };
}

export const shape = (
  select: NodeAssertion["select"],
  count: NodeAssertion["count"],
  id = "shape",
): Partial<Role> => ({ javascript: { nodes: [{ id, select, count }] } });

export const typed: Partial<Role> = {
  javascript: {
    assignable: [
      {
        id: "handler",
        export: "run",
        contract: { file: "contracts.ts", symbol: "Handler" },
        tsconfig: "tsconfig.json",
      },
    ],
  },
};
export const handler = "export interface Handler { (value: number): string }\n";

export const check = (context: ConventionsContext): Diagnostic[] =>
  checkConventions(context, new Analysis(context));

export const firstOf = (context: ConventionsContext): Diagnostic => {
  const [diagnostic] = check(context);
  assert.ok(diagnostic);
  return diagnostic;
};

export const roleOf = (context: Fixture): Role => {
  const [role] = context.config.conventions.roles;
  assert.ok(role);
  return role;
};

export const nodeOf = (context: Fixture): NodeAssertion => {
  const [node] = roleOf(context).javascript?.nodes ?? [];
  assert.ok(node);
  return node;
};
