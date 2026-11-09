import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { Diagnostic, Rule } from "./diagnostics.ts";
import { errorMessage } from "./errors.ts";
import { canonical, digest, safePath } from "./files.ts";
import { array, type Infer, object, validateSchema } from "./schema.ts";

const text = { type: "string", minLength: 1, pattern: "\\S" } as const;
const identifier = { ...text, pattern: "^[a-z][a-z0-9._:-]*$" } as const;

const names = array({ ...text, pattern: "^[a-z][a-z0-9._:/-]*$" }, 1);

export const TASK_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:plumb:task:v1",
  title: "Plumb task contract",
  ...object(
    {
      $schema: text,
      schemaVersion: { const: 1 },
      id: identifier,
      requireChecks: names,
      requireTests: names,
    },
    ["schemaVersion", "id"],
  ),
} as const;

export type Task = Infer<typeof TASK_SCHEMA>;

export interface LoadedTask {
  task: Task;
  path: string;
  source: string;
  identity: { id: string; sha256: string };
}

interface CheckRecord {
  id: string;
  status: string;
  capability?: string;
  capabilities?: string[];
}

interface TestRecord {
  id: string;
  status: string;
  tests?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  subject?: unknown;
}

export const RULES: Rule[] = (
  [
    ["task.checks", "Every required check must complete successfully."],
    ["task.tests", "Every required test suite must provide complete execution evidence."],
    ["task.changed", "The approved task contract cannot change during a run."],
  ] as const
).map(([id, description]): Rule => ({
  id,
  description,
  remedy:
    "Resolve the source or verification failure; changes to the task contract need their own review.",
  suppressible: false,
}));

const problem = (
  rule: string,
  path: string,
  message: string,
  status: "violation" | "incomplete" = "violation",
): Diagnostic => ({
  rule,
  path,
  message,
  status,
  suppressible: false,
  remedy:
    "Satisfy the approved task contract and rerun the complete check; project exceptions cannot waive task restrictions.",
});

const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach((item: unknown) => freeze(item));
    Object.freeze(value);
  }
  return value;
};

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

export function defineTask(input: unknown): Task {
  validateSchema(input, TASK_SCHEMA, "task");
  return freeze(structuredClone(input));
}

export function loadTask(path: string, { root }: { root?: string } = {}): LoadedTask {
  const absolute = resolve(path),
    target = safePath(dirname(absolute), basename(absolute));
  if (root) {
    const offset = relative(realpathSync(root), realpathSync(target));
    if (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)) {
      throw new TypeError("The approved task contract must be outside the candidate repository");
    }
  }
  const source = readFileSync(target, "utf8"),
    parsed: unknown = JSON.parse(source),
    task = defineTask(parsed);
  return { task, path: target, source, identity: { id: task.id, sha256: digest(source) } };
}

export function taskRequirements(task: Task): { checks: string[]; tests: string[] } {
  return { checks: unique(task.requireChecks ?? []), tests: unique(task.requireTests ?? []) };
}

export function checkTask(
  loaded: LoadedTask | Task,
  {
    checks = [],
    testResults = [],
    subject,
  }: {
    checks?: readonly CheckRecord[];
    testResults?: readonly TestRecord[];
    subject?: unknown;
  } = {},
): { diagnostics: Diagnostic[]; requirements: { checks: string[]; tests: string[] } } {
  const task = "task" in loaded ? loaded.task : loaded,
    requirements = taskRequirements(task),
    diagnostics: Diagnostic[] = [];
  if ("task" in loaded) {
    try {
      if (readFileSync(loaded.path, "utf8") !== loaded.source) {
        throw new Error("The approved task file changed while checking");
      }
    } catch (error) {
      diagnostics.push(problem("task.changed", ".", errorMessage(error), "incomplete"));
    }
  }
  for (const name of requirements.checks) {
    const matching = checks.filter(
      (check) =>
        check.id === name || check.capability === name || check.capabilities?.includes(name),
    );
    const unfinished =
      !matching.length || matching.some((check) => !["pass", "violation"].includes(check.status));
    if (unfinished || matching.some((check) => check.status !== "pass")) {
      diagnostics.push(
        problem(
          "task.checks",
          ".",
          `Required check ${name} did not complete successfully for every applicable scope.`,
          unfinished ? "incomplete" : "violation",
        ),
      );
    }
  }
  for (const name of requirements.tests) {
    const matching = testResults.filter((result) => result.id === name),
      result = matching[0];
    const counts = result ? [result.tests, result.passed, result.failed, result.skipped] : [];
    const complete =
      !!result &&
      matching.length === 1 &&
      counts.every((count) => count !== undefined && Number.isInteger(count) && count >= 0) &&
      (result.tests ?? 0) === (result.passed ?? 0) + (result.failed ?? 0) + (result.skipped ?? 0) &&
      (result.passed ?? 0) + (result.failed ?? 0) > 0 &&
      ["pass", "violation"].includes(result.status) &&
      (!subject || canonical(result.subject) === canonical(subject));
    if (!complete || result.status !== "pass" || result.failed) {
      diagnostics.push(
        problem(
          "task.tests",
          ".",
          `Required test suite ${name} needs complete, nonempty execution evidence for this checked subject.`,
          !complete || (result.status === "pass" && result.failed) ? "incomplete" : "violation",
        ),
      );
    }
  }
  return { diagnostics, requirements };
}
