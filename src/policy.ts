import type { Config } from "./config.ts";
import type { Diagnostic, Rule } from "./diagnostics.ts";
import { globMatches } from "./files.ts";

export { isPolicyFile } from "./files.ts";

export const RULES: Rule[] = (
  [
    ["exceptions.invalid", "Exceptions must target known, suppressible rules."],
    ["exceptions.stale", "Remove exceptions and excess budgets that are no longer needed."],
    ["exceptions.overlap", "Each diagnostic must have one exception owner."],
    ["exceptions.expired", "Expired exceptions cannot hide a failure."],
    [
      "policy.weakened",
      "A policy change against the base weakens enforcement and needs its owner's approval.",
    ],
  ] as const
)
  .map(([id, description]): Rule => ({
    id,
    description,
    remedy: "Review the policy change with its owner before adopting a new approved policy.",
    suppressible: false,
  }))
  .concat([
    {
      id: "policy.base",
      description: "The base policy for --base must be readable from git.",
      remedy: "Fetch the base ref or pass the ref that contains the policy file.",
      suppressible: false,
    },
    {
      id: "policy.nested",
      description: "Only the repository-root policy governs a git checkout.",
      remedy:
        "Move the rules into the root plumb.json or reference the nested file as a pinned bundle.",
      suppressible: false,
    },
  ]);

const problem = (rule: string, path: string, message: string, remedy: string): Diagnostic => ({
  rule,
  path,
  message,
  remedy,
  status: "violation",
  suppressible: false,
});

export function applyExceptions(
  diagnostics: readonly Diagnostic[],
  exceptions: readonly Config["exceptions"][number][],
  metadata: readonly Pick<Rule, "id" | "suppressible">[],
  date = new Date().toISOString().slice(0, 10),
): { diagnostics: Diagnostic[]; suppressed: Diagnostic[] } {
  const visible: Diagnostic[] = [],
    suppressed: Diagnostic[] = [],
    issues: Diagnostic[] = [],
    used = new Map(exceptions.map((entry) => [entry.id, 0]));
  const rules = new Map(metadata.map((rule) => [rule.id, rule]));
  const valid = exceptions.filter((entry) => {
    const invalid = entry.rules.filter(
      (rule) => rules.get(rule)?.suppressible === false || !rules.has(rule),
    );
    if (invalid.length) {
      issues.push(
        problem(
          "exceptions.invalid",
          "plumb.json",
          `${entry.id} targets unknown or protected rules: ${invalid.join(", ")}.`,
          "Use exact rule IDs from plumb inspect; enforcement failures cannot be excepted.",
        ),
      );
    }
    if (entry.expires && entry.expires < date) {
      issues.push(
        problem(
          "exceptions.expired",
          "plumb.json",
          `Exception ${entry.id} expired on ${entry.expires}.`,
          "Fix the remaining violations and remove the expired exception.",
        ),
      );
    }
    return !invalid.length && (!entry.expires || entry.expires >= date);
  });
  for (const diagnostic of diagnostics) {
    const matches = valid.filter(
      (entry) =>
        entry.rules.includes(diagnostic.rule) && globMatches(entry.files, diagnostic.path ?? "."),
    );
    if (matches.length > 1) {
      issues.push(
        problem(
          "exceptions.overlap",
          diagnostic.path ?? ".",
          `Exceptions ${matches.map((entry) => entry.id).join(", ")} overlap.`,
          "Give this violation one narrow, bounded exception.",
        ),
      );
      visible.push(diagnostic);
    } else if (
      matches.length &&
      diagnostic.status !== "incomplete" &&
      diagnostic.suppressible !== false
    ) {
      const [entry] = matches,
        count = (used.get(entry.id) ?? 0) + 1;
      used.set(entry.id, count);
      if (count <= entry.max) {
        suppressed.push({ ...diagnostic, exception: entry.id });
      } else {
        visible.push(diagnostic);
      }
    } else {
      visible.push(diagnostic);
    }
  }
  for (const entry of valid) {
    const count = used.get(entry.id) ?? 0;
    if (count < entry.max) {
      issues.push(
        problem(
          "exceptions.stale",
          "plumb.json",
          count === 0
            ? `Exception ${entry.id} is no longer used.`
            : `Exception ${entry.id} needs ${count}, but budgets ${entry.max}.`,
          count === 0
            ? "Remove this exception."
            : `Reduce max to ${count}; exception budgets only shrink.`,
        ),
      );
    }
  }
  return { diagnostics: [...visible, ...issues], suppressed };
}
