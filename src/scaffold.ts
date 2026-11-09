import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative } from "node:path";

import type { Context } from "./context.ts";
import { scaffoldProposals } from "./conventions.ts";
import type { Report } from "./diagnostics.ts";
import { asError, errorCode, errorMessage } from "./errors.ts";
import { canonical, digest, isWithin, safePath } from "./files.ts";
import {
  inputDigest,
  type LoadedInputs,
  type MaterializedInputs,
  materializeInputs,
} from "./inputs.ts";
import { repairPatch } from "./patch.ts";
import { copyWorkspace } from "./workspace.ts";

interface Proposal {
  path: string;
  content: string;
}

type Create = (path: string, flags: string, mode: number) => number;

export interface ScaffoldCheck {
  root: string;
  policy: string;
  configFile: string;
  inputBundle?: LoadedInputs;
  inputOverlay?: MaterializedInputs;
}

export interface ScaffoldOptions {
  role: string;
  name: unknown;
  dryRun?: boolean;
  inputs?: LoadedInputs;
  checker?: unknown;
  verify?: () => void;
  temporaryRoot?: string;
  create?: Create;
}

export interface ScaffoldResult {
  plan: Record<string, unknown>;
  checked: Report;
  written: string[];
}

const patch = (files: readonly Proposal[]): string =>
  files
    .map(({ path, content }) =>
      repairPatch([{ path, before: "", after: content }]).replace(/^--- .*$/m, "--- /dev/null"),
    )
    .join("");

// creation is guarded by exclusive opens. Rollback removes only files this call still owns.
function createFiles(
  root: string,
  proposals: readonly Proposal[],
  create: Create = openSync,
): string[] {
  const written: {
      path: string;
      target: string;
      device: number;
      inode: number;
      bytes: Buffer;
      complete: boolean;
    }[] = [],
    directories: string[] = [];
  const parents = (target: string): void => {
    const pending: string[] = [];
    let path = dirname(target);
    while (!existsSync(path)) {
      pending.unshift(path);
      path = dirname(path);
    }
    for (const folder of pending) {
      safePath(root, relative(root, folder), { allowMissing: true });
      try {
        mkdirSync(folder);
        directories.push(folder);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw asError(error);
        }
      }
    }
  };
  try {
    for (const item of proposals) {
      const target = safePath(root, item.path, { allowMissing: true });
      parents(target);
      safePath(root, item.path, { allowMissing: true });
      const descriptor = create(target, "wx", 0o644);
      try {
        const stat = fstatSync(descriptor);
        const record = {
          path: item.path,
          target,
          device: stat.dev,
          inode: stat.ino,
          bytes: Buffer.from(item.content),
          complete: false,
        };
        written.push(record);
        writeFileSync(descriptor, item.content, "utf8");
        record.complete = true;
      } finally {
        closeSync(descriptor);
      }
    }
    return written.map((item) => item.path);
  } catch (error) {
    const failures: string[] = [];
    for (const item of written.reverse()) {
      try {
        const stat = lstatSync(item.target);
        if (!stat.isFile() || stat.dev !== item.device || stat.ino !== item.inode) {
          failures.push(`${item.path}: the created path was replaced concurrently`);
          continue;
        }
        const current = readFileSync(item.target);
        if (
          item.complete
            ? !current.equals(item.bytes)
            : !item.bytes.subarray(0, current.length).equals(current)
        ) {
          failures.push(`${item.path}: the created content changed concurrently`);
          continue;
        }
        unlinkSync(item.target);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          failures.push(`${item.path}: ${errorMessage(error)}`);
        }
      }
    }
    for (const directory of directories.reverse()) {
      try {
        rmdirSync(directory);
      } catch (error) {
        // a folder something else filled meanwhile stays, and the rollback says so
        if (errorCode(error) !== "ENOENT") {
          failures.push(`${directory}: ${errorMessage(error)}`);
        }
      }
    }
    if (failures.length) {
      throw new Error(
        `${errorMessage(error)}; scaffold rollback needs review: ${failures.join("; ")}`,
        { cause: error },
      );
    }
    throw asError(error);
  }
}

