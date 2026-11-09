import { posix } from "node:path";

import type { Config } from "./config.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { normalize } from "./files.ts";
import { type Execute, run } from "./process.ts";

export interface GeneratedFile {
  path: string;
  content: string;
  executable?: boolean;
}

export const RULES = [
  {
    id: "hooks.unset",
    description: "Git runs the generated hooks from the configured hooks path.",
    remedy: "Run git config core.hooksPath with the configured hooks path.",
    suppressible: false,
  },
  {
    id: "hooks.git",
    description: "Git must be available to inspect the configured hooks path.",
    remedy: "Run plumb doctor inside the Git work tree with git on PATH.",
    suppressible: false,
  },
];

const word = (value: string): string =>
  /^[\w./:=@%+,-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";

// hook scripts are generated from the same argv as the policy command, so every wrapper runs one
// reviewed invocation.
export function hookFiles(
  config: Pick<Config, "hooks" | "commits">,
  header: string,
): GeneratedFile[] {
  if (!config.hooks) {
    return [];
  }
  const folder = config.hooks.path ?? ".githooks",
    command = config.hooks.command.map(word).join(" ");
  const script = (args: string): string =>
    `#!/bin/sh\n${header}\nset -eu\ncd "$(git rev-parse --show-toplevel)"\nexec ${command} ${args}\n`;
  return [
    { path: posix.join(folder, "pre-commit"), content: script("check"), executable: true },
    ...(config.commits
      ? [
          {
            path: posix.join(folder, "commit-msg"),
            content: script('commit-msg "$1"'),
            executable: true,
          },
        ]
      : []),
  ];
}

export async function checkHooks(
  config: Pick<Config, "hooks">,
  root: string,
  execute: Execute = run,
): Promise<Diagnostic[]> {
  if (!config.hooks) {
    return [];
  }
  const expected = normalize(config.hooks.path ?? ".githooks");
  const inside = await execute(["git", "rev-parse", "--show-toplevel"], {
    cwd: root,
    timeout: 10000,
  });
  if (inside.error || inside.code !== 0) {
    return [
      {
        rule: "hooks.git",
        path: ".",
        message: "Cannot inspect core.hooksPath outside a Git work tree.",
        remedy: RULES[1].remedy,
        status: "incomplete",
        suppressible: false,
      },
    ];
  }
  const configured = await execute(["git", "config", "--get", "core.hooksPath"], {
    cwd: root,
    timeout: 10000,
  });
  if (configured.error || (configured.code !== 0 && configured.code !== 1)) {
    return [
      {
        rule: "hooks.git",
        path: ".",
        message: `Cannot read core.hooksPath: ${(configured.error ?? configured.stderr).trim()}`,
        remedy: RULES[1].remedy,
        status: "incomplete",
        suppressible: false,
      },
    ];
  }
  const actual = configured.code === 0 ? normalize(configured.stdout.trim()) : undefined;
  if (actual === expected) {
    return [];
  }
  return [
    {
      rule: "hooks.unset",
      path: ".",
      message: `core.hooksPath is ${actual ?? "unset"}; generated hooks in ${expected} do not run.`,
      remedy: `git config core.hooksPath ${expected}`,
      status: "violation",
      suppressible: false,
    },
  ];
}
