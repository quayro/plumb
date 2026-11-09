import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { asError } from "./errors.ts";
import { canonical, digest, inventory, safePath, snapshot } from "./files.ts";
import { compare, inside, name } from "./inputs.ts";

export interface Workspace {
  root: string;
  files: string[];
  identity: { snapshot: string; permissions: string };
  verify: () => boolean;
  cleanup: () => void;
}

function temporary(
  root: string,
  preferred: string | undefined,
): { root: string; container: string; cleanup: () => void } {
  const parent = resolve(preferred ?? process.env.PLUMB_TEST_TMP ?? tmpdir());
  if (inside(root, parent)) {
    throw new Error("Temporary workspaces must be outside the candidate root");
  }
  mkdirSync(parent, { recursive: true });
  const actual = realpathSync(parent);
  if (inside(root, actual)) {
    throw new Error("Temporary workspaces must be outside the candidate root");
  }
  const container = mkdtempSync(join(actual, "plumb-workspace-"));
  const target = join(container, "project");
  mkdirSync(target);
  return {
    root: target,
    container,
    cleanup: () => rmSync(container, { recursive: true, force: true }),
  };
}

export function copyWorkspace(
  candidateRoot: string,
  {
    files,
    extraFiles = [],
    temporaryRoot,
  }: { files?: readonly string[]; extraFiles?: readonly string[]; temporaryRoot?: string } = {},
): Workspace {
  const found = inventory(candidateRoot);
  if (found.problems.length) {
    throw new Error(found.problems.map((item) => item.message).join("; "));
  }
  const selected = [
    ...new Set([...(files ?? found.files), ...extraFiles].map((path) => name(path))),
  ].sort(compare);
  const modes = (): [string, number][] =>
    selected.map((path) => [path, lstatSync(safePath(found.root, path)).mode & 0o777]);
  const identity = {
    snapshot: snapshot(found.root, selected),
    permissions: digest(canonical(modes())),
  };
  const workspace = temporary(found.root, temporaryRoot);
  const verify = (): boolean => {
    const after = inventory(found.root);
    if (
      after.problems.length ||
      canonical(after.files) !== canonical(found.files) ||
      snapshot(found.root, selected) !== identity.snapshot ||
      digest(canonical(modes())) !== identity.permissions
    ) {
      throw new Error("Workspace inputs changed while preparing an isolated copy");
    }
    return true;
  };
  try {
    for (const path of selected) {
      const source = safePath(found.root, path),
        target = safePath(workspace.root, path, { allowMissing: true });
      if (!lstatSync(source).isFile()) {
        throw new Error(`Only regular files can be copied: ${path}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      chmodSync(target, lstatSync(source).mode & 0o777);
    }
    verify();
    if (snapshot(workspace.root, selected) !== identity.snapshot) {
      throw new Error("Isolated workspace does not match the selected source inputs");
    }
    return { root: workspace.root, files: selected, identity, verify, cleanup: workspace.cleanup };
  } catch (error) {
    workspace.cleanup();
    throw asError(error);
  }
}
