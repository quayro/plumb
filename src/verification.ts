import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import type { Context } from "./context.ts";
import type { Diagnostic, ReportCheck, Rule } from "./diagnostics.ts";
import { errorMessage } from "./errors.ts";
import { canonical, digest, isWithin, safePath } from "./files.ts";
import {
  inputDigest,
  type LoadedInputs,
  type MaterializedInputs,
  materializeInputs,
} from "./inputs.ts";
import type { TestCase } from "./junit.ts";
import { parseJUnit } from "./junit.ts";
import { type Execute, run } from "./process.ts";
import { at, isArray, isRecord } from "./schema.ts";
import { copyWorkspace, type Workspace } from "./workspace.ts";

type Suite = NonNullable<Config["verification"]>[number];

export interface SuiteEvidence {
  id: string;
  status: "pass" | "violation" | "incomplete";
  tests?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  subject?: unknown;
  reportSha256?: string;
  commandSha256?: string;
  environmentSha256?: string;
}

export const RULES: Rule[] = (
  [
    ["verification.failed", "Required behavioral verification must pass."],
    ["verification.incomplete", "Required suites need fresh, complete execution evidence."],
    ["verification.skipped", "Skipped tests must stay within the reviewed suite budget."],
  ] as const
).map(([id, description]): Rule => ({
  id,
  description,
  remedy: "Restore the required tests and run the approved suite against the same source snapshot.",
  suppressible: false,
}));

const issue = (
  rule: string,
  suite: Pick<Suite, "cwd" | "id">,
  message: string,
  incomplete = false,
): Diagnostic => ({
  rule,
  path: suite.cwd ?? ".",
  message,
  remedy:
    "Correct the suite, its prerequisites, or its report; verification cannot be replaced with a successful empty command.",
  ...(incomplete ? { status: "incomplete" as const } : {}),
  suppressible: false,
  check: `test:${suite.id}`,
});

export function parseVerification(source: string, format: string, id: string): TestCase[] {
  if (Buffer.byteLength(source) > 16 * 1024 * 1024) {
    throw new Error("Verification report exceeds 16 MiB");
  }
  if (format === "junit") {
    return parseJUnit(source);
  }
  if (format !== "plumb-json") {
    throw new Error(`Unsupported verification format ${format}`);
  }
  const value: unknown = JSON.parse(source),
    rows = at(value, "tests");
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.suite !== id ||
    !isArray(rows) ||
    Object.keys(value).some((key) => !["schemaVersion", "suite", "tests"].includes(key))
  ) {
    throw new Error("Expected a versioned report for the required suite");
  }
  const ids = new Set<string>(),
    tests: TestCase[] = [];
  for (const row of rows) {
    const rowId = at(row, "id"),
      status = at(row, "status"),
      message = at(row, "message");
    if (
      !isRecord(row) ||
      typeof rowId !== "string" ||
      !rowId.trim() ||
      ids.has(rowId) ||
      (status !== "passed" && status !== "failed" && status !== "skipped") ||
      Object.keys(row).some((key) => !["id", "status", "message"].includes(key)) ||
      (message !== undefined && typeof message !== "string")
    ) {
      throw new Error("Malformed, duplicate or unsupported test case");
    }
    ids.add(rowId);
    tests.push({ id: rowId, status, ...(message === undefined ? {} : { message }) });
  }
  return tests;
}

function readReport(path: string): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1) {
    throw new Error("A fresh report must be a regular file, not a link");
  }
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size > 16 * 1024 * 1024
    ) {
      throw new Error("Verification report is unsafe, changed or larger than 16 MiB");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
  } finally {
    closeSync(file);
  }
}

