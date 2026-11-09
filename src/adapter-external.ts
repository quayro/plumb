import { readFileSync } from "node:fs";

import type { CoverageRecord } from "./adapter-native.ts";
import { projectFiles, same, statusOf } from "./adapter-plan.ts";
import {
  type Adapter,
  type AdapterRegistry,
  environment,
  registrySchema,
  verifyRegistry,
} from "./adapter-registry.ts";
import type { Project } from "./config.ts";
import type { Context } from "./context.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { asError, errorCode } from "./errors.ts";
import { digest, globMatches, normalize } from "./files.ts";
import type { Execute } from "./process.ts";
import { sandboxed } from "./sandbox.ts";
import { array, object, validateSchema } from "./schema.ts";

// one request and one validated response per external adapter project, over a JSON protocol

const text = { type: "string", minLength: 1 } as const;
const name = { ...text, pattern: "^[a-z][a-z0-9-]*$" } as const;

type ExternalContext = Pick<Context, "root" | "files" | "config" | "safePath"> &
  Partial<Pick<Context, "readBytes" | "read" | "allFiles">>;

export interface ExternalRun {
  diagnostics: Diagnostic[];
  coverage: CoverageRecord[];
  versions: Record<string, string>;
  identity: { id: string; version: string; environment: unknown; integrity: unknown };
}

const locationSchema = object(
  {
    path: text,
    line: { type: "integer", minimum: 1 },
    column: { type: "integer", minimum: 1 },
    message: text,
  },
  ["path"],
);
export const responseSchema = object(
  {
    schemaVersion: { const: 1 },
    adapter: name,
    version: text,
    status: { enum: ["pass", "violation", "incomplete"] as const },
    diagnostics: array(
      object(
        {
          rule: text,
          path: text,
          message: text,
          remedy: text,
          status: { enum: ["violation", "incomplete"] as const },
          line: { type: "integer", minimum: 1 },
          column: { type: "integer", minimum: 1 },
          relatedLocations: array(locationSchema),
        },
        ["rule", "path", "message"],
      ),
    ),
    coverage: array(object({ capability: name, files: array(text) }, ["capability", "files"])),
    inputs: array(object({ path: text, sha256: {} }, ["path", "sha256"])),
    versions: { type: "object", additionalProperties: text },
  },
  ["schemaVersion", "adapter", "version", "status", "diagnostics", "coverage", "inputs"],
);

const evidence = array(object({ path: text, sha256: {} }, ["path", "sha256"]));

const requestSchema = object(
  {
    schemaVersion: { const: 1 },
    action: { enum: ["check", "doctor"] as const },
    adapter: name,
    version: text,
    root: text,
    project: { type: "object" },
    files: evidence,
    inputs: evidence,
    capabilities: array(name),
  },
  [
    "schemaVersion",
    "action",
    "adapter",
    "version",
    "root",
    "project",
    "files",
    "inputs",
    "capabilities",
  ],
);

// the adapter protocol as one published document: what a registry declares, what the core sends
// and what an adapter answers. A change to any of these is a change to the plugin API.
export const protocolSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:plumb:adapter-protocol:v1",
  title: "Plumb adapter protocol, version 1",
  $defs: { registry: registrySchema, request: requestSchema, response: responseSchema },
};

