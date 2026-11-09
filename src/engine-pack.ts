import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { JavascriptPack } from "./adapters.ts";
import { compare, packageRoot } from "./engine-plan.ts";
import { errorMessage } from "./errors.ts";
import { canonical, digest } from "./files.ts";
import { at, isRecord } from "./schema.ts";

// the pack module is ours, loaded from the vendored folder; it exports the adapter's functions
const isPack = (value: unknown): value is Omit<JavascriptPack, "identity"> =>
  isRecord(value) &&
  ["rules", "check", "fix", "snapshot", "surfaceSnapshotIsValid"].every(
    (name) => typeof value[name] === "function",
  );

export async function javascriptPack(): Promise<JavascriptPack> {
  const require = createRequire(import.meta.url);
  let url: string;
  try {
    url = pathToFileURL(require.resolve("@quayro/plumb-javascript")).href;
  } catch {
    const local = join(packageRoot, "packages/javascript/index.ts");
    if (existsSync(local)) {
      url = pathToFileURL(local).href;
    } else {
      try {
        url = pathToFileURL(
          createRequire(join(dirname(process.execPath), "plumb-runtime.cjs")).resolve(
            "@quayro/plumb-javascript",
          ),
        ).href;
      } catch {
        throw new Error(`Install @quayro/plumb-javascript beside the Plumb checker.`);
      }
    }
  }
  try {
    const root = dirname(fileURLToPath(url)),
      manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (at(manifest, "name") !== "@quayro/plumb-javascript") {
      throw new Error("The JavaScript pack must be @quayro/plumb-javascript");
    }
    const identity = { sha256: sourceHash(root) };
    const pack: unknown = await import(url);
    if (!isPack(pack)) {
      throw new Error("The JavaScript pack does not export the adapter contract");
    }
    return { ...pack, identity };
  } catch (error) {
    throw new Error(
      `JavaScript pack could not load: ${errorMessage(error)}. Install its pinned dependencies.`,
      { cause: error },
    );
  }
}

function sourceHash(base: string, folders = ["."]): string {
  const entries: [string, string][] = [];
  const walk = (root: string): void => {
    if (!existsSync(root)) {
      return;
    }
    for (const file of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (["node_modules", "test"].includes(file.name)) {
        continue;
      }
      const path = join(root, file.name);
      if (file.isDirectory()) {
        walk(path);
      } else if (/\.(?:mjs|ts|json|yml)$/.test(file.name) && !file.name.includes(".test.")) {
        entries.push([relative(base, path).replaceAll("\\", "/"), digest(readFileSync(path))]);
      }
    }
  };
  for (const folder of folders) {
    walk(join(base, folder));
  }
  if (!folders.includes(".")) {
    entries.push(["package.json", digest(readFileSync(join(base, "package.json")))]);
  }
  return digest(canonical(entries.sort(([a], [b]) => compare(a, b))));
}

declare global {
  var PLUMB_BUILD_ID: string | undefined;
}

export function checkerIdentity(javascript?: unknown): { sha256: string; javascript?: unknown } {
  return {
    sha256: globalThis.PLUMB_BUILD_ID ?? sourceHash(packageRoot, ["bin", "src"]),
    ...(javascript ? { javascript } : {}),
  };
}
