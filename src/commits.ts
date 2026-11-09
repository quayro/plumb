import type { Config } from "./config.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { type Execute, run } from "./process.ts";

type CommitPolicy = NonNullable<Config["commits"]>;

export const RULES = [
  {
    id: "commits.format",
    description:
      "Commit subjects use the type(scope)!?: subject grammar with one space after the colon.",
    remedy: "Rewrite the subject as type(scope): subject and rerun the commit check.",
    suppressible: false,
  },
  {
    id: "commits.body",
    description: "Commit messages are one subject line with no body or trailers.",
    remedy: "Keep only the subject and move details to the pull request.",
    suppressible: false,
  },
  {
    id: "commits.fixup",
    description: "Fixup, squash and amend commits are refused before they reach history.",
    remedy: "Rewrite the commit with an autosquash rebase, then rerun the commit check.",
    suppressible: false,
  },
  {
    id: "commits.merge",
    description: "Merge commits and Merge subjects are refused; history stays linear.",
    remedy: "Rebase the branch instead of merging, then rerun the commit check.",
    suppressible: false,
  },
  {
    id: "commits.length",
    description: "Commit subjects stay within the configured length.",
    remedy: "Shorten the subject to the configured maxLength.",
    suppressible: false,
  },
  {
    id: "commits.type",
    description: "Commit types are lowercase and listed in the policy.",
    remedy: "Use one of the configured lowercase commit types.",
    suppressible: false,
  },
  {
    id: "commits.scope",
    description: "Commit scopes follow the configured list or the lowercase scope grammar.",
    remedy: "Use a configured scope, or a lowercase scope when no list is configured.",
    suppressible: false,
  },
  {
    id: "commits.range",
    description: "Every commit in the checked range is available and inspectable.",
    remedy: "Fetch the base revision and check a non-empty range.",
    suppressible: false,
  },
];
export const DEFAULT_TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
];
const rules = Object.fromEntries(RULES.map((rule) => [rule.id, rule]));
const SCISSORS = " ------------------------ >8 ------------------------";
const SCOPE = /^[a-z][a-z0-9-]*$/;
const GRAMMAR = /^([^\s():!]+)(?:\(([^()\s]*)\))?(!)?: (\S.*)$/u;

const finding = (
  rule: string,
  path: string,
  message: string,
  remedy = rules[rule]?.remedy ?? "",
  status: "violation" | "incomplete" = "violation",
): Diagnostic => ({
  rule,
  path,
  message,
  remedy,
  status,
  suppressible: false,
});

const incomplete = (path: string, message: string, remedy: string): Diagnostic =>
  finding("commits.range", path, message, remedy, "incomplete");

// char null keeps every line (PR titles); otherwise git's comment lines and scissors are removed
export function normalizeMessage(text: string, char: string | null = "#"): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const cut = char ? lines.indexOf(`${char}${SCISSORS}`) : -1;
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).filter(
    (line) => !char || !line.startsWith(char),
  );
  while (kept.length && kept[0]?.trim() === "") {
    kept.shift();
  }
  while (kept.length && kept.at(-1)?.trim() === "") {
    kept.pop();
  }
  return kept.join("\n");
}

