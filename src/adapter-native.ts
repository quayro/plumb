import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

import { issue, projectFiles, same, statusOf } from "./adapter-plan.ts";
import { externalFile, fileHash } from "./adapter-registry.ts";
import type { Project } from "./config.ts";
import type { Context } from "./context.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { errorMessage } from "./errors.ts";
import { normalize } from "./files.ts";
import { nativeSteps } from "./native.ts";
import {
  type Execute,
  executeSteps,
  run,
  type RunResult,
  type Step,
  versionOf,
} from "./process.ts";
import { at, isArray } from "./schema.ts";

// RuboCop, clang-format and clang-tidy runs, with their launchers pinned for the run

export interface CoverageRecord {
  id: string;
  checkedFiles: string[];
  status: string;
  evidence?: string;
}

export interface ToolIdentity {
  check: string;
  command?: string;
  path?: string;
  sha256?: string;
  kind?: string;
  source?: string;
}

export interface AdapterRun {
  diagnostics: Diagnostic[];
  coverage: CoverageRecord[];
  versions: Record<string, string>;
  identities: ToolIdentity[];
}

type NativeContext = Pick<Context, "root" | "files" | "config" | "safePath">;

function relativeOutput(ctx: NativeContext, cwd: string | undefined, path: unknown): string {
  if (typeof path !== "string" || !path) {
    throw new Error("Tool diagnostics need a source path");
  }
  const clean = normalize(relative(ctx.root, resolve(cwd ?? ctx.root, path)).replaceAll("\\", "/"));
  ctx.safePath(clean);
  return clean;
}

const position = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

function rubocop(
  ctx: NativeContext,
  step: Step,
  result: RunResult,
): { diagnostics: Diagnostic[]; coverage: CoverageRecord } {
  const payload: unknown = JSON.parse(result.stdout),
    files = at(payload, "files"),
    errors = at(payload, "errors"),
    diagnostics: Diagnostic[] = [],
    checkedFiles: string[] = [],
    expected = step.files ?? [];
  if (
    !isArray(files) ||
    at(payload, "summary", "inspected_file_count") !== files.length ||
    (Array.isArray(errors) && errors.length > 0)
  ) {
    throw new Error("RuboCop did not report a complete file inspection");
  }
  for (const file of files) {
    const path = relativeOutput(ctx, step.cwd, at(file, "path")),
      offenses = at(file, "offenses");
    checkedFiles.push(path);
    if (!expected.includes(path) || !isArray(offenses)) {
      throw new Error("RuboCop reported unexpected files or malformed offenses");
    }
    for (const offense of offenses) {
      const message = at(offense, "message"),
        cop = at(offense, "cop_name");
      if (typeof message !== "string" || typeof cop !== "string") {
        throw new Error("RuboCop returned a malformed offense");
      }
      const line = position(
          at(offense, "location", "start_line") ?? at(offense, "location", "line"),
        ),
        column = position(
          at(offense, "location", "start_column") ?? at(offense, "location", "column"),
        );
      diagnostics.push({
        rule: "ruby.lint",
        path,
        message: `${cop}: ${message}`,
        remedy: "Resolve the Ruby source diagnostic.",
        suppressible: false,
        check: step.id,
        ...(line ? { line } : {}),
        ...(column ? { column } : {}),
      });
    }
  }
  if (
    !same(checkedFiles, expected) ||
    new Set(checkedFiles).size !== checkedFiles.length ||
    (result.code === 1 && !diagnostics.length)
  ) {
    throw new Error("RuboCop's reported coverage or exit status is incomplete");
  }
  return {
    diagnostics,
    coverage: { id: step.id ?? "", checkedFiles, status: statusOf(diagnostics) },
  };
}