// input hashes are validated below as SHA-256 or observed absence; the schema vocabulary has no
// unions.
export async function externalRun(
  ctx: ExternalContext,
  project: Project,
  entry: Adapter,
  registry: AdapterRegistry,
  execute: Execute,
  doctor: boolean,
): Promise<ExternalRun> {
  verifyRegistry(registry, ctx.root);
  validateSchema(project.options ?? {}, entry.optionsSchema, `project ${project.root}.options`);
  const selected = projectFiles(ctx, project, registry),
    inputs = new Map<string, string | null>();
  if (!selected.length) {
    throw new Error(`No ${entry.id} source files are owned by this project`);
  }
  const observe = (path: string): { path: string; sha256: string | null } => {
    let value: Buffer | null;
    if (ctx.readBytes) {
      value = ctx.readBytes(path, { allowMissing: true });
    } else {
      ctx.read?.(path, { allowMissing: true });
      try {
        value = readFileSync(ctx.safePath(path, { allowMissing: true }));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          throw asError(error);
        }
        value = null;
      }
    }
    const sha256 = value === null ? null : digest(value);
    if (inputs.has(path) && inputs.get(path) !== sha256) {
      throw new Error(`Adapter input changed while checking: ${path}`);
    }
    inputs.set(path, sha256);
    return { path, sha256 };
  };
  const files = selected.map(observe);
  for (const pattern of entry.inputs) {
    if (!/[?*{}]/.test(pattern) && normalize(pattern) !== "." && !pattern.endsWith("/")) {
      observe(normalize(pattern));
    }
  }
  for (const path of ctx.allFiles ?? ctx.files) {
    if (globMatches(entry.inputs, path)) {
      observe(path);
    }
  }
  const env = environment(entry);
  const request = {
    schemaVersion: 1,
    action: doctor ? "doctor" : "check",
    adapter: entry.id,
    version: entry.version,
    root: ctx.root,
    project,
    files,
    inputs: [...inputs].map(([path, sha256]) => ({ path, sha256 })),
    capabilities: entry.capabilities,
  };
  // what is sent is exactly what the published protocol describes
  validateSchema(request, requestSchema, "adapter request");
  const result = await execute(entry.sandbox ? sandboxed(entry.command) : entry.command, {
    cwd: ctx.safePath(project.root),
    timeout: ctx.config.tools?.timeout ?? 120000,
    inheritEnv: false,
    env: env.values,
    input: JSON.stringify(request) + "\n",
  });
  verifyRegistry(registry, ctx.root);
  if (result.error || (result.code !== 0 && result.code !== 1 && result.code !== 2)) {
    throw new Error(result.error ?? `${entry.id} exited ${String(result.code)}: ${result.stderr}`);
  }
  const response: unknown = JSON.parse(result.stdout);
  validateSchema(response, responseSchema, "adapter response");
  if (
    response.adapter !== entry.id ||
    response.version !== entry.version ||
    result.code !== (response.status === "pass" ? 0 : response.status === "violation" ? 1 : 2)
  ) {
    throw new Error("Adapter response identity or exit status does not match its declaration");
  }
  const rules = new Map(entry.rules.map((rule) => [rule.id, rule]));
  const diagnostics = response.diagnostics.map((item): Diagnostic => {
    const rule = rules.get(item.rule);
    if (
      !rule ||
      (!selected.includes(normalize(item.path)) &&
        !globMatches(entry.inputs, item.path) &&
        !(normalize(item.path) === project.root && item.status === "incomplete"))
    ) {
      throw new Error(
        "Adapter reported an unknown rule or a diagnostic outside its selected scope",
      );
    }
    ctx.safePath(item.path, { allowMissing: item.status === "incomplete" });
    for (const related of item.relatedLocations ?? []) {
      ctx.safePath(related.path);
      if (!selected.includes(normalize(related.path)) && !globMatches(entry.inputs, related.path)) {
        throw new Error("Adapter related location is outside its declared inputs");
      }
    }
    return {
      ...item,
      path: normalize(item.path),
      remedy: item.remedy ?? rule.remedy,
      suppressible: item.status !== "incomplete" && rule.suppressible !== false,
      check: `${entry.id}.${rule.capability ?? entry.capabilities[0] ?? ""}:${project.root}`,
    };
  });
  if (statusOf(diagnostics) !== response.status) {
    throw new Error("Adapter diagnostics contradict its reported status");
  }
  if (!same(Object.keys(response.versions ?? {}), Object.keys(entry.tools ?? {}))) {
    throw new Error("Adapter tool versions do not match its declared tool set");
  }
  for (const [tool, expected] of Object.entries(entry.tools ?? {})) {
    const reported = response.versions?.[tool];
    if (reported !== expected) {
      throw new Error(`${tool} is ${String(reported)}; the adapter requires ${expected}`);
    }
  }
  const seen = new Set<string>();
  for (const input of response.inputs) {
    const path = normalize(input.path);
    if (
      seen.has(path) ||
      (!selected.includes(path) && !globMatches(entry.inputs, path)) ||
      (input.sha256 !== null &&
        (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)))
    ) {
      throw new Error("Adapter reported duplicate, out-of-scope or malformed input evidence");
    }
    seen.add(path);
    if (observe(path).sha256 !== input.sha256) {
      throw new Error(`Adapter read a different input: ${path}`);
    }
  }
  if (!doctor && selected.some((path) => !seen.has(path))) {
    throw new Error("Adapter omitted source input hashes");
  }
  for (const [path, before] of [...inputs]) {
    if (observe(path).sha256 !== before) {
      throw new Error(`Adapter mutated an observed input: ${path}`);
    }
  }
  if (doctor && response.coverage.length) {
    throw new Error("A doctor response cannot claim executed source coverage");
  }
  const coverage = response.coverage.map((row): CoverageRecord => {
    const id = `${entry.id}.${row.capability}:${project.root}`;
    return {
      id,
      checkedFiles: row.files.map(normalize),
      status: statusOf(diagnostics.filter((item) => item.check === id)),
    };
  });
  return {
    diagnostics,
    coverage,
    versions: {
      [`adapter/${entry.id}`]: entry.version,
      ...(response.versions ?? {}),
      ...Object.fromEntries(
        Object.entries(response.versions ?? {}).map(([tool, version]) => [
          `${entry.id}/${tool}@${project.root}`,
          version,
        ]),
      ),
    },
    identity: {
      id: entry.id,
      version: entry.version,
      environment: env.identity,
      integrity: entry.integrity,
    },
  };
}
