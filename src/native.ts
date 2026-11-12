import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, posix, relative } from "node:path";

import type { Config } from "./config.ts";
import type { Rule } from "./diagnostics.ts";
import { isWithin, normalize, safePath } from "./files.ts";
import type { Step } from "./process.ts";

export const RULES: Rule[] = [
  {
    id: "native.scope",
    description: "Native projects select source files and their package manifest.",
    remedy: "Correct the project scope, or add the manifest and declare every source in it.",
    suppressible: false,
  },
  {
    id: "python.format",
    description: "Python passes the pinned ruff format policy.",
    remedy: "Run plumb fix.",
    suppressible: false,
  },
  {
    id: "python.lint",
    description: "Python passes every ruff rule of the pinned policy.",
    remedy: "Resolve ruff's diagnostics.",
    suppressible: false,
  },
  {
    id: "python.types",
    description: "Python passes mypy in strict mode.",
    remedy: "Resolve mypy's diagnostics.",
    suppressible: false,
  },
  {
    id: "rust.format",
    description: "Rust passes the pinned rustfmt policy.",
    remedy: "Run plumb fix.",
    suppressible: false,
  },
  {
    id: "rust.lint",
    description: "Rust compiles and passes clippy with warnings as errors.",
    remedy: "Resolve the compiler and clippy diagnostics.",
    suppressible: false,
  },
];

const SOURCE: Record<string, RegExp> = { python: /\.pyi?$/, rust: /\.rs$/ };

// the profiles whose toolchains the core runs itself
export const NATIVE = Object.keys(SOURCE);

export const nativeSource = (profile: string, path: string): boolean =>
  SOURCE[profile]?.test(path) ?? false;

// cargo applies a manifest's lints table and a config's rustflags after clippy's own -D warnings, so
// an allow level or a lint cap there turns a finding into a pass; a warn level is still denied.
// the raw text is searched, comments included: a refusal that is too eager is incomplete, one that
// is fooled is a false pass. A character escape (\x, \u, \U) can spell "allow" or a flag, so one in
// a scanned file is incomplete rather than read.
const WRAPPER = /rustc(?:[-_]workspace)?[-_]wrapper|\brustc\s*=/i;
const WORKSPACE = /\[workspace[\].]/;