function launcher(
  command: string,
  root: string,
): { command: string; path: string; sha256: string; kind: string } {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .flatMap((folder) =>
          process.platform === "win32" && !/\.[a-z]+$/i.test(command)
            ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
                .split(";")
                .map((extension) => join(folder, command + extension))
            : [join(folder, command)],
        );
  for (const path of candidates) {
    try {
      accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      const actual = externalFile(resolve(path), realpathSync(root));
      return { command: resolve(path), path: actual, sha256: fileHash(actual), kind: "launcher" };
    } catch (error) {
      // an unusable candidate is skipped; only a launcher inside the checkout is refused outright
      if (/outside the candidate/.test(errorMessage(error))) {
        throw error instanceof Error ? error : new Error(errorMessage(error));
      }
    }
  }
  throw new Error(`Cannot locate executable ${command}`);
}

export async function nativeRun(
  ctx: NativeContext,
  project: Project,
  execute: Execute,
  doctor: boolean,
): Promise<AdapterRun> {
  const diagnostics: Diagnostic[] = [],
    coverage: CoverageRecord[] = [],
    versions: Record<string, string> = {},
    identities: ToolIdentity[] = [];
  let steps: Step[];
  try {
    steps = nativeSteps({
      ...ctx,
      files: projectFiles(ctx, project),
      config: { ...ctx.config, projects: [project] },
    });
  } catch (error) {
    return {
      diagnostics: [issue("native.scope", project.root, errorMessage(error))],
      coverage,
      versions,
      identities,
    };
  }
  for (const step of steps) {
    const id = step.id ?? "";
    try {
      let pinned: { path: string; sha256: string } | undefined;
      const versionCommand = step.versionCommand ?? [];
      if (execute === run) {
        const identity = launcher(step.command[0] ?? "", ctx.root);
        identities.push({ check: id, ...identity });
        pinned = identity;
        step.command[0] = identity.path;
        versionCommand[0] = identity.path;
      } else {
        identities.push({ check: id, source: "injected" });
      }
      if (doctor) {
        const probe = await execute(versionCommand, {
          cwd: step.cwd,
          timeout: ctx.config.tools?.timeout ?? 120000,
        });
        if (probe.error || probe.code !== 0) {
          throw new Error(probe.error ?? probe.stderr);
        }
        const version = `${probe.stdout}\n${probe.stderr}`.trim(),
          actual = versionOf(version),
          tool = step.tool ?? "",
          required = ctx.config.tools?.versions?.[tool];
        if (required && required !== actual) {
          throw new Error(`${tool} is ${actual}; the policy requires ${required}`);
        }
        versions[tool] ??= version;
        versions[`${tool}@${step.path ?? "."}`] = version;
        coverage.push({
          id,
          checkedFiles: [],
          status: "ready",
          evidence: "prerequisites-only",
        });
      } else {
        let actual: RunResult | undefined;
        const result = await executeSteps(ctx, [step], async (command, options) => {
          const output = await execute(command, options);
          if (command === step.command) {
            actual = output;
          }
          return output;
        });
        Object.assign(versions, result.versions);
        const finished = !!actual && !actual.error && (actual.code === 0 || actual.code === 1);
        if (actual && finished && project.profile === "ruby") {
          const parsed = rubocop(ctx, step, actual);
          diagnostics.push(...parsed.diagnostics);
          coverage.push(parsed.coverage);
        } else {
          diagnostics.push(...result.diagnostics.map((item) => ({ ...item, check: id })));
          coverage.push({
            id,
            checkedFiles: finished ? (step.files ?? []) : [],
            status: result.checks[0]?.status ?? "incomplete",
          });
        }
      }
      if (pinned && fileHash(pinned.path) !== pinned.sha256) {
        throw new Error(`Tool launcher changed while checking: ${pinned.path}`);
      }
    } catch (error) {
      const row = coverage.find((item) => item.id === id);
      if (row) {
        row.status = "incomplete";
      }
      diagnostics.push(
        issue(
          doctor ? "tools.missing" : "adapters.protocol",
          project.root,
          errorMessage(error),
          id,
        ),
      );
    }
  }
  return { diagnostics, coverage, versions, identities };
}