export async function scaffold(
  ctx: Pick<Context, "root" | "files" | "config" | "path" | "configFile"> &
    Partial<Pick<Context, "allFiles" | "inputs" | "policyInputs">>,
  execute: (options: ScaffoldCheck) => Promise<Report>,
  { role, name, dryRun = false, inputs, checker, verify, temporaryRoot, create }: ScaffoldOptions,
): Promise<ScaffoldResult> {
  const proposals = scaffoldProposals(ctx, { role, name });
  const overlays = inputs?.entries.map((entry) => entry.path) ?? [];
  const outside = (path: string): boolean => !overlays.some((entry) => isWithin(entry, path));
  if (proposals.some((item) => !outside(item.path))) {
    throw new Error("Scaffolds cannot create files inside approved input overlays");
  }
  const extraFiles = [...(ctx.inputs?.keys() ?? [])].filter(
    (path) => outside(path) && existsSync(safePath(ctx.root, path, { allowMissing: true })),
  );
  const copied = copyWorkspace(ctx.root, {
    files: (ctx.allFiles ?? ctx.files).filter(outside),
    extraFiles,
    temporaryRoot,
  });
  const stable = (): void => {
    copied.verify();
    inputs?.verify();
    for (const input of ctx.policyInputs ?? []) {
      if (digest(readFileSync(input.path)) !== input.sha256) {
        throw new Error(`Scaffold policy input changed: ${input.path}`);
      }
    }
    if (canonical(scaffoldProposals(ctx, { role, name })) !== canonical(proposals)) {
      throw new Error("Scaffold targets changed during validation");
    }
    verify?.();
  };
  try {
    const overlay = inputs ? materializeInputs(copied.root, inputs) : undefined;
    createFiles(copied.root, proposals);
    const before = inputDigest(copied.root);
    const checked = await execute({
      root: copied.root,
      policy: ctx.path,
      configFile: ctx.configFile,
      inputBundle: inputs,
      inputOverlay: overlay,
    });
    if (inputDigest(copied.root) !== before) {
      throw new Error("The scaffold checker changed its proposed source or inputs");
    }
    overlay?.verify();
    stable();
    if (
      !checked ||
      !Array.isArray(checked.diagnostics) ||
      !Array.isArray(checked.checks) ||
      !["pass", "violation", "incomplete"].includes(checked.status) ||
      checked.exitCode !== (checked.status === "pass" ? 0 : checked.status === "violation" ? 1 : 2)
    ) {
      throw new Error("Scaffold validation did not return a consistent checker report");
    }
    const valid =
      checked.status === "pass" &&
      checked.diagnostics.length === 0 &&
      checked.checks.length > 0 &&
      checked.checks.every((entry) => ["pass", "not-applicable"].includes(entry.status));
    if (
      (checked.status === "pass" && !valid) ||
      (checked.status !== "pass" && !checked.diagnostics.length)
    ) {
      throw new Error("Scaffold validation status contradicts its check evidence");
    }
    const plan = {
      schemaVersion: 1,
      kind: "plumb-scaffold",
      role,
      name,
      identity: {
        ...copied.identity,
        policy: digest(canonical(ctx.config)),
        ...(checker ? { checker } : {}),
        ...(inputs ? { inputs: inputs.identity } : {}),
      },
      files: proposals.map((item) => ({ ...item, sha256: digest(item.content) })),
      patch: patch(proposals),
      validation: {
        status: checked.status,
        diagnostics: checked.diagnostics,
        identity: checked.identity,
      },
    };
    if (dryRun || !valid) {
      return { plan, checked, written: [] };
    }
    stable();
    const written = createFiles(ctx.root, proposals, create);
    return { plan, checked, written };
  } finally {
    copied.cleanup();
  }
}
