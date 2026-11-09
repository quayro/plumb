import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Context } from "./context.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { asError, errorMessage } from "./errors.ts";
import { canonical, digest, inventory, isWithin, normalize, safePath } from "./files.ts";
import { type LoadedInputs, materializeInputs } from "./inputs.ts";
import { repairPatch } from "./patch.ts";
import { isPolicyFile } from "./policy.ts";
import { isArray, isRecord } from "./schema.ts";
import { copyWorkspace } from "./workspace.ts";

interface RepairChange {
  path: string;
  mode: number;
  beforeSha256: string;
  afterSha256: string;
  before: string;
  after: string;
}

export interface RepairPlan {
  schemaVersion: 1;
  kind: "plumb-repair";
  identity: Record<string, unknown>;
  changes: RepairChange[];
  patch: string;
  diagnostics: Diagnostic[];
}

export type RepairContext = Pick<Context, "root" | "files" | "config" | "configFile"> &
  Partial<
    Pick<
      Context,
      "writableFiles" | "ownedFiles" | "path" | "protectedFiles" | "allFiles" | "inputs"
    >
  >;

export interface RepairOptions {
  checker?: unknown;
  inputs?: LoadedInputs;
  temporaryRoot?: string;
  replaceFile?: (from: string, to: string) => void;
}

