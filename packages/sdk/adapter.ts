import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// the adapter SDK: one dependency-free file that speaks Plumb's external adapter protocol, so an
// adapter is only its rules and a function from one source file to findings.

export const PROTOCOL = 1;

export interface AdapterRule {
  id: string;
  description: string;
  remedy: string;
  capability?: string;
  suppressible?: boolean;
}

export interface Finding {
  rule: string;
  message: string;
  line?: number;
  column?: number;
  status?: "violation" | "incomplete";
}

export interface AdapterDefinition {
  id: string;
  version: string;
  files: string[];
  capabilities: string[];
  rules: AdapterRule[];
  optionsSchema?: Record<string, unknown>;
  check: (file: { path: string; text: string }, options: Record<string, unknown>) => Finding[];
}

interface Diagnostic extends Finding {
  path: string;
}

interface Evidence {
  path: string;
  sha256: string | null;
}

export interface Response {
  schemaVersion: 1;
  adapter: string;
  version: string;
  status: "pass" | "violation" | "incomplete";
  diagnostics: Diagnostic[];
  coverage: { capability: string; files: string[] }[];
  inputs: Evidence[];
}

const EXIT = { pass: 0, violation: 1, incomplete: 2 };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// every adapter reports unreadable input and a malformed request under these two rules
const builtIn = (definition: AdapterDefinition): AdapterRule[] => [
  {
    id: "input",
    description: "Every selected source has the expected bytes and remains readable.",
    remedy: "Restore the selected input and rerun the complete check.",
    suppressible: false,
  },
  {
    id: "protocol",
    description: "Requests use the supported protocol, identity and options.",
    remedy: "Correct the adapter request or installation.",
    suppressible: false,
  },
  ...definition.rules,
];

// the registry entry for this adapter: the runtime, the script and this SDK pinned by content hash
export function manifest(definition: AdapterDefinition, script: string): unknown {
  const command = [realpathSync(process.execPath), realpathSync(script)];
  return {
    schemaVersion: 1,
    adapters: [
      {
        id: definition.id,
        version: definition.version,
        files: definition.files,
        capabilities: definition.capabilities,
        command,
        integrity: [...command, realpathSync(fileURLToPath(import.meta.url))].map((path) => ({
          path,
          sha256: sha256(readFileSync(path)),
        })),
        environment: [],
        rules: builtIn(definition).map((rule) => ({
          ...rule,
          id: `${definition.id}/${rule.id}`,
          capability: rule.capability ?? definition.capabilities[0],
        })),
        optionsSchema: definition.optionsSchema ?? { type: "object", additionalProperties: false },
      },
    ],
  };
}

function reply(
  definition: AdapterDefinition,
  diagnostics: Diagnostic[],
  covered: string[],
  inputs: Evidence[],
): Response {
  return {
    schemaVersion: PROTOCOL,
    adapter: definition.id,
    version: definition.version,
    status: diagnostics.some((item) => item.status === "incomplete")
      ? "incomplete"
      : diagnostics.length
        ? "violation"
        : "pass",
    diagnostics,
    coverage: covered.length
      ? definition.capabilities.map((capability) => ({ capability, files: covered }))
      : [],
    inputs,
  };
}

// answers one protocol request. Anything the adapter cannot verify is incomplete, never a pass.
export function respond(definition: AdapterDefinition, request: unknown): Response {
  const namespaced = (rule: string): string => `${definition.id}/${rule}`;
  const incomplete = (rule: string, path: string, message: string): Diagnostic => ({
    rule: namespaced(rule),
    path,
    message,
    status: "incomplete",
  });
  const refuse = (message: string): Response =>
    reply(definition, [incomplete("protocol", ".", message)], [], []);
  if (
    !isRecord(request) ||
    request.schemaVersion !== PROTOCOL ||
    request.adapter !== definition.id ||
    request.version !== definition.version ||
    typeof request.root !== "string" ||
    !Array.isArray(request.files)
  ) {
    return refuse("Unsupported protocol, adapter identity or version.");
  }
  if (request.action === "doctor") {
    return reply(definition, [], [], []);
  }
  if (request.action !== "check") {
    return refuse("Unsupported action.");
  }
  const options = isRecord(request.project) ? request.project.options : undefined,
    known = new Set(builtIn(definition).map((rule) => rule.id));
  const diagnostics: Diagnostic[] = [],
    covered: string[] = [],
    inputs: Evidence[] = [];
  for (const file of request.files) {
    const path: unknown = isRecord(file) ? file.path : undefined;
    if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
      return refuse("A selected file is not a repository-relative path.");
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(request.root, path));
    } catch (error) {
      inputs.push({ path, sha256: null });
      diagnostics.push(incomplete("input", path, `Cannot read the source: ${messageOf(error)}`));
      continue;
    }
    const actual = sha256(bytes);
    inputs.push({ path, sha256: actual });
    if (!isRecord(file) || file.sha256 !== actual) {
      diagnostics.push(incomplete("input", path, "Source hash differs from the requested input."));
      continue;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      for (const finding of definition.check({ path, text }, isRecord(options) ? options : {})) {
        if (!known.has(finding.rule)) {
          throw new Error(`The adapter reported the undeclared rule ${finding.rule}`);
        }
        diagnostics.push({ ...finding, rule: namespaced(finding.rule), path });
      }
      covered.push(path);
    } catch (error) {
      diagnostics.push(
        incomplete("input", path, `The source cannot be checked: ${messageOf(error)}`),
      );
    }
  }
  return reply(definition, diagnostics, covered, inputs);
}

// the whole command-line contract: --manifest prints the registry; otherwise one request on stdin
// gets one response on stdout and the matching exit code.
export function serve(
  definition: AdapterDefinition,
  script: string,
  argv: readonly string[] = process.argv.slice(2),
): void {
  if (argv.includes("--manifest")) {
    process.stdout.write(`${JSON.stringify(manifest(definition, script), null, 2)}\n`);
    return;
  }
  let request: unknown;
  try {
    request = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // an unreadable request is answered as a refused one
    request = undefined;
  }
  const response = respond(definition, request);
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exitCode = EXIT[response.status];
}
