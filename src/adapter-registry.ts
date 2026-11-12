import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { canonical, digest } from "./files.ts";
import { array, type Infer, isRecord, object, type Shape, validateSchema } from "./schema.ts";

// the external adapter registry: its schema, pinned integrity and the identity a run reports
const text = { type: "string", minLength: 1 } as const;
const name = { ...text, pattern: "^[a-z][a-z0-9-]*$" } as const;

const hash = { ...text, pattern: "^[a-f0-9]{64}$" } as const;
const metadata = object(
  {
    id: text,
    description: text,
    remedy: text,
    suppressible: { type: "boolean" },
    capability: name,
  },
  ["id", "description", "remedy"],
);
export const registrySchema = object(
  {
    schemaVersion: { const: 1 },
    adapters: array(
      object(
        {
          id: name,
          version: text,
          files: array({ ...text, format: "glob" }, 1),
          capabilities: array(name, 1),
          command: array(text, 1),
          integrity: array(object({ path: text, sha256: hash }, ["path", "sha256"]), 1),
          environment: array({ ...text, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
          inputs: array({ ...text, format: "glob" }),
          rules: array(metadata, 1),
          optionsSchema: { type: "object" },
          tools: { type: "object", additionalProperties: text },
          sandbox: { type: "boolean" },
        },
        ["id", "version", "files", "capabilities", "command", "integrity", "rules"],
      ),
    ),
  },
  ["schemaVersion", "adapters"],
);

type RegistryEntry = Infer<typeof registrySchema>["adapters"][number];

export interface Adapter extends Omit<RegistryEntry, "optionsSchema" | "environment" | "inputs"> {
  optionsSchema: Shape;
  environment: string[];
  inputs: string[];
}

export interface AdapterRegistry {
  path: string;
  sha256: string;
  candidateRoot: string;
  adapters: Adapter[];
}

const withinAbsolute = (root: string, file: string): boolean => {
  const path = relative(root, file);
  return (
    !path ||
    (path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(path))
  );
};

export function fileHash(path: string): string {
  const value = createHash("sha256"),
    descriptor = openSync(path, "r"),
    buffer = Buffer.allocUnsafe(65536);
  try {
    for (let length; (length = readSync(descriptor, buffer, 0, buffer.length, null));) {
      value.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(descriptor);
  }
  return value.digest("hex");
}

function checkedSchema(shape: unknown): asserts shape is Shape {
  const allowed = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "pattern",
    "format",
    "minLength",
    "minItems",
    "uniqueItems",
    "minimum",
    "maximum",
  ]);
  if (!isRecord(shape) || Object.keys(shape).some((key) => !allowed.has(key))) {
    throw new Error("Adapter optionsSchema uses unsupported schema keywords");
  }
  if (
    shape.type !== undefined &&
    !["object", "array", "string", "boolean", "integer"].includes(String(shape.type))
  ) {
    throw new Error("Adapter optionsSchema has an unsupported type");
  }
  if (
    shape.type === "object" &&
    shape.additionalProperties !== false &&
    typeof shape.additionalProperties !== "object"
  ) {
    throw new Error("Adapter object schemas must explicitly constrain additionalProperties");
  }
  if (shape.properties !== undefined) {
    if (!isRecord(shape.properties)) {
      throw new Error("Adapter schema properties must be an object");
    }
    for (const [key, child] of Object.entries(shape.properties)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new Error("Invalid adapter schema property");
      }
      checkedSchema(child);
    }
  }
  if (shape.items !== undefined) {
    checkedSchema(shape.items);
  }
  if (shape.type === "array" && !shape.items) {
    throw new Error("Adapter array schemas require items");
  }
  if (typeof shape.additionalProperties === "object" && shape.additionalProperties !== null) {
    checkedSchema(shape.additionalProperties);
  }
  if (shape.pattern !== undefined) {
    new RegExp(String(shape.pattern));
  }
  if (shape.format !== undefined && !["path", "glob", "regex"].includes(String(shape.format))) {
    throw new Error("Adapter schema format is unsupported");
  }
}

export function externalFile(path: string, root: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`Adapter paths must be absolute: ${path}`);
  }
  const actual = realpathSync(path);
  if (withinAbsolute(root, actual)) {
    throw new Error(`Adapter code and registry must be outside the candidate: ${path}`);
  }
  if (!statSync(actual).isFile()) {
    throw new Error(`Adapter input is not a regular file: ${path}`);
  }
  return actual;
}

