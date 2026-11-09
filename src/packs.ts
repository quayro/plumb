import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { asset } from "./assets.ts";
import { schema } from "./config.ts";
import { digest, normalize } from "./files.ts";
import { array, at, isArray, isRecord, object, validateSchema } from "./schema.ts";

export interface Pack {
  name: string;
  description: string;
  suits: string[];
  path: string;
  sha256: string;
  content: string;
}

const text = { type: "string", minLength: 1 } as const;

const registrySchema = object(
  {
    schemaVersion: { const: 1 },
    packs: array(
      object(
        {
          name: { ...text, pattern: "^[a-z][a-z0-9-]*$" },
          description: text,
          suits: array(text),
          path: text,
          sha256: { ...text, pattern: "^[a-f0-9]{64}$" },
        },
        ["name", "description", "suits", "path", "sha256"],
      ),
    ),
  },
  ["schemaVersion", "packs"],
);

// where init copies a chosen pack, whichever registry it came from
const installed = (name: string): string => `.plumb/packs/${name}.json`;

// the policy packs of a registry, each pinned by the hash of its exact bytes. Without a registry
// file these are the packs shipped with the checker. A registry is an index beside the packs it
// lists: a pack is used only when its bytes match the index and it is itself a valid policy.
export function listPacks(registry?: string): Pack[] {
  if (!registry) {
    const index: unknown = JSON.parse(asset("packs.json"));
    return (isArray(index) ? index : []).map((entry) => {
      const name = String(at(entry, "name")),
        content = asset(`pack-${name}.json`),
        suits = at(entry, "suits");
      return {
        name,
        description: String(at(entry, "description")),
        suits: isArray(suits) ? suits.map(String) : [],
        path: installed(name),
        sha256: digest(content),
        content,
      };
    });
  }
  const file = resolve(registry),
    index: unknown = JSON.parse(readFileSync(file, "utf8")),
    names = new Set<string>();
  validateSchema(index, registrySchema, "registry");
  return index.packs.map((entry) => {
    if (names.has(entry.name)) {
      throw new Error(`Duplicate pack ${entry.name} in the registry`);
    }
    names.add(entry.name);
    if (isAbsolute(entry.path) || normalize(entry.path).split("/").includes("..")) {
      throw new Error(`Pack ${entry.name} must sit beside its registry index`);
    }
    const content = readFileSync(join(dirname(file), entry.path), "utf8");
    if (digest(content) !== entry.sha256) {
      throw new Error(`Pack ${entry.name} does not match the hash in its registry`);
    }
    const policy: unknown = JSON.parse(content);
    validateSchema(policy, schema, `pack ${entry.name}`);
    // a copied pack keeps no path to anything it imported
    if (isRecord(policy) && "bundles" in policy) {
      throw new Error(`Pack ${entry.name} cannot import other bundles`);
    }
    return {
      name: entry.name,
      description: entry.description,
      suits: entry.suits,
      path: installed(entry.name),
      sha256: entry.sha256,
      content,
    };
  });
}

// writes a registry directory that a repository or an organization can host and others pass as
// --index; nothing existing is overwritten
export function exportPacks(packs: readonly Pack[], directory: string): string[] {
  mkdirSync(directory, { recursive: true });
  const written: string[] = [];
  const create = (name: string, content: string): void => {
    writeFileSync(join(directory, name), content, { flag: "wx" });
    written.push(join(directory, name));
  };
  for (const pack of packs) {
    create(`${pack.name}.json`, pack.content);
  }
  const index = {
    schemaVersion: 1,
    packs: packs.map(({ name, description, suits, sha256 }) => ({
      name,
      description,
      suits,
      path: `${name}.json`,
      sha256,
    })),
  };
  create("index.json", `${JSON.stringify(index, null, 2)}\n`);
  return written;
}
