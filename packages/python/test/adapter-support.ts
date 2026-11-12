import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { type AdapterRegistry, loadAdapterRegistry } from "../../../src/adapter-registry.ts";
import { type AdapterResult, planAdapters, runAdapters } from "../../../src/adapters.ts";
import { definePlumb, type Project } from "../../../src/config.ts";
import type { Context, ReadOptions } from "../../../src/context.ts";
import { type Diagnostic, isDiagnostic } from "../../../src/diagnostics.ts";
import { asError, errorCode } from "../../../src/errors.ts";
import { digest, safePath } from "../../../src/files.ts";
import { type Execute, run as runCommand } from "../../../src/process.ts";
import { at, isArray, isRecord } from "../../../src/schema.ts";
import { mapped, parseJson, testContext } from "../../../test/support.ts";

export const python = process.env.PLUMB_TEST_PYTHON ?? "python3";
export const script = fileURLToPath(new URL("../adapter.py", import.meta.url));

const invoke = (
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): SpawnSyncReturns<string> => {
  const result = spawnSync(python, ["-I", "-S", script, ...args], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.error,
    undefined,
    `The optional Python suite requires a real Python 3.10+ interpreter: ${result.error?.message}`,
  );
  assert.equal(result.signal, null, result.stderr);
  return result;
};

const manifestResult = invoke(["--manifest"]);

assert.equal(manifestResult.status, 0, manifestResult.stderr || manifestResult.stdout);

export const manifest = parseJson(manifestResult.stdout);

interface Response {
  status: string;
  diagnostics: Diagnostic[];
  inputs: { path: string; sha256: string | null }[];
  coverage: unknown[];
  versions: unknown;
  [field: string]: unknown;
}

// the adapter's JSON response, with the fields these tests read checked one by one
const parseResponse = (text: string): Response => {
  const value = parseJson(text);
  assert.ok(isRecord(value), text);
  return {
    ...value,
    status: String(value.status),
    diagnostics: isArray(value.diagnostics) ? value.diagnostics.filter(isDiagnostic) : [],
    inputs: mapped(value.inputs, (entry) => {
      const sha256 = at(entry, "sha256");
      return {
        path: String(at(entry, "path")),
        sha256: typeof sha256 === "string" ? sha256 : null,
      };
    }),
    coverage: isArray(value.coverage) ? value.coverage : [],
    versions: value.versions,
  };
};

interface FileDigest {
  path: string;
  sha256: string | null;
}

interface PythonFixture {
  root: string;
  tools: string;
  ctx: Context;
  registry: AdapterRegistry | undefined;
  registryFile: string;
  write: (path: string, value: string | Buffer) => void;
  request: () => {
    schemaVersion: number;
    action: string;
    adapter: string;
    version: string;
    root: string;
    project: Project;
    files: FileDigest[];
    inputs: FileDigest[];
    capabilities: string[];
  };
  direct: (value?: unknown, extra?: { env?: NodeJS.ProcessEnv }) => Response;
  run: () => Promise<AdapterResult>;
}

// the python profile also runs ruff and mypy; these adapter tests answer those tool commands alone
const toolVersions = new Map([
  ["ruff", "ruff 0.17.4"],
  ["mypy", "mypy 2.4.1"],
]);

export const execute: Execute = (command, options) => {
  const version = toolVersions.get(command[0] ?? "");
  return version === undefined
    ? runCommand(command, options)
    : Promise.resolve({ code: 0, stdout: `${version}\n`, stderr: "" });
};

export function fixture(
  t: TestContext,
  files: Record<string, string | Buffer> = { "main.py": "value = 1\n" },
  options: Record<string, unknown> = {},
  projectRoot = ".",
  project: Record<string, unknown> = {},
): PythonFixture {
  const parent = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-python-"));
  const root = join(parent, "candidate"),
    tools = join(parent, "tools");
  mkdirSync(root);
  mkdirSync(tools);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const write = (path: string, value: string | Buffer): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  for (const [path, value] of Object.entries(files)) {
    write(path, value);
  }
  const config = definePlumb({
    schemaVersion: 1,
    preset: "portable",
    projects: [{ root: projectRoot, profile: "python", options, ...project }],
  });
  const observed = new Map<string, string | null>();
  const readBytes = (path: string, { allowMissing = false }: ReadOptions = {}): Buffer | null => {
    let value: Buffer | null;
    try {
      value = readFileSync(safePath(root, path, { allowMissing }));
    } catch (error) {
      if (!allowMissing || errorCode(error) !== "ENOENT") {
        throw asError(error);
      }
      value = null;
    }
    const hash = value === null ? null : digest(value);
    if (observed.has(path) && observed.get(path) !== hash) {
      throw new Error(`Input changed: ${path}`);
    }
    observed.set(path, hash);
    return value;
  };
  const ctx = testContext({
    root,
    config,
    files: Object.keys(files).sort(),
    allFiles: Object.keys(files).sort(),
    readBytes,
    read: (path, options) => readBytes(path, options)?.toString("utf8") ?? null,
  });
  const registryFile = join(tools, "registry.json");
  writeFileSync(registryFile, JSON.stringify(manifest));
  const registry = loadAdapterRegistry(registryFile, root);
  const request = () => {
    const inputs = ctx.files.map((path) => {
      let raw: Buffer | null;
      try {
        raw = readFileSync(join(root, path));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          throw asError(error);
        }
        raw = null;
      }
      return { path, sha256: raw === null ? null : digest(raw) };
    });
    return {
      schemaVersion: 1,
      action: "check",
      adapter: "python",
      version: "1.0.0",
      root,
      project: config.projects[0],
      files: inputs,
      inputs,
      capabilities: ["syntax", "policy"],
    };
  };
  const direct = (
    value: unknown = request(),
    extra: { env?: NodeJS.ProcessEnv } = {},
  ): Response => {
    const result = invoke([], {
      cwd: root,
      input: typeof value === "string" ? value : JSON.stringify(value),
      ...extra,
    });
    const output = parseResponse(result.stdout);
    const codes: Record<string, number> = { pass: 0, violation: 1, incomplete: 2 };
    assert.equal(result.status, codes[output.status]);
    assert.deepEqual(output.versions, at(manifest, "adapters", 0, "tools"));
    return output;
  };
  const run = () => runAdapters(ctx, planAdapters(ctx, { registry }), { registry, execute });
  return { root, tools, ctx, registry, registryFile, write, request, direct, run };
}
