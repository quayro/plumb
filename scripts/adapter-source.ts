import { spawnSync } from "node:child_process";

export const adapterPath = "packages/python/adapter.py";

// the adapter that judges a change must come from a reviewed git revision, never the working tree
export const readAdapterSource = (root: string, ref: string): Buffer => {
  // a leading dash would be read by git as an option instead of a revision
  if (ref === "" || ref.startsWith("-")) {
    throw new Error(`PLUMB_ADAPTER_REF is not a git revision: "${ref}"`);
  }
  const result = spawnSync("git", ["cat-file", "blob", `${ref}:${adapterPath}`], { cwd: root });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `cannot read ${adapterPath} at ${ref}: ${result.stderr.toString().trim() || "unknown git error"}`,
    );
  }
  return result.stdout;
};
