import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { JavascriptPack } from "../src/adapters.ts";
import { type Config, definePlumb } from "../src/config.ts";
import type { Context } from "../src/context.ts";
import { type Diagnostic, isDiagnostic, isStatus, type Report } from "../src/diagnostics.ts";
import { asError, errorCode } from "../src/errors.ts";
import { globMatches, safePath } from "../src/files.ts";
import { at, isArray, isRecord } from "../src/schema.ts";

// JSON from a command or a file is untrusted until a test reads a field it checked
export const parseJson = (text: string): unknown => {
  const value: unknown = JSON.parse(text);
  return value;
};

const diagnosticsOf = (value: unknown): Diagnostic[] =>
  isArray(value) ? value.filter(isDiagnostic) : [];

// a command's JSON report, with its diagnostics checked one by one
export const parseReport = (text: string): Report => {
  const value = parseJson(text);
  if (!isRecord(value) || !isStatus(value.status) || !isArray(value.diagnostics)) {
    throw new TypeError(`Expected a Plumb report, received ${text.slice(0, 200)}`);
  }
  return {
    ...value,
    schemaVersion: 1,
    status: value.status,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : 0,
    diagnostics: diagnosticsOf(value.diagnostics),
    ...(isArray(value.suppressed) && { suppressed: diagnosticsOf(value.suppressed) }),
  };
};

// a validated effective policy from the fields a test sets
export const policy = (value: Record<string, unknown> = {}): Config =>
  definePlumb({ schemaVersion: 1, preset: "portable", ...value });

// the length of a value read back from JSON, when it is a list or text
export const keysOf = (value: unknown): string[] => (isRecord(value) ? Object.keys(value) : []);

export const lengthOf = (value: unknown): number | undefined =>
  isArray(value) || typeof value === "string" ? value.length : undefined;

type PackCheck = JavascriptPack["check"];

// a JavaScript pack double: the checks a test supplies, and inert answers for the rest of the contract
export const fakePack = (pack: {
  rules?: JavascriptPack["rules"];
  check?: (
    ...args: Parameters<PackCheck>
  ) => Awaited<ReturnType<PackCheck>> | ReturnType<PackCheck>;
}): JavascriptPack => ({
  rules: pack.rules ?? ((): [] => []),
  check: async (ctx, checks) => (pack.check ? await pack.check(ctx, checks) : { diagnostics: [] }),
  fix: async () => ({ diagnostics: [], written: [] }),
  snapshot: async () => [],
  surfaceSnapshotIsValid: () => false,
});

// reads each item of a value from JSON, which has no items unless it is a list
export const mapped = <T>(value: unknown, read: (item: unknown) => T): T[] =>
  isArray(value) ? value.map(read) : [];

const readOrMissing = <T>(read: () => T, allowMissing = false): T | null => {
  try {
    return read();
  } catch (error) {
    if (allowMissing && errorCode(error) === "ENOENT") {
      return null;
    }
    throw asError(error);
  }
};

// a complete checker context over a test folder; a test overrides only the fields it exercises
export const testContext = (
  fields: Pick<Context, "root" | "config"> & Partial<Context>,
): Context => {
  const { root } = fields;
  const files = fields.files ?? [];
  return {
    files,
    allFiles: files,
    problems: [],
    source: "test",
    path: join(root, "plumb.json"),
    origins: {},
    policyInputs: [],
    policySources: [],
    ownedFiles: [],
    protectedFiles: [],
    writableFiles: files,
    inputs: new Map(),
    compilerInputs: new Map(),
    compilerDirectories: new Map(),
    registry: undefined,
    mode: "check",
    configFile: "plumb.json",
    readBytes: (path, options) =>
      readOrMissing(() => readFileSync(safePath(root, path)), options?.allowMissing),
    readCompilerInput: (path, options) =>
      readOrMissing(() => readFileSync(safePath(root, path), "utf8"), options?.allowMissing),
    readCompilerDirectory: () => null,
    read: (path, options) =>
      readOrMissing(() => readFileSync(safePath(root, path), "utf8"), options?.allowMissing),
    safePath: (path, options) => safePath(root, path, options),
    matches: globMatches,
    ...fields,
  };
};

// writes one field of a JSON value in place, creating nothing: a missing step leaves the value as
// it was
export const setAt = (value: unknown, path: readonly (string | number)[], next: unknown): void => {
  const keys = [...path];
  const last = keys.pop();
  const parent = at(value, ...keys);
  if (typeof last === "number" && isArray(parent)) {
    parent[last] = next;
  } else if (typeof last === "string" && isRecord(parent)) {
    parent[last] = next;
  }
};