export function checkMessage(
  text: string,
  policy: CommitPolicy = {},
  path = "commit message",
  char: string | null = "#",
): Diagnostic[] {
  const found: Diagnostic[] = [],
    message = normalizeMessage(text, char),
    lines = message ? message.split("\n") : [],
    subject = lines[0] ?? "";
  if (!message) {
    return [
      finding(
        "commits.format",
        path,
        "Commit message is empty after removing comments and cleanup.",
      ),
    ];
  }
  const nonEmpty = lines.filter((line) => line.trim() !== "").length;
  if (nonEmpty > 1) {
    found.push(
      finding(
        "commits.body",
        path,
        `Commit message has ${nonEmpty} non-empty lines; only one subject line is allowed.`,
      ),
    );
  }
  if (/^(?:fixup|squash|amend)!/.test(subject)) {
    return [
      ...found,
      finding(
        "commits.fixup",
        path,
        `${subject.split(" ")[0]} commits must be rewritten before they are checked.`,
      ),
    ];
  }
  if (subject.startsWith("Merge ")) {
    return [
      ...found,
      finding("commits.merge", path, "Merge subjects are refused; rebase the branch instead."),
    ];
  }
  if (subject.startsWith('Revert "')) {
    return [
      ...found,
      finding(
        "commits.format",
        path,
        "Git's default Revert subject is refused; use revert(scope): subject.",
      ),
    ];
  }
  if (subject !== subject.trimStart()) {
    found.push(finding("commits.format", path, "Subject has leading whitespace."));
  }
  if (subject !== subject.trimEnd()) {
    found.push(finding("commits.format", path, "Subject has trailing whitespace."));
  }
  const length = [...subject].length,
    limit = policy.maxLength ?? 100;
  if (length > limit) {
    found.push(
      finding("commits.length", path, `Subject has ${length} code points; the limit is ${limit}.`),
    );
  }
  const match = GRAMMAR.exec(subject);
  if (!match) {
    return [
      ...found,
      finding(
        "commits.format",
        path,
        "Subject must be type(scope)!?: subject with exactly one space after the colon.",
      ),
    ];
  }
  const [, type, scope, , summary] = match,
    types = policy.types ?? DEFAULT_TYPES;
  if (type !== type.toLowerCase()) {
    found.push(finding("commits.type", path, `Type ${type} must be lowercase.`));
  } else if (!types.includes(type)) {
    found.push(
      finding("commits.type", path, `Type ${type} is not allowed; use one of ${types.join(", ")}.`),
    );
  }
  if (policy.scopes) {
    if (scope === undefined) {
      found.push(
        finding(
          "commits.scope",
          path,
          `A scope is required; use one of ${policy.scopes.join(", ")}.`,
        ),
      );
    } else if (!policy.scopes.includes(scope)) {
      found.push(
        finding(
          "commits.scope",
          path,
          `Scope ${scope} is not allowed; use one of ${policy.scopes.join(", ")}.`,
        ),
      );
    }
  } else if (scope !== undefined && !SCOPE.test(scope)) {
    found.push(finding("commits.scope", path, `Scope "${scope}" must match [a-z][a-z0-9-]*.`));
  }
  if (!/^[a-z0-9`]/.test(summary)) {
    found.push(
      finding(
        "commits.format",
        path,
        "Subject must start with a lowercase letter, digit or backtick.",
      ),
    );
  }
  if (summary.endsWith(".")) {
    found.push(finding("commits.format", path, "Subject must not end with a period."));
  }
  return found;
}

export async function commentChar(root: string, execute: Execute = run): Promise<string> {
  const result = await execute(["git", "config", "--get", "core.commentChar"], {
    cwd: root,
    timeout: 10000,
  });
  const char = result.code === 0 ? result.stdout.replace(/\n$/, "") : "";
  return [...char].length === 1 ? char : "#";
}

// each commit is inspected with its raw message and parent count; unknown history is incomplete,
// never a pass.
export async function checkRange(
  policy: CommitPolicy,
  range: string,
  { root, execute = run }: { root: string; execute?: Execute },
): Promise<Diagnostic[]> {
  const parts = range.split(".."),
    [base, head] = parts;
  if (parts.length !== 2 || !base || !head || base.startsWith("-") || head.startsWith("-")) {
    return [
      incomplete(
        range,
        "Expected BASE..HEAD with a non-empty base and head; nothing was checked.",
        "Pass --range BASE..HEAD, for example origin/main..HEAD.",
      ),
    ];
  }
  const verify = await execute(["git", "rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
    cwd: root,
    timeout: 30000,
  });
  if (verify.error || verify.code !== 0) {
    return [
      incomplete(
        base,
        `Base revision ${base} is unavailable in this clone.`,
        "Fetch the base (git fetch origin BASE, or git fetch --deepen N in a shallow clone), then rerun.",
      ),
    ];
  }
  const listed = await execute(["git", "rev-list", "--reverse", "--parents", range, "--"], {
    cwd: root,
    timeout: 60000,
  });
  if (listed.error || listed.code !== 0) {
    return [
      incomplete(
        range,
        `Cannot list commits: ${(listed.error ?? listed.stderr).trim()}`,
        "Fetch the missing history and rerun the commit check.",
      ),
    ];
  }
  const commits = listed.stdout.split("\n").filter(Boolean);
  if (!commits.length) {
    return [
      incomplete(
        range,
        "The range selects no commits; nothing was checked.",
        "Check a non-empty range such as origin/main..HEAD.",
      ),
    ];
  }
  const char = await commentChar(root, execute),
    found: Diagnostic[] = [];
  for (const line of commits) {
    const [sha = "", ...parents] = line.split(" "),
      short = sha.slice(0, 7);
    if (parents.length > 1) {
      found.push(
        finding(
          "commits.merge",
          short,
          `Merge commit has ${parents.length} parents; rewrite the branch so each commit has one parent.`,
        ),
      );
      continue;
    }
    const log = await execute(["git", "log", "-1", "--format=%B", sha, "--"], {
      cwd: root,
      timeout: 30000,
    });
    if (log.error || log.code !== 0) {
      found.push(
        incomplete(
          short,
          `Cannot read commit message: ${(log.error ?? log.stderr).trim()}`,
          "Fetch the missing history and rerun the commit check.",
        ),
      );
      continue;
    }
    found.push(...checkMessage(log.stdout, policy, short, char));
  }
  return found;
}
