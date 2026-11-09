import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { asError, errorCode, errorMessage } from "./errors.ts";
import { canonical, digest, normalize } from "./files.ts";
import { at, isArray, isRecord } from "./schema.ts";

export interface InputRecord {
  path: string;
  kind: "file" | "directory";
  mode: number;
  sha256?: string;
}

interface InputEntry {
  path: string;
  source: string;
  sha256: string;
  kind: "file" | "directory";
  records: readonly InputRecord[];
}

interface InputIdentity {
  sha256: string;
  files: readonly { path: string; sha256: string; kind: string }[];
}

export interface LoadedInputs {
  path: string;
  entries: readonly InputEntry[];
  identity: InputIdentity;
  verify: () => boolean;
}

export interface MaterializedInputs {
  identity: InputIdentity;
  files: string[];
  verify: () => boolean;
}

export const compare = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

export const inside = (root: string, path: string): boolean => {
  const local = relative(root, path);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
};

export function name(value: unknown, dependencies = false): string {
  if (
    typeof value !== "string" ||
    value === "." ||
    !value ||
    value.includes("\0") ||
    normalize(value) !== value ||
    isAbsolute(value) ||
    /^[a-z]:/i.test(value)
  ) {
    throw new Error(`Unsupported relative path: ${value}`);
  }
  if (
    value
      .split("/")
      .some((part) =>
        ["..", ".git", ".hg", ".svn", ...(dependencies ? [] : ["node_modules"])].includes(
          part.toLowerCase(),
        ),
      )
  ) {
    throw new Error(`Reserved or escaping path: ${value}`);
  }
  return value;
}

