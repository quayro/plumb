import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage } from "../src/errors.ts";
import { readAdapterSource } from "./adapter-source.ts";

// plumb checks its own Python adapter like a consumer would: the adapter is read from a reviewed git
// revision (PLUMB_ADAPTER_REF, default HEAD), then pinned in a registry outside the repository
const root = fileURLToPath(new URL("..", import.meta.url));
const bin = fileURLToPath(new URL("../bin/plumb.ts", import.meta.url));

const writeAtomically = (path: string, content: Buffer | string): void => {
  const staged = `${path}.${process.pid}`;
  writeFileSync(staged, content);
  renameSync(staged, path);
};

const pinAdapter = (): string => {
  const source = readAdapterSource(root, process.env.PLUMB_ADAPTER_REF ?? "HEAD");
  const folder = join(tmpdir(), "plumb-python", createHash("sha256").update(source).digest("hex"));
  const script = join(folder, "adapter.py");
  const registry = join(folder, "registry.json");

  mkdirSync(folder, { recursive: true });
  writeAtomically(script, source);

  // the manifest pins the current interpreter, so it is regenerated on every run
  const manifest = spawnSync("python3", ["-I", "-S", script, "--manifest"], { encoding: "utf8" });
  if (manifest.status !== 0) {
    throw new Error(`The Python adapter manifest failed: ${manifest.stderr || manifest.stdout}`);
  }
  writeAtomically(registry, manifest.stdout);
  return registry;
};

const main = (): number => {
  let registry: string;
  try {
    registry = pinAdapter();
  } catch (error) {
    // incomplete, not a violation: the self-check cannot run without the reviewed adapter
    process.stderr.write(`plumb: cannot pin the Python adapter: ${errorMessage(error)}\n`);
    return 2;
  }

  const args = process.argv.slice(2);
  const child = spawnSync(
    process.execPath,
    [bin, ...args, ...(args.includes("--adapters") ? [] : ["--adapters", registry])],
    { stdio: "inherit" },
  );
  return child.status ?? 2;
};

process.exitCode = main();