const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const text = (bytes: Buffer, path: string): string => {
  if (bytes.includes(0)) {
    throw new Error(`Binary files cannot be repaired: ${path}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`Repairs require valid UTF-8 source: ${path}`);
  }
};

function exactKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`Invalid ${label}`);
  }
}

const modeOf = (path: string): number => lstatSync(path).mode & 0o777;

function writable(ctx: RepairContext, path: unknown): string {
  if (typeof path !== "string" || normalize(path) !== path) {
    throw new Error(`Invalid repair path: ${String(path)}`);
  }
  const allowed = ctx.writableFiles ?? ctx.files;
  if (
    !allowed?.includes(path) ||
    ctx.ownedFiles?.includes(path) ||
    path.endsWith(".surface.json") ||
    isPolicyFile(ctx.config, path, ctx.configFile)
  ) {
    throw new Error(
      `Repair cannot change policy, generated assets, snapshots or unselected files: ${path}`,
    );
  }
  const target = safePath(ctx.root, path);
  if (
    (ctx.path && resolve(ctx.path) === target) ||
    ctx.protectedFiles?.some((entry) => resolve(ctx.root, entry) === target)
  ) {
    throw new Error(`Repair cannot change a loaded enforcement input: ${path}`);
  }
  if (!lstatSync(target).isFile()) {
    throw new Error(`Repair targets must be regular files: ${path}`);
  }
  return target;
}

export async function previewRepairs(
  ctx: RepairContext,
  fix: (
    root: string,
  ) => Promise<{ diagnostics: Diagnostic[]; status?: string; exitCode?: number } | undefined>,
  { checker, inputs, temporaryRoot }: RepairOptions = {},
): Promise<RepairPlan> {
  const overlays = inputs?.entries.map((entry) => entry.path) ?? [];
  const outsideInputs = (path: string): boolean => !overlays.some((root) => isWithin(root, path));
  const selected = (ctx.allFiles ?? ctx.files).filter(outsideInputs);
  const extraFiles = [...(ctx.inputs?.keys() ?? [])].filter(
    (path) => outsideInputs(path) && existsSync(safePath(ctx.root, path, { allowMissing: true })),
  );
  const copied = copyWorkspace(ctx.root, { files: selected, extraFiles, temporaryRoot });
  try {
    const overlay = inputs ? materializeInputs(copied.root, inputs) : null;
    const beforeInventory = inventory(copied.root);
    if (beforeInventory.problems.length) {
      throw new Error("The repair workspace contains unsupported paths");
    }
    const before = new Map(
      beforeInventory.files.map((path) => {
        const target = safePath(copied.root, path);
        return [path, { bytes: readFileSync(target), mode: modeOf(target) }];
      }),
    );
    const result = await fix(copied.root);
    const diagnostics = result?.diagnostics ?? [];
    if (
      diagnostics.some((item) => item.status === "incomplete") ||
      result?.status === "incomplete" ||
      result?.exitCode === 2
    ) {
      throw new Error(
        `Repair preview could not complete: ${diagnostics.map((item) => item.message).join("; ") || "the fixer reported incomplete execution"}`,
      );
    }
    const after = inventory(copied.root);
    if (after.problems.length || canonical(after.files) !== canonical(beforeInventory.files)) {
      throw new Error("Conservative repairs cannot add, remove or replace source paths");
    }
    const changes: RepairChange[] = [];
    for (const path of beforeInventory.files) {
      const target = safePath(copied.root, path),
        original = before.get(path),
        bytes = readFileSync(target);
      if (!original || modeOf(target) !== original.mode) {
        throw new Error(`Conservative repairs cannot change file modes: ${path}`);
      }
      if (bytes.equals(original.bytes)) {
        continue;
      }
      writable(ctx, path);
      if (!outsideInputs(path)) {
        throw new Error(`Repairs cannot modify pinned input overlays: ${path}`);
      }
      const previous = text(original.bytes, path),
        next = text(bytes, path);
      changes.push({
        path,
        mode: original.mode,
        beforeSha256: digest(original.bytes),
        afterSha256: digest(bytes),
        before: previous,
        after: next,
      });
    }
    copied.verify();
    inputs?.verify();
    overlay?.verify?.();
    return {
      schemaVersion: 1,
      kind: "plumb-repair",
      identity: {
        ...copied.identity,
        policy: digest(canonical(ctx.config)),
        ...(checker ? { checker } : {}),
        ...(inputs ? { inputs: inputs.identity } : {}),
      },
      changes,
      patch: repairPatch(changes),
      diagnostics,
    };
  } finally {
    copied.cleanup();
  }
}

export function applyRepairs(
  ctx: RepairContext,
  plan: unknown,
  { checker, inputs, replaceFile = renameSync }: RepairOptions = {},
): { written: string[]; leftovers?: string[] } {
  exactKeys(
    plan,
    ["schemaVersion", "kind", "identity", "changes", "patch", "diagnostics"],
    "repair plan",
  );
  if (
    plan.schemaVersion !== 1 ||
    plan.kind !== "plumb-repair" ||
    !isArray(plan.changes) ||
    typeof plan.patch !== "string"
  ) {
    throw new Error("Expected a version 1 Plumb repair plan");
  }
  const { identity } = plan;
  exactKeys(
    identity,
    ["snapshot", "permissions", "policy", "checker", "inputs"],
    "repair identity",
  );
  if (
    ![identity.snapshot, identity.permissions, identity.policy].every(sha) ||
    identity.policy !== digest(canonical(ctx.config))
  ) {
    throw new Error("Repair policy changed; generate and review a new plan");
  }
  if (identity.checker !== undefined && canonical(identity.checker) !== canonical(checker)) {
    throw new Error("Repair checker changed or is unavailable; generate a new plan");
  }
  if (identity.inputs !== undefined && canonical(identity.inputs) !== canonical(inputs?.identity)) {
    throw new Error("Repair inputs changed or are unavailable; generate a new plan");
  }
  inputs?.verify();
  const { diagnostics } = plan;
  if (
    diagnostics !== undefined &&
    (!isArray(diagnostics) ||
      diagnostics.some((item) => isRecord(item) && item.status === "incomplete"))
  ) {
    throw new Error("An incomplete repair plan cannot be applied");
  }
  const paths = new Set<string>();
  const proposed: RepairChange[] = [];
  const prepared = plan.changes.map((change) => {
    exactKeys(
      change,
      ["path", "mode", "beforeSha256", "afterSha256", "before", "after"],
      "repair change",
    );
    const target = writable(ctx, change.path),
      path = String(change.path);
    if (paths.has(target)) {
      throw new Error(`Duplicate repair path: ${path}`);
    }
    paths.add(target);
    const { mode, beforeSha256, afterSha256 } = change;
    if (
      typeof mode !== "number" ||
      !Number.isInteger(mode) ||
      mode < 0 ||
      mode > 0o777 ||
      !sha(beforeSha256) ||
      !sha(afterSha256) ||
      typeof change.before !== "string" ||
      typeof change.after !== "string"
    ) {
      throw new Error(`Malformed repair content: ${path}`);
    }
    const valid: RepairChange = {
      path,
      mode,
      beforeSha256,
      afterSha256,
      before: change.before,
      after: change.after,
    };
    proposed.push(valid);
    const before = Buffer.from(valid.before),
      after = Buffer.from(valid.after);
    if (
      text(before, path) !== valid.before ||
      text(after, path) !== valid.after ||
      digest(before) !== beforeSha256 ||
      digest(after) !== afterSha256 ||
      before.equals(after)
    ) {
      throw new Error(`Repair content integrity mismatch: ${path}`);
    }
    if (!readFileSync(target).equals(before) || modeOf(target) !== mode) {
      throw new Error(`Stale repair input: ${path}`);
    }
    const token = randomUUID();
    return {
      ...valid,
      target,
      before,
      after,
      staged: join(dirname(target), `.plumb-repair-${token}`),
      backup: join(dirname(target), `.plumb-backup-${token}`),
    };
  });
  if (plan.patch !== repairPatch(proposed)) {
    throw new Error("Repair patch does not match its proposed changes");
  }
  const replaced: typeof prepared = [],
    temporary: string[] = [],
    preserve = new Set<string>();
  // a staged or backup file that cannot be removed is reported, never silently left behind
  const removeTemporary = (): string[] => {
    const leftovers: string[] = [];
    for (const path of temporary) {
      try {
        if (!preserve.has(path)) {
          rmSync(path, { force: true });
        }
      } catch (error) {
        leftovers.push(`${path} (${errorMessage(error)})`);
      }
    }
    return leftovers;
  };
  try {
    for (const item of prepared) {
      const copies: [string, Buffer][] = [
        [item.staged, item.after],
        [item.backup, item.before],
      ];
      for (const [path, bytes] of copies) {
        writeFileSync(path, bytes, { flag: "wx", mode: item.mode });
        temporary.push(path);
        chmodSync(path, item.mode);
      }
    }
    for (const item of prepared) {
      writable(ctx, item.path);
      if (!readFileSync(item.target).equals(item.before) || modeOf(item.target) !== item.mode) {
        throw new Error(`Stale repair input: ${item.path}`);
      }
      replaced.push(item);
      replaceFile(item.staged, item.target);
    }
    const leftovers = removeTemporary();
    return {
      written: prepared.map((item) => item.path),
      ...(leftovers.length ? { leftovers } : {}),
    };
  } catch (error) {
    const failures: string[] = [];
    for (const item of replaced.reverse()) {
      try {
        renameSync(item.backup, item.target);
      } catch (error) {
        preserve.add(item.backup);
        failures.push(`${item.path}: ${errorMessage(error)}; original saved at ${item.backup}`);
      }
    }
    const leftovers = removeTemporary();
    failures.push(...leftovers.map((path) => `temporary file remains: ${path}`));
    if (failures.length) {
      throw new Error(`${errorMessage(error)}; rollback needs review: ${failures.join("; ")}`, {
        cause: error,
      });
    }
    throw asError(error);
  }
}
