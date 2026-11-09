import { existsSync } from "node:fs";
import { posix, resolve } from "node:path";

import type { Config } from "./config.ts";
import type { Context } from "./context.ts";
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
  {
    id: "hooks.manager",
    description: "The configured hook manager runs the policy command, unmodified.",
    remedy: "Add the exact policy invocation to the hook manager's configuration.",
    suppressible: false,
  },
];

// where each hook manager keeps the commands it runs before a commit and on its message
const MANAGER_FILES: Record<string, { check: string[]; message: string[]; install: string }> = {
  husky: { check: ["pre-commit"], message: ["commit-msg"], install: "husky" },
  lefthook: {
    check: ["lefthook.yml", ".lefthook.yml", "lefthook.yaml", ".lefthook.yaml"],
    message: ["lefthook.yml", ".lefthook.yml", "lefthook.yaml", ".lefthook.yaml"],
    install: "lefthook install",
  },
  "pre-commit": {
    check: [".pre-commit-config.yaml"],
    message: [".pre-commit-config.yaml"],
    install: "pre-commit install --hook-type pre-commit --hook-type commit-msg",
  },
};

const managerOf = (config: Pick<Config, "hooks">): string => config.hooks?.manager ?? "git";

export const word = (value: string): string =>
  /^[\w./:=@%+,-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";

// hook scripts are generated from the same argv as the policy command, so every wrapper runs one
// reviewed invocation.
export function hookFiles(
  config: Pick<Config, "hooks" | "commits">,
  header: string,
): GeneratedFile[] {
  // another manager owns its own hook files; checkHookManager verifies what they run
  if (!config.hooks || managerOf(config) !== "git") {
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

// the manager's configuration must hold the policy invocation as a whole line: a commented line,
// an appended "|| true" or an extra flag is not that invocation.
// shortcut: this reads lines, not the manager's schema, so a hook that is skipped or filed under
// another stage is not seen; CI stays the enforcement point.
export function checkHookManager(
  ctx: Pick<Context, "config" | "read" | "configFile">,
): Diagnostic[] {
  const { hooks, commits } = ctx.config,
    files = MANAGER_FILES[managerOf(ctx.config)];
  if (!hooks || !files) {
    return [];
  }
  const command = hooks.command.map(word).join(" "),
    folder = hooks.path ?? ".husky";
  const out: Diagnostic[] = [];
  const invocations: [string[], string, string][] = [[files.check, "check", ""]];
  if (commits) {
    invocations.push([files.message, "commit-msg", String.raw`(?: (?:"\$1"|\$1|\{1\}))?`]);
  }
  for (const [candidates, action, argument] of invocations) {
    const paths = candidates.map((name) =>
        hooks.manager === "husky" ? posix.join(folder, name) : name,
      ),
      path = paths.find((candidate) => ctx.read(candidate, { allowMissing: true }) !== null),
      wanted = `${command} ${action}`;
    if (!path) {
      out.push({
        rule: "hooks.manager",
        path: ctx.configFile,
        message: `${hooks.manager} has no ${paths.join(" or ")} to run ${wanted}.`,
        remedy: `Create it with the line: ${wanted}`,
        status: "incomplete",
        suppressible: false,
      });
      continue;
    }
    const line = new RegExp(
      `^(?:- )?(?:(?:run|entry): )?(["']?)(?:exec )?${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${argument}\\1$`,
    );
    if (!(ctx.read(path) ?? "").split(/\r?\n/).some((candidate) => line.test(candidate.trim()))) {
      out.push({
        rule: "hooks.manager",
        path,
        message: `${path} does not run ${wanted} as a whole line.`,
        remedy: `Add the line: ${wanted}`,
        status: "violation",
        suppressible: false,
      });
    }
  }
  return out;
}

export async function checkHooks(
  config: Pick<Config, "hooks">,
  root: string,
  execute: Execute = run,
): Promise<Diagnostic[]> {
  if (!config.hooks) {
    return [];
  }
  const manager = managerOf(config),
    expected = normalize(config.hooks.path ?? (manager === "husky" ? ".husky" : ".githooks"));
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
  if (manager === "lefthook" || manager === "pre-commit") {
    // these managers install into git's own hooks directory, wherever core.hooksPath puts it
    const installed = await execute(["git", "rev-parse", "--git-path", "hooks/pre-commit"], {
      cwd: root,
      timeout: 10000,
    });
    if (installed.code === 0 && existsSync(resolve(root, installed.stdout.trim()))) {
      return [];
    }
    return [
      {
        rule: "hooks.unset",
        path: ".",
        message: `${manager} has not installed its hooks in this clone.`,
        remedy: `Run ${MANAGER_FILES[manager]?.install ?? manager} in this clone.`,
        status: "violation",
        suppressible: false,
      },
    ];
  }
  // husky 9 points git at its own wrapper directory inside the hooks folder
  if (actual === expected || (manager === "husky" && actual === `${expected}/_`)) {
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
