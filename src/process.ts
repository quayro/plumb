import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import type { Config } from "./config.ts";
import type { Diagnostic, Status } from "./diagnostics.ts";

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  input?: string;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  maxOutput?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type Execute = (command: readonly string[], options?: RunOptions) => Promise<RunResult>;

export interface Step {
  id?: string;
  name?: string;
  command: string[];
  versionCommand?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  tool?: string;
  path?: string;
  input?: string;
  stdoutMatches?: string;
  rule?: string;
  files?: string[];
  fix?: boolean;
}

export interface CheckStatus {
  id: string;
  status: Status;
}

export function run(
  command: readonly string[],
  {
    cwd,
    timeout = 120000,
    env = {},
    inheritEnv = true,
    input,
    onOutput,
    maxOutput = 4 * 1024 * 1024,
  }: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "",
      stderr = "",
      size = 0,
      problem: string | undefined,
      finished = false;
    const child = spawn(command[0] ?? "", command.slice(1), {
      cwd,
      env: { ...(inheritEnv ? process.env : {}), NO_COLOR: "1", FORCE_COLOR: "0", ...env },
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => stop(`Timed out after ${timeout}ms`), timeout);
    const finish = (code: number | null): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ...(problem ? { error: problem } : {}) });
    };
    const stop = (message: string): void => {
      problem = message;
      if (child.pid) {
        if (process.platform === "win32") {
          spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          })
            .on("error", () => child.kill())
            .unref();
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish(null);
    };
    const streams: ["stdout" | "stderr", Readable | null][] = [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ];
    for (const [name, stream] of streams) {
      stream?.setEncoding("utf8").on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > maxOutput) {
          stop(`Output exceeded ${maxOutput} bytes`);
          return;
        }
        const text = chunk;
        if (name === "stdout") {
          stdout += text;
        } else {
          stderr += text;
        }
        onOutput?.(name, text);
      });
    }
    child.on("error", (error) => {
      problem = error.message;
      finish(null);
    });
    if (input !== undefined) {
      // a tool that exits before reading its input closes the pipe; its exit status reports the failure
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
    child.on("close", (code) => finish(code));
  });
}

// "3.10.0", "v3.10.0" or "clang-format version 18.1.8" all name the same kind of release
export const versionOf = (text: string): string =>
  text.match(/(?<![\w.])v?(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)\b/i)?.[1] ?? text;

export async function executeSteps(
  ctx: { root: string; config: Pick<Config, "tools"> },
  steps: readonly Step[],
  execute: Execute = run,
): Promise<{ diagnostics: Diagnostic[]; checks: CheckStatus[]; versions: Record<string, string> }> {
  const diagnostics: Diagnostic[] = [],
    checks: CheckStatus[] = [],
    versions: Record<string, string> = {};
  for (const step of steps) {
    const id = step.id ?? step.name ?? "";
    if (step.versionCommand) {
      const probe = await execute(step.versionCommand, {
        cwd: step.cwd,
        timeout: ctx.config.tools?.timeout ?? 120000,
        env: step.env,
        inheritEnv: step.inheritEnv ?? true,
      });
      const version = `${probe.stdout}\n${probe.stderr}`.trim();
      const key = step.tool ?? id;
      if (probe.error || probe.code !== 0) {
        diagnostics.push({
          rule: "tools.missing",
          path: step.path ?? ".",
          check: id,
          status: "incomplete",
          suppressible: false,
          message: `Cannot run ${key}: ${probe.error ?? version}`,
          remedy: "Install the configured native toolchain and retry.",
        });
        checks.push({ id, status: "incomplete" });
        continue;
      }
      versions[key] ??= version;
      versions[`${key}@${step.path ?? "."}`] = version;
      const expected = ctx.config.tools?.versions?.[key];
      const actual = versionOf(version);
      if (expected && actual !== expected) {
        diagnostics.push({
          rule: "tools.version",
          path: step.path ?? ".",
          check: id,
          status: "incomplete",
          suppressible: false,
          message: `${key} is ${actual}; policy requires ${expected}.`,
          remedy: "Install the exact approved tool version.",
        });
        checks.push({ id, status: "incomplete" });
        continue;
      }
    }
    const result = await execute(step.command, {
      cwd: step.cwd,
      timeout: ctx.config.tools?.timeout ?? 120000,
      env: step.env,
      inheritEnv: step.inheritEnv ?? true,
      input: step.input,
    });
    // a tool without a check flag prints the formatted file; any other output is a difference
    const differs =
      result.code === 0 && step.stdoutMatches !== undefined && result.stdout !== step.stdoutMatches;
    const status: Status =
      result.error || result.code === null || result.code > 1
        ? "incomplete"
        : result.code === 0 && !differs
          ? "pass"
          : "violation";
    checks.push({ id, status });
    if (status !== "pass") {
      diagnostics.push({
        rule: step.rule ?? id,
        path: step.path ?? ".",
        check: id,
        status,
        suppressible: false,
        message:
          result.error ??
          (differs ? `${id}: ${(step.files ?? []).join(", ")} would be reformatted` : undefined) ??
          `${id} exited ${String(result.code)}:\n${`${result.stdout}\n${result.stderr}`.trim().replaceAll(ctx.root, ".")}`,
        remedy:
          status === "incomplete"
            ? "Resolve the tool or configuration error and rerun the complete check."
            : `Resolve the ${id} diagnostics and rerun plumb check.`,
      });
    }
  }
  return { diagnostics, checks, versions };
}
