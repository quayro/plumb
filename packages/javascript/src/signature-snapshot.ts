import { isAbsolute } from "node:path";

import { canonical } from "../../../src/files.ts";
import { isRecord } from "../../../src/schema.ts";

export interface SignatureSnapshot {
  schemaVersion: 2;
  exports: Record<string, string[]>;
  routing: string;
  targets: Record<string, unknown>;
  signatures: Record<string, unknown>;
  compiler: {
    typescript: string;
    libraries: string;
    options: Record<string, boolean>;
  };
}

export interface ExportTarget {
  key: string;
  file: string;
  priority: number[];
}

const record = isRecord;

// an object holding exactly these keys, each still unchecked
const keys = <K extends string>(
  value: unknown,
  allowed: readonly K[],
): value is Record<K, unknown> =>
  record(value) &&
  Object.keys(value).length === allowed.length &&
  allowed.every((key) => Object.hasOwn(value, key));

const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const label = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !value.split("/").includes("..") &&
  /^(?:\.\/|workspace:|package:|typescript:)/.test(value);

const routingIsValid = (value: unknown): boolean => {
  if (typeof value !== "string") {
    return false;
  }
  const target = (item: unknown): boolean =>
    item === null ||
    (typeof item === "string" && !item.includes("\0")) ||
    (Array.isArray(item) && item.every(target)) ||
    (record(item) &&
      Object.entries(item).every(([key, entry]) => !key.includes("\0") && target(entry)));
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && target(parsed) && JSON.stringify(parsed) === value;
  } catch {
    return false;
  }
};

export function signatureSnapshotIsValid(value: unknown): value is SignatureSnapshot {
  if (
    !keys(value, ["schemaVersion", "exports", "targets", "routing", "signatures", "compiler"]) ||
    value.schemaVersion !== 2 ||
    !routingIsValid(value.routing)
  ) {
    return false;
  }
  if (
    !keys(value.compiler, ["typescript", "libraries", "options"]) ||
    typeof value.compiler.typescript !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.compiler.typescript) ||
    !hash(value.compiler.libraries)
  ) {
    return false;
  }
  if (
    !keys(value.compiler.options, [
      "strictNullChecks",
      "strictFunctionTypes",
      "exactOptionalPropertyTypes",
      "noUncheckedIndexedAccess",
    ]) ||
    !Object.values(value.compiler.options).every((value) => typeof value === "boolean") ||
    !value.compiler.options.strictNullChecks ||
    !value.compiler.options.strictFunctionTypes
  ) {
    return false;
  }
  if (
    !record(value.exports) ||
    !Object.keys(value.exports).length ||
    !Object.values(value.exports).every(
      (names) =>
        Array.isArray(names) &&
        names.every((name) => typeof name === "string") &&
        new Set(names).size === names.length,
    )
  ) {
    return false;
  }
  const { targets, signatures } = value;
  if (
    !record(targets) ||
    canonical(Object.keys(targets).sort()) !== canonical(Object.keys(value.exports).sort()) ||
    !record(signatures)
  ) {
    return false;
  }
  if (
    !Object.values(targets).every(
      (target) =>
        keys(target, ["module", "priority"]) &&
        label(target.module) &&
        Object.hasOwn(signatures, target.module) &&
        Array.isArray(target.priority) &&
        target.priority.every((value) => Number.isSafeInteger(value) && value >= 0),
    )
  ) {
    return false;
  }
  return Object.entries(signatures).every(
    ([path, item]) =>
      label(path) &&
      keys(item, ["declaration", "references"]) &&
      typeof item.declaration === "string" &&
      !item.declaration.includes("\0") &&
      record(item.references) &&
      Object.entries(item.references).every(
        ([specifier, target]) =>
          specifier &&
          !specifier.includes("\0") &&
          !isAbsolute(specifier) &&
          !/^[a-z]:[\\/]/i.test(specifier) &&
          label(target) &&
          Object.hasOwn(signatures, target),
      ),
  );
}