export async function verifySuites(
  ctx: Pick<Context, "root" | "config" | "allFiles">,
  {
    subject,
    inputs,
    execute = run,
    temporaryRoot,
  }: { subject?: unknown; inputs?: LoadedInputs; execute?: Execute; temporaryRoot?: string } = {},
): Promise<{ diagnostics: Diagnostic[]; results: SuiteEvidence[]; checks: ReportCheck[] }> {
  const diagnostics: Diagnostic[] = [],
    results: SuiteEvidence[] = [],
    checks: (ReportCheck & { evidence?: string })[] = [];
  for (const suite of ctx.config.verification ?? []) {
    let workspace: Workspace | undefined,
      artifacts: string | undefined,
      overlay: MaterializedInputs | undefined;
    try {
      const files = ctx.allFiles.filter(
        (path) => !inputs?.entries.some((entry) => isWithin(entry.path, path)),
      );
      workspace = copyWorkspace(ctx.root, { files, temporaryRoot });
      if (inputs) {
        overlay = materializeInputs(workspace.root, inputs);
      }
      const temporary = temporaryRoot ?? process.env.PLUMB_TEST_TMP ?? tmpdir();
      mkdirSync(temporary, { recursive: true });
      artifacts = mkdtempSync(join(temporary, "plumb-results-"));
      const artifactsStat = lstatSync(artifacts),
        artifactsPath = realpathSync(artifacts);
      const reportPath = join(artifacts, suite.format === "junit" ? "report.xml" : "report.json");
      if (existsSync(reportPath)) {
        throw new Error("Verification report already exists before execution");
      }
      const directory = artifacts;
      const env: Record<string, string> = {
        ...Object.fromEntries(
          ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", ...(suite.inheritEnv ?? [])].flatMap(
            (key): [string, string][] => {
              const value = process.env[key];
              return value === undefined ? [] : [[key, value]];
            },
          ),
        ),
        ...suite.env,
        PLUMB_REPORT: reportPath,
        PLUMB_ARTIFACTS: artifacts,
        PYTHONDONTWRITEBYTECODE: "1",
      };
      const command = suite.command.map((arg) =>
        arg.replaceAll("{report}", reportPath).replaceAll("{artifacts}", directory),
      );
      const before = inputDigest(workspace.root);
      const result = await execute(command, {
        cwd: safePath(workspace.root, suite.cwd ?? "."),
        timeout: suite.timeout ?? ctx.config.tools?.timeout ?? 120000,
        env,
        inheritEnv: false,
        maxOutput: 16 * 1024 * 1024,
      });
      if (result.error || result.code === null || result.code > 1 || result.code < 0) {
        throw new Error(result.error ?? `Suite exited ${String(result.code)}`);
      }
      if (inputDigest(workspace.root) !== before) {
        throw new Error(
          "Suite changed checked source or approved inputs; direct generated output to {artifacts}",
        );
      }
      overlay?.verify();
      inputs?.verify();
      workspace.verify();
      const actualArtifacts = lstatSync(artifacts);
      if (
        !actualArtifacts.isDirectory() ||
        actualArtifacts.dev !== artifactsStat.dev ||
        actualArtifacts.ino !== artifactsStat.ino ||
        realpathSync(artifacts) !== artifactsPath
      ) {
        throw new Error("Verification artifact directory was replaced");
      }
      const source = (suite.report ?? "stdout") === "file" ? readReport(reportPath) : result.stdout;
      const tests = parseVerification(source, suite.format, suite.id),
        passed = tests.filter((test) => test.status === "passed").length,
        failed = tests.filter((test) => test.status === "failed").length,
        skipped = tests.length - passed - failed;
      if (passed + failed < (suite.minTests ?? 1)) {
        throw new Error(
          `Only ${passed + failed} tests executed; at least ${suite.minTests ?? 1} are required`,
        );
      }
      if (result.code === 1 && !failed) {
        throw new Error("Failing command contradicts a report without failures");
      }
      const status = failed || skipped > (suite.maxSkipped ?? 0) ? "violation" : "pass";
      const evidence: SuiteEvidence = {
        id: suite.id,
        status,
        tests: tests.length,
        passed,
        failed,
        skipped,
        subject,
        reportSha256: digest(source),
        commandSha256: digest(canonical(suite.command)),
        environmentSha256: digest(
          canonical(
            Object.fromEntries(
              Object.entries(env).filter(
                ([key]) => !["PLUMB_REPORT", "PLUMB_ARTIFACTS"].includes(key),
              ),
            ),
          ),
        ),
      };
      results.push(evidence);
      checks.push({ id: `test:${suite.id}`, capability: "tests", status, evidence: "test-report" });
      if (failed) {
        diagnostics.push(
          issue(
            "verification.failed",
            suite,
            `${failed} tests failed: ${tests
              .filter((test) => test.status === "failed")
              .slice(0, 10)
              .map((test) => `${test.id}${test.message ? `: ${test.message}` : ""}`)
              .join("; ")}`,
          ),
        );
      }
      if (skipped > (suite.maxSkipped ?? 0)) {
        diagnostics.push(
          issue(
            "verification.skipped",
            suite,
            `${skipped} tests skipped; policy permits ${suite.maxSkipped ?? 0}.`,
          ),
        );
      }
    } catch (error) {
      diagnostics.push(
        issue("verification.incomplete", suite, `${suite.id}: ${errorMessage(error)}`, true),
      );
      results.push({ id: suite.id, status: "incomplete", subject });
      checks.push({ id: `test:${suite.id}`, capability: "tests", status: "incomplete" });
    } finally {
      workspace?.cleanup();
      if (artifacts) {
        rmSync(artifacts, { recursive: true, force: true });
      }
    }
  }
  return { diagnostics, results, checks };
}