function ordinaryAbsolute(path: unknown): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("Input sources must be absolute filesystem paths");
  }
  const target = resolve(path);
  let cursor = parse(target).root;
  for (const part of relative(cursor, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Input symlinks are not supported: ${path}`);
    }
  }
  return target;
}

function fileDigest(path: string): string {
  const hash = createHash("sha256"),
    file = openSync(path, "r"),
    buffer = Buffer.allocUnsafe(65536);
  try {
    for (let count; (count = readSync(file, buffer, 0, buffer.length, null));) {
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(file);
  }
  return hash.digest("hex");
}

function inputRecords(path: string): InputRecord[] {
  const source = ordinaryAbsolute(path),
    rows: InputRecord[] = [];
  const walk = (absolute: string, local: string): void => {
    const stat = lstatSync(absolute),
      mode = stat.mode & 0o777;
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`Input trees contain only regular files and directories: ${absolute}`);
    }
    rows.push({
      path: local,
      kind: stat.isFile() ? "file" : "directory",
      mode,
      ...(stat.isFile() ? { sha256: fileDigest(absolute) } : {}),
    });
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolute).sort(compare)) {
        name(child, true);
        walk(join(absolute, child), local === "." ? child : `${local}/${child}`);
      }
    }
  };
  walk(source, ".");
  return rows;
}

// input pins hash canonical paths, file bytes and permission modes, including empty directories.
export const inputDigest = (source: string): string => digest(canonical(inputRecords(source)));

export function loadInputs(manifestFile: string, candidateRoot: string): LoadedInputs {
  const path = ordinaryAbsolute(resolve(manifestFile)),
    candidate = realpathSync(candidateRoot);
  if (inside(candidate, path)) {
    throw new Error("The approved inputs manifest must be outside the candidate root");
  }
  const source = readFileSync(path, "utf8"),
    data: unknown = JSON.parse(source),
    listed = at(data, "files");
  if (
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    !isArray(listed) ||
    Object.keys(data).some((key) => !["schemaVersion", "files"].includes(key))
  ) {
    throw new Error("Inputs manifest requires schemaVersion: 1 and a files array");
  }
  const entries = listed.map((entry): InputEntry => {
    const pin = at(entry, "sha256");
    if (
      !isRecord(entry) ||
      Object.keys(entry).some((key) => !["path", "source", "sha256"].includes(key)) ||
      typeof pin !== "string" ||
      !/^[a-f0-9]{64}$/i.test(pin)
    ) {
      throw new Error("Each input needs path, absolute source and sha256");
    }
    const path = name(entry.path, true);
    const absolute = ordinaryAbsolute(entry.source),
      records = inputRecords(absolute),
      sha256 = digest(canonical(records));
    if (sha256 !== pin.toLowerCase()) {
      throw new Error(`Input pin does not match ${path}`);
    }
    return Object.freeze({
      path,
      source: absolute,
      sha256,
      kind: records[0]?.kind ?? "file",
      records: Object.freeze(records.map((record) => Object.freeze(record))),
    });
  });
  for (const [i, entry] of entries.entries()) {
    for (const other of entries.slice(i + 1)) {
      if (
        entry.path === other.path ||
        entry.path.startsWith(`${other.path}/`) ||
        other.path.startsWith(`${entry.path}/`)
      ) {
        throw new Error("Input destinations must not overlap");
      }
    }
  }
  const identity = Object.freeze({
    sha256: digest(
      canonical({
        manifest: digest(source),
        entries: entries.map(({ path, sha256, kind }) => ({ path, sha256, kind })),
      }),
    ),
    files: Object.freeze(
      entries.map(({ path, sha256, kind }) => Object.freeze({ path, sha256, kind })),
    ),
  });
  return Object.freeze({
    path,
    entries: Object.freeze(entries),
    identity,
    verify(): boolean {
      if (readFileSync(ordinaryAbsolute(path), "utf8") !== source) {
        throw new Error("The approved inputs manifest changed during checking");
      }
      for (const entry of entries) {
        if (inputDigest(entry.source) !== entry.sha256) {
          throw new Error(`Approved input changed during checking: ${entry.path}`);
        }
      }
      return true;
    },
  });
}

function inputTarget(root: string, path: string): string {
  name(path, true);
  let cursor = realpathSync(root);
  const target = join(cursor, ...path.split("/"));
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`Input destination follows a symlink: ${path}`);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw asError(error);
      }
      break;
    }
  }
  return target;
}

export function materializeInputs(targetRoot: string, loaded: LoadedInputs): MaterializedInputs {
  const root = realpathSync(targetRoot),
    planned: (InputRecord & { target: string; source: string })[] = [];
  loaded.verify();
  for (const entry of loaded.entries) {
    for (const row of entry.records) {
      const path = row.path === "." ? entry.path : `${entry.path}/${row.path}`,
        target = inputTarget(root, path);
      if (existsSync(target)) {
        const stat = lstatSync(target);
        if (row.kind === "file" || !stat.isDirectory() || (stat.mode & 0o777) !== row.mode) {
          throw new Error(`Approved input collides with existing snapshot content: ${path}`);
        }
      }
      planned.push({
        ...row,
        path,
        target,
        source: row.path === "." ? entry.source : join(entry.source, ...row.path.split("/")),
      });
    }
  }
  const created: string[] = [],
    directories: { path: string; mode: number }[] = [];
  const ensureDirectory = (path: string): void => {
    if (path === root || existsSync(path)) {
      return;
    }
    ensureDirectory(dirname(path));
    mkdirSync(path, { mode: 0o700 });
    created.push(path);
    directories.push({ path, mode: 0o755 });
  };
  try {
    for (const row of planned) {
      inputTarget(root, row.path);
      ensureDirectory(dirname(row.target));
      if (row.kind === "directory") {
        if (!existsSync(row.target)) {
          mkdirSync(row.target, { mode: 0o700 });
          created.push(row.target);
          directories.push({ path: row.target, mode: row.mode });
        }
      } else {
        ordinaryAbsolute(row.source);
        copyFileSync(row.source, row.target, constants.COPYFILE_EXCL);
        created.push(row.target);
        chmodSync(row.target, row.mode);
        if (fileDigest(row.target) !== row.sha256) {
          throw new Error(`Approved input changed while copying: ${row.path}`);
        }
      }
    }
    for (const directory of directories.reverse()) {
      chmodSync(directory.path, directory.mode);
    }
    loaded.verify();
    const state = loaded.entries.map((entry) => ({
      path: entry.path,
      sha256: inputDigest(inputTarget(root, entry.path)),
    }));
    return {
      identity: loaded.identity,
      files: planned
        .filter((row) => row.kind === "file")
        .map((row) => row.path)
        .sort(compare),
      verify(): boolean {
        loaded.verify();
        for (const entry of state) {
          if (inputDigest(inputTarget(root, entry.path)) !== entry.sha256) {
            throw new Error(`Materialized input changed during checking: ${entry.path}`);
          }
        }
        return true;
      },
    };
  } catch (error) {
    // roll back what this call created; anything that cannot be removed is named in the failure
    const leftovers: string[] = [];
    for (const path of created) {
      try {
        if (lstatSync(path).isDirectory()) {
          chmodSync(path, 0o700);
        }
      } catch (error) {
        leftovers.push(`${path} (${errorMessage(error)})`);
      }
    }
    for (const path of created.reverse()) {
      try {
        if (lstatSync(path).isDirectory()) {
          rmdirSync(path);
        } else {
          rmSync(path, { force: true });
        }
      } catch (error) {
        leftovers.push(`${path} (${errorMessage(error)})`);
      }
    }
    if (leftovers.length) {
      throw new Error(`${errorMessage(error)}; rollback left ${leftovers.join(", ")}`, {
        cause: error,
      });
    }
    throw asError(error);
  }
}