function lintLevels(root: string, folder: string, files: readonly string[]): void {
  const text = (path: string): string => readFileSync(safePath(root, path), "utf8");
  const scan = (path: string): void => {
    if (/\\[xuU]/.test(text(path))) {
      throw new Error(
        `${path}: a character escape can spell a lint level or flag that this scan cannot read; write the value without escapes`,
      );
    }
    if (WRAPPER.test(text(path))) {
      throw new Error(
        `${path}: a compiler wrapper or rustc override runs in place of rustc and can swallow lints; remove it`,
      );
    }
  };
  for (const manifest of files.filter(
    (path) => isWithin(folder, path) && posix.basename(path) === "Cargo.toml",
  )) {
    scan(manifest);
    if (/\blints\b/.test(text(manifest)) && /["']allow["']/.test(text(manifest))) {
      throw new Error(
        `${manifest}: a lints table that allows a lint switches clippy findings off; remove the allow level`,
      );
    }
  }
  for (let directory = folder; ; directory = posix.dirname(directory)) {
    for (const name of [".cargo/config.toml", ".cargo/config"]) {
      const config = posix.join(directory, name);
      if (!existsSync(join(root, config))) {
        continue;
      }
      scan(config);
      if (/(?<![\w-])(?:-A|--allow|--cap-lints|--force-warn)/.test(text(config))) {
        throw new Error(
          `${config}: rustflags that allow or cap lints, or force-warn them, change clippy's findings; remove them`,
        );
      }
    }
    if (directory === ".") {
      break;
    }
  }
}

// a member's lints, flags and workspace belong to the workspace root, which this scan does not reach
// from the member, so the project must be that root.
function workspaceOf(root: string, folder: string): string | undefined {
  if (folder === ".") {
    return undefined;
  }
  for (let directory = posix.dirname(folder); ; directory = posix.dirname(directory)) {
    const manifest = posix.join(directory, "Cargo.toml");
    if (
      existsSync(join(root, manifest)) &&
      WORKSPACE.test(readFileSync(join(root, manifest), "utf8"))
    ) {
      return manifest;
    }
    if (directory === ".") {
      return undefined;
    }
  }
}

// command arguments are separate values; project data never becomes a shell command.
export function nativeSteps(
  {
    root,
    files,
    config,
    // every selected file, where files may already be narrowed to one project's sources
    inventory = files,
  }: {
    root: string;
    files: readonly string[];
    config: Pick<Config, "projects">;
    inventory?: readonly string[];
  },
  mode = "check",
): Step[] {
  const steps: Step[] = [];
  const fix = mode === "fix";
  const projects = (config.projects ?? []).map((project) => ({
    ...project,
    root: normalize(project.root),
  }));
  for (const project of projects) {
    if (!NATIVE.includes(project.profile)) {
      continue;
    }
    const folder = project.root;
    const cwd = safePath(root, folder);
    const sources = files
      .filter(
        (path) =>
          isWithin(folder, path) &&
          nativeSource(project.profile, path) &&
          !projects.some(
            (other) =>
              other.profile === project.profile &&
              other.root !== folder &&
              isWithin(folder, other.root) &&
              isWithin(other.root, path),
          ),
      )
      .sort();
    if (!sources.length) {
      throw new Error(
        `${folder}: no ${project.profile} source files matched the configured project`,
      );
    }
    const selected = sources.map(
      (path) => `./${relative(cwd, safePath(root, path)).replaceAll("\\", "/")}`,
    );
    const step = (
      name: string,
      tool: string,
      command: string[],
      versionCommand: string[],
      checkedFiles = sources,
    ): Step => ({
      id: `${project.profile}.${name}:${folder}`,
      rule: `${project.profile}.${name}`,
      tool,
      path: folder,
      cwd,
      command,
      versionCommand,
      fix,
      files: checkedFiles,
    });
    if (project.profile === "python") {
      // an explicit config file replaces every pyproject.toml and nested config ruff would discover
      const policy = ["--config", join(cwd, "ruff.toml"), "--no-cache"];
      steps.push(
        step(
          "format",
          "ruff",
          ["ruff", "format", ...(fix ? [] : ["--check"]), ...policy, "--", ...selected],
          ["ruff", "--version"],
        ),
      );
      if (fix) {
        continue;
      }
      steps.push(
        step(
          "lint",
          "ruff",
          [
            "ruff",
            "check",
            "--no-fix",
            "--ignore-noqa",
            "--output-format",
            "concise",
            ...policy,
            "--",
            ...selected,
          ],
          ["ruff", "--version"],
        ),
        step(
          "types",
          "mypy",
          [
            "mypy",
            "--config-file",
            join(cwd, "mypy.ini"),
            "--cache-dir",
            devNull,
            "--no-error-summary",
            "--",
            ...selected,
          ],
          ["mypy", "--version"],
        ),
      );
      continue;
    }
    // shortcut: the project root must be the package or workspace root, because cargo reports
    // paths relative to it; resolve the workspace with cargo metadata when a member is a project.
    if (!existsSync(join(cwd, "Cargo.toml"))) {
      throw new Error(
        `${folder}: Cargo.toml is missing; a rust project is rooted at its package or workspace`,
      );
    }
    // the members of a workspace root are formatted and linted only when asked for
    const workspace = WORKSPACE.test(readFileSync(join(cwd, "Cargo.toml"), "utf8"));
    const member = workspace ? undefined : workspaceOf(root, folder);
    if (member) {
      throw new Error(
        `${folder}: Cargo.toml is a member of the workspace ${member}; configure the workspace root as the project`,
      );
    }
    lintLevels(root, folder, inventory);
    steps.push(
      step(
        "format",
        "rustfmt",
        [
          "cargo",
          "fmt",
          ...(workspace ? ["--all"] : []),
          ...(fix ? [] : ["--check"]),
          "--",
          "--config-path",
          join(cwd, "rustfmt.toml"),
          "--color",
          "never",
          // each formatted file is named, which is the evidence of what was checked
          ...(fix ? [] : ["--verbose"]),
        ],
        ["cargo", "fmt", "--version"],
      ),
    );
    if (fix) {
      continue;
    }
    steps.push(
      step(
        "lint",
        "clippy",
        [
          "cargo",
          "clippy",
          ...(workspace ? ["--workspace"] : []),
          // the lock file and the network stay untouched
          "--frozen",
          "--all-targets",
          "--all-features",
          // build output stays out of the checkout
          "--target-dir",
          join(
            tmpdir(),
            "plumb-cargo",
            createHash("sha256").update(cwd).digest("hex").slice(0, 16),
          ),
          "--message-format=json",
          "--",
          "-D",
          "warnings",
        ],
        ["cargo", "clippy", "--version"],
        [],
      ),
    );
  }
  return steps;
}
