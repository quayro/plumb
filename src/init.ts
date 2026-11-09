import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CliOptions } from "./cli-arguments.ts";
import type { Report } from "./diagnostics.ts";
import { report } from "./engine-plan.ts";
import { inventory, safePath } from "./files.ts";
import { listPacks } from "./packs.ts";
import { run } from "./process.ts";

const PROFILES: [string, RegExp][] = [
  ["typescript", /\.[cm]?[jt]sx?$/],
  ["ruby", /\.(?:rb|rake|gemspec)$|(?:^|\/)(?:Gemfile|Rakefile)$/],
  ["cpp", /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/],
  ["python", /\.py$/],
  ["go", /\.go$/],
  ["rust", /\.rs$/],
];

// profiles the core checks itself; the others need an approved adapter before they can be checked
const BUILT_IN = ["typescript", "react", "ruby", "cpp"];

const TYPES = ["application", "library", "documentation"];

const HOOK_MANAGERS: [string, RegExp][] = [
  ["husky", /^\.husky\//],
  ["lefthook", /^\.?lefthook\.ya?ml$/],
  ["pre-commit", /^\.pre-commit-config\.yaml$/],
];

export const detectProfiles = (files: readonly string[]): string[] =>
  PROFILES.filter(([, pattern]) => files.some((file) => pattern.test(file))).map(
    ([profile]) => profile,
  );

const CONVENTIONAL = /^[a-z]+(?:\([a-z0-9-]+\))?!?: \S/;

// shortcut: history is conventional when four of five recent subjects are, over at least five
// commits; tune the sample when a repository with mixed history is misread.
async function conventionalHistory(root: string): Promise<boolean> {
  const log = await run(["git", "-C", root, "log", "-n", "50", "--format=%s"], { timeout: 10000 });
  const subjects = log.code === 0 && !log.error ? log.stdout.split("\n").filter(Boolean) : [];
  return (
    subjects.length >= 5 &&
    subjects.filter((subject) => CONVENTIONAL.test(subject)).length >= subjects.length * 0.8
  );
}

const listed = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item !== "none");

type Ask = (question: string, fallback: string) => Promise<string>;

// writes a starter policy from what the repository already is: its languages, its commit history
// and the packs chosen for it. An existing policy is never overwritten.
export async function init(options: CliOptions, ask?: Ask): Promise<Report> {
  const root = options.root,
    configFile = options.configFile ?? "plumb.json";
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  const path = safePath(root, configFile, { allowMissing: true });
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite ${path}`);
  }
  const files = inventory(root).files,
    jsx = files.some((file) => /\.[jt]sx$/.test(file)),
    found = detectProfiles(files).map((profile) =>
      profile === "typescript" && jsx ? "react" : profile,
    ),
    packs = listPacks(options.index);
  const detected = {
    profiles: found.filter((profile) => BUILT_IN.includes(profile)),
    external: found.filter((profile) => !BUILT_IN.includes(profile)),
    conventionalCommits: await conventionalHistory(root),
    hookManager: HOOK_MANAGERS.find(([, pattern]) => files.some((file) => pattern.test(file)))?.[0],
  };
  const suggestedPacks = packs
    .filter(
      (pack) =>
        ["hygiene", "secrets"].includes(pack.name) ||
        (pack.name === "conventional-commits" && detected.conventionalCommits),
    )
    .map((pack) => pack.name);
  let preset = options.preset ?? "ozmikhail",
    profiles = options.profile ? listed(options.profile) : detected.profiles,
    chosen = [
      ...listed(options.pack),
      ...packs.filter((pack) => pack.suits.includes(options.type ?? "")).map((pack) => pack.name),
    ];
  if (options.type && !TYPES.includes(options.type)) {
    throw new Error(`Unknown repository type ${options.type}; use ${TYPES.join(", ")}`);
  }
  if (ask) {
    preset = await ask(
      "Preset (ozmikhail is strict, portable checks only what is declared)",
      preset,
    );
    profiles = listed(
      await ask("Language profiles, comma-separated", profiles.join(",") || "none"),
    );
    chosen = listed(
      await ask(
        `Policy packs (${packs.map((pack) => pack.name).join(", ")})`,
        (chosen.length ? chosen : suggestedPacks).join(",") || "none",
      ),
    );
  }
  profiles = profiles.filter((profile) => profile !== "generic");
  const unknown = profiles.find((profile) => !BUILT_IN.includes(profile));
  if (unknown) {
    throw new Error(`Unknown profile ${unknown}`);
  }
  if (!["ozmikhail", "portable"].includes(preset)) {
    throw new Error(`Unknown preset ${preset}`);
  }
  const selected = [...new Set(chosen)].map((name) => {
    const pack = packs.find((entry) => entry.name === name);
    if (!pack) {
      throw new Error(`Unknown pack ${name}; run plumb packs`);
    }
    return pack;
  });
  const config = {
    schemaVersion: 1,
    preset,
    ...(selected.length
      ? { bundles: selected.map(({ path: bundle, sha256 }) => ({ path: bundle, sha256 })) }
      : {}),
    projects: profiles.map((profile) => ({
      root: ".",
      profile,
      ...(profile === "cpp" ? { compileCommands: "build" } : {}),
    })),
  };
  const written: string[] = [];
  const create = (file: string, content: string): void => {
    const target = safePath(root, file, { allowMissing: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: "wx" });
    written.push(file);
  };
  for (const pack of selected) {
    create(pack.path, pack.content);
  }
  create(configFile, `${JSON.stringify(config, null, 2)}\n`);
  if (preset === "ozmikhail" && !existsSync(join(root, "AGENTS.md"))) {
    create(
      "AGENTS.md",
      "# Agent instructions\n\nRun `plumb inspect` to read the effective policy and `plumb check --format json` for diagnostics.\nResolve violations in source. Changes to policy, exceptions or API snapshots require review.\nUse `plumb fix` for source formatting and `plumb sync` for owned assets.\n",
    );
  }
  return report([], {
    command: "init",
    written,
    detected,
    suggestedPacks: suggestedPacks.filter((name) => !chosen.includes(name)),
    next: "Run plumb sync, then plumb check --observe. Language profiles need their documented toolchains.",
  });
}
