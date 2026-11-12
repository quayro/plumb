import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { TestContext } from "node:test";

import { type AdapterRegistry, loadAdapterRegistry } from "../src/adapter-registry.ts";
import { definePlumb } from "../src/config.ts";
import type { Context, ReadOptions } from "../src/context.ts";
import { asError, errorCode } from "../src/errors.ts";
import { digest, globMatches, safePath } from "../src/files.ts";
import { testContext } from "./support.ts";

const temporary = process.env.PLUMB_TEST_TMP ?? tmpdir();
export const nodeExecutable = isAbsolute(process.execPath)
  ? process.execPath
  : (process.env.PATH ?? "")
      .split(delimiter)
      .map((folder) => join(folder, process.execPath))
      .find(existsSync);
export const nodeHash = digest(readFileSync(nodeExecutable ?? process.execPath));
const program = `import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const request = JSON.parse(readFileSync(0, 'utf8'));
const files = request.files.map(({path}) => ({path, value: readFileSync(resolve(request.root,path))}));
const diagnostics = request.action === 'doctor' ? [] : files.filter(({value}) => value.toString().includes('ERROR')).map(({path}) => ({rule:request.adapter+'/syntax',path,line:1,column:1,message:'Invalid source marker'}));
if (process.env.PLUMB_ADAPTER_UNDECLARED) throw new Error('Inherited undeclared environment');
const response = {schemaVersion:1,adapter:request.adapter,version:'1.0.0',status:diagnostics.length?'violation':'pass',diagnostics,coverage:request.action==='doctor'?[]:request.capabilities.map(capability=>({capability,files:files.map(file=>file.path)})),inputs:request.action==='doctor'?[]:files.map(({path,value})=>({path,sha256:createHash('sha256').update(value).digest('hex')})),versions:{node:process.versions.node}};
RESPONSE_EDIT
process.stdout.write(JSON.stringify(response));
process.exitCode = {pass:0,violation:1,incomplete:2}[response.status];
`;

interface AdapterFixture {
  root: string;
  ctx: Context;
  write: (path: string, content: string | Buffer) => void;
  tools: string;
  script: string;
  registryFile: string;
  registry: (edit?: string, changes?: Record<string, unknown>) => AdapterRegistry | undefined;
  observed: Map<string, string | null>;
}

export function fixture(
  t: TestContext,
  files: Record<string, string | Buffer> = { "main.lua": "print('ok')\n" },
  config: Record<string, unknown> = {},
): AdapterFixture {
  const parent = mkdtempSync(join(temporary, "plumb-adapters-")),
    root = join(parent, "candidate"),
    tools = join(parent, "tools");
  mkdirSync(root);
  mkdirSync(tools);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const write = (path: string, content: string | Buffer): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  for (const [path, content] of Object.entries(files)) {
    write(path, content);
  }
  const policy = definePlumb({
    schemaVersion: 1,
    preset: "portable",
    projects: [{ root: ".", profile: "lua" }],
    ...config,
  });
  const observed = new Map<string, string | null>();
  const ctx = testContext({
    root,
    config: policy,
    files: Object.keys(files)
      .filter((path) => !policy.exclude.some((row) => globMatches(row.files, path)))
      .sort(),
    allFiles: Object.keys(files).sort(),
    ownedFiles: [],
    matches: globMatches,
    read: (path: string, { allowMissing = false }: ReadOptions = {}): string | null => {
      let value: string | null;
      try {
        value = readFileSync(safePath(root, path), "utf8");
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
    },
  });
  const script = join(tools, "adapter.mjs"),
    registryFile = join(tools, "registry.json");
  const registry = (
    edit = "",
    changes: Record<string, unknown> = {},
  ): ReturnType<typeof loadAdapterRegistry> => {
    writeFileSync(script, program.replace("RESPONSE_EDIT", edit));
    const descriptor = {
      id: "lua",
      version: "1.0.0",
      files: ["**/*.lua"],
      capabilities: ["syntax"],
      command: [nodeExecutable, script],
      integrity: [
        { path: nodeExecutable, sha256: nodeHash },
        { path: script, sha256: digest(readFileSync(script)) },
      ],
      environment: [],
      tools: { node: process.versions.node },
      rules: [
        {
          id: "lua/syntax",
          description: "Python syntax is valid",
          remedy: "Correct source syntax",
        },
      ],
      ...changes,
    };
    writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, adapters: [descriptor] }));
    return loadAdapterRegistry(registryFile, root);
  };
  return { root, ctx, write, tools, script, registryFile, registry, observed };
}