function commandFiles(
  entry: Pick<RegistryEntry, "id" | "integrity" | "command">,
  root: string,
): void {
  const pinned = new Set(entry.integrity.map((item) => item.path));
  for (const [index, argument] of entry.command.entries()) {
    if (index === 0) {
      continue;
    }
    if (argument === "-m" || argument.startsWith("--module=") || /^-m[^-]/.test(argument)) {
      throw new Error(
        `${entry.id}: use a pinned absolute adapter file instead of module-name resolution`,
      );
    }
    if (["-r", "--require", "--import"].includes(argument)) {
      const file = entry.command[index + 1];
      if (!file || !isAbsolute(file) || !pinned.has(file)) {
        throw new Error(`${entry.id}: runtime imports must be absolute pinned files`);
      }
    }
    if (
      /^--(?:require|import)=/.test(argument) &&
      !pinned.has(argument.slice(argument.indexOf("=") + 1))
    ) {
      throw new Error(`${entry.id}: runtime imports must be absolute pinned files`);
    }
    if (/^-r[^-]/.test(argument) && !pinned.has(argument.slice(2))) {
      throw new Error(`${entry.id}: runtime imports must be absolute pinned files`);
    }
    const value =
      argument.startsWith("-") && argument.includes("=")
        ? argument.slice(argument.indexOf("=") + 1)
        : argument;
    if (value.startsWith("-")) {
      continue;
    }
    if (isAbsolute(value)) {
      if (existsSync(value) && statSync(value).isFile() && !pinned.has(value)) {
        throw new Error(`${entry.id}: command file must be pinned: ${value}`);
      }
    } else if (
      /^(?:\.\.?[\\/])|\.(?:[cm]?[jt]s|py|rb|sh|ps1|exe|wasm)$/i.test(value) ||
      existsSync(resolve(root, value))
    ) {
      throw new Error(
        `${entry.id}: relative command file is not an approved external entrypoint: ${value}`,
      );
    }
  }
}

export function loadAdapterRegistry(
  file: string | undefined,
  candidateRoot: string,
): AdapterRegistry | undefined {
  if (!file) {
    return undefined;
  }
  const root = realpathSync(candidateRoot),
    path = externalFile(resolve(file), root),
    source = readFileSync(path, "utf8");
  const value: unknown = JSON.parse(source);
  validateSchema(value, registrySchema, "adapters");
  const ids = new Set(["javascript", "typescript", "react", "native", "core"]),
    rules = new Set<string>();
  const adapters = value.adapters.map((entry): Adapter => {
    if (ids.has(entry.id)) {
      throw new Error(`Duplicate or reserved adapter ${entry.id}`);
    }
    ids.add(entry.id);
    const pinned = new Map<string, string>();
    for (const item of entry.integrity) {
      externalFile(item.path, root);
      if (pinned.has(item.path)) {
        throw new Error(`Duplicate integrity input ${item.path}`);
      }
      if (fileHash(item.path) !== item.sha256) {
        throw new Error(`Adapter integrity mismatch: ${item.path}`);
      }
      pinned.set(item.path, item.sha256);
    }
    const executable = entry.command[0] ?? "";
    if (!isAbsolute(executable) || !pinned.has(executable)) {
      throw new Error(`${entry.id}: the executable must be absolute and pinned`);
    }
    commandFiles(entry, root);
    for (const rule of entry.rules) {
      if (!rule.id.startsWith(`${entry.id}/`) || rules.has(rule.id)) {
        throw new Error(`Duplicate or unnamespaced adapter rule ${rule.id}`);
      }
      if (
        (entry.capabilities.length !== 1 && !rule.capability) ||
        (rule.capability && !entry.capabilities.includes(rule.capability))
      ) {
        throw new Error(`${rule.id}: declare the rule's capability`);
      }
      rules.add(rule.id);
    }
    const optionsSchema: unknown = entry.optionsSchema ?? object({});
    checkedSchema(optionsSchema);
    return {
      ...entry,
      optionsSchema,
      environment: entry.environment ?? [],
      inputs: entry.inputs ?? [],
    };
  });
  return { path, sha256: digest(source), candidateRoot: root, adapters };
}

export function verifyRegistry(registry: AdapterRegistry | undefined, root: string): void {
  if (!registry) {
    return;
  }
  externalFile(registry.path, realpathSync(root));
  externalFile(registry.path, registry.candidateRoot);
  if (fileHash(registry.path) !== registry.sha256) {
    throw new Error("The adapter registry changed during the run");
  }
  for (const entry of registry.adapters) {
    commandFiles(entry, realpathSync(root));
    commandFiles(entry, registry.candidateRoot);
    for (const pin of entry.integrity) {
      externalFile(pin.path, realpathSync(root));
      externalFile(pin.path, registry.candidateRoot);
      if (fileHash(pin.path) !== pin.sha256) {
        throw new Error(`Adapter integrity mismatch: ${pin.path}`);
      }
    }
  }
}

export function environment(entry: Pick<Adapter, "environment">): {
  values: Record<string, string>;
  identity: { names: string[]; sha256: string };
} {
  const values = Object.fromEntries(
    entry.environment.flatMap((key): [string, string][] => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return {
    values,
    identity: {
      names: entry.environment,
      sha256: digest(canonical(entry.environment.map((key) => [key, process.env[key] ?? null]))),
    },
  };
}

export function registryIdentity(registry: AdapterRegistry | undefined): unknown {
  return registry
    ? {
        path: registry.path,
        sha256: registry.sha256,
        adapters: registry.adapters.map((entry) => ({
          id: entry.id,
          version: entry.version,
          integrity: entry.integrity,
          environment: environment(entry).identity,
        })),
      }
    : undefined;
}
