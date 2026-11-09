import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

import type { Config } from "../../../src/config.ts";
import { at, isRecord } from "../../../src/schema.ts";
import { parseJson } from "../../../test/support.ts";
import { check, snapshot } from "../src/index.ts";

interface SignatureFixture {
  context: { root: string; files: string[]; mode: string; configFile: string; config: Config };
  root: string;
  write: (file: string, text: string) => void;
  proposal: () => { path: string; content: string };
  value: () => unknown;
  accept: () => string;
}

export const fixture = (
  t: TestContext,
  source: Record<string, string>,
  {
    exports = "./src/index.ts",
    compiler = {},
    signatures = true,
    root: projectRoot = ".",
  }: {
    exports?: unknown;
    compiler?: Record<string, unknown>;
    signatures?: boolean;
    root?: string;
  } = {},
): SignatureFixture => {
  const parent = process.env.PLUMB_TEST_TMP ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "plumb-signatures-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = (file: string): string => (projectRoot === "." ? file : `${projectRoot}/${file}`);
  const files = {
    [local("tsconfig.json")]: JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
        strict: true,
        types: [],
        ...compiler,
      },
      include: ["src/**/*"],
    }),
    [local("package.json")]: JSON.stringify({
      name: "signature-fixture",
      version: "1.0.0",
      type: "module",
      exports,
    }),
    ...Object.fromEntries(Object.entries(source).map(([file, text]) => [local(file), text])),
  };
  const config: Config = {
    schemaVersion: 1,
    preset: "portable",
    exclude: [],
    exceptions: [],
    contracts: {},
    projects: [
      {
        root: projectRoot,
        profile: "typescript",
        surface: { snapshot: "api.surface.json", signatures },
      },
    ],
  };
  const context = {
    root,
    files: Object.keys(files).filter((file) => !file.split("/").includes("node_modules")),
    mode: "check",
    configFile: "plumb.json",
    config,
  };
  const write = (file: string, text: string): void => {
    const path = local(file);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const proposal = (): { path: string; content: string } => {
    const [first] = snapshot(context);
    assert.ok(first);
    return first;
  };
  const value = (): unknown => parseJson(proposal().content);
  const accept = () => {
    const current = proposal();
    writeFileSync(join(root, current.path), current.content);
    if (!context.files.includes(current.path)) {
      context.files.push(current.path);
    }
    return current.content;
  };
  return { context, root, write, proposal, value, accept };
};

export const declarations = (value: unknown): string => {
  const signatures = at(value, "signatures");
  return Object.values(isRecord(signatures) ? signatures : {})
    .map((entry) => String(at(entry, "declaration")))
    .join("\n");
};

export const tree = (root: string, prefix = ""): [string, string][] =>
  readdirSync(join(root, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry): [string, string][] => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory()
        ? tree(root, path)
        : [[path, readFileSync(join(root, path)).toString("base64")]];
    });

export const changed = (context: Parameters<typeof check>[0] & { mode?: string }): void => {
  const diagnostics = check(context);
  assert.equal(
    diagnostics.some((item) => item.status === "incomplete"),
    false,
    JSON.stringify(diagnostics),
  );
  assert.ok(
    diagnostics.some((item) => item.rule === "exports.surface"),
    JSON.stringify(diagnostics),
  );
};
