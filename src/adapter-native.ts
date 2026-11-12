import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

import { issue, projectFiles, statusOf } from "./adapter-plan.ts";
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

// ruff, mypy, rustfmt and clippy runs, with their launchers pinned for the run

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

// cargo fmt formats what the package's module tree reaches, so a selected file it never names was
// not checked: an orphan module is incomplete coverage, not a pass.
function rustfmt(ctx: NativeContext, step: Step, result: RunResult): string[] {
  return [...result.stdout.matchAll(/^Formatting (.+)$/gm)].map(([, path = ""]) =>
    normalize(relative(ctx.root, resolve(step.cwd ?? ctx.root, path)).replaceAll("\\", "/")),
  );
}

// clippy exits 101 for a denied lint and for a build it could not start alike; the JSON messages
// tell them apart.
function clippy(ctx: NativeContext, step: Step, result: RunResult): Diagnostic[] {
  const messages = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line): unknown => JSON.parse(line));
  const finished = messages.find((message) => at(message, "reason") === "build-finished"),
    diagnostics = new Map<string, Diagnostic>();
  if (!finished) {
    throw new Error(`cargo clippy did not finish the build:\n${result.stderr.trim()}`);
  }
  for (const message of messages) {
    const spans = at(message, "message", "spans"),
      span = isArray(spans) ? spans.find((item) => at(item, "is_primary") === true) : undefined,
      text = at(message, "message", "message"),
      code = at(message, "message", "code", "code");
    if (
      at(message, "reason") !== "compiler-message" ||
      at(message, "message", "level") !== "error" ||
      !span ||
      typeof text !== "string"
    ) {
      continue;
    }
    const path = relativeOutput(ctx, step.cwd, at(span, "file_name")),
      line = position(at(span, "line_start")),
      column = position(at(span, "column_start"));
    // a file compiled into several targets reports each finding once per target
    diagnostics.set(`${path}:${line}:${column}:${text}`, {
      rule: "rust.lint",
      path,
      message: typeof code === "string" ? `${code}: ${text}` : text,
      remedy: "Resolve the Rust compiler or clippy diagnostic.",
      suppressible: false,
      check: step.id,
      ...(line ? { line } : {}),
      ...(column ? { column } : {}),
    });
  }
  if (
    (at(finished, "success") === true) !== (result.code === 0) ||
    (result.code !== 0) !== diagnostics.size > 0
  ) {
    throw new Error(
      `cargo clippy's exit status and diagnostics disagree:\n${result.stderr.trim()}`,
    );
  }
  return [...diagnostics.values()];
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
      inventory: ctx.files,
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
      let pinned: { command: string; path: string; sha256: string } | undefined;
      const versionCommand = step.versionCommand ?? [];
      if (execute === run) {
        const identity = launcher(step.command[0] ?? "", ctx.root);
        identities.push({ check: id, ...identity });
        pinned = identity;
        // run the name found on PATH, not its target: rustup's cargo is a link that acts by its name
        step.command[0] = identity.command;
        versionCommand[0] = identity.command;
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
        if (actual && !actual.error && actual.code !== null && step.rule === "rust.lint") {
          const found = clippy(ctx, step, actual);
          diagnostics.push(...found);
          coverage.push({ id, checkedFiles: [], status: statusOf(found) });
        } else {
          const selected = step.files ?? [],
            reached =
              actual && finished && step.rule === "rust.format"
                ? rustfmt(ctx, step, actual)
                : selected,
            missing = finished ? selected.filter((file) => !reached.includes(file)) : [];
          diagnostics.push(...result.diagnostics.map((item) => ({ ...item, check: id })));
          if (missing.length) {
            diagnostics.push(
              issue(
                "native.scope",
                project.root,
                `rustfmt did not reach ${missing.join(", ")}; declare each file as a module of a package target or exclude it with a reason`,
                id,
              ),
            );
          }
          coverage.push({
            id,
            checkedFiles: finished ? selected.filter((file) => reached.includes(file)) : [],
            status: missing.length ? "incomplete" : (result.checks[0]?.status ?? "incomplete"),
          });
        }
      }
      if (
        pinned &&
        (realpathSync(pinned.command) !== pinned.path || fileHash(pinned.path) !== pinned.sha256)
      ) {
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
