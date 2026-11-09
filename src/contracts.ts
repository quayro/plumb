import { readFileSync, statSync } from "node:fs";
import { posix } from "node:path";

import type { Context } from "./context.ts";
import type { Diagnostic, Rule } from "./diagnostics.ts";
import { globMatches, safePath } from "./files.ts";

export const RULES: Rule[] = [
  {
    id: "files.required",
    description: "Required repository files exist.",
    remedy: "Add the required file.",
  },
  {
    id: "files.forbidden",
    description: "Forbidden file patterns match no repository files.",
    remedy: "Remove or relocate the forbidden file.",
  },
  {
    id: "files.names",
    description: "File and folder names satisfy the effective naming policy.",
    remedy: "Rename the file or folder and update its references.",
  },
  {
    id: "files.max-lines",
    description: "Text files stay within their declared line budget.",
    remedy: "Split responsibilities into smaller files.",
  },
  {
    id: "files.scope",
    description: "Declared file contracts select existing files.",
    remedy: "Correct the contract's file patterns.",
    suppressible: false,
  },
];

const entry = (
  rule: string,
  path: string,
  message: string,
  extra: Partial<Pick<Diagnostic, "line" | "status" | "suppressible">> = {},
): Diagnostic => ({
  rule,
  path,
  message,
  remedy: RULES.find(({ id }) => id === rule)?.remedy ?? "Correct the file contract.",
  ...extra,
});

const NAMING: [RegExp, RegExp, string][] = [
  [
    /\.[cm]?[jt]sx?$/,
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.(?:config|d|gen|integration|rules))?(?:\.test)?\.(?:[cm]?[jt]s|[jt]sx)$/,
    "kebab-case",
  ],
  [/\.css$/, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.module)?\.css$/, "kebab-case"],
  [/\.(?:rb|rake|gemspec)$/, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.(?:rb|rake|gemspec)$/, "snake_case"],
  [
    /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/,
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/,
    "snake_case",
  ],
];

export function checkFiles(
  context: Pick<Context, "root" | "files" | "config"> & { read?: (path: string) => string | null },
): Diagnostic[] {
  const { root, files, config } = context;
  const read = context.read ?? ((path: string) => readFileSync(safePath(root, path), "utf8"));
  const problems: Diagnostic[] = [];
  const required = new Set(config.files?.required ?? []);
  if (config.preset === "ozmikhail") {
    required.add("AGENTS.md");
  }
  for (const path of required) {
    try {
      if (!statSync(safePath(root, path)).isFile()) {
        throw new Error("not a file");
      }
    } catch {
      problems.push(
        entry("files.required", path, "A required repository file is missing or unreadable."),
      );
    }
  }
  for (const path of files) {
    if (globMatches(config.files?.forbidden ?? [], path)) {
      problems.push(
        entry("files.forbidden", path, "This file matches a forbidden repository pattern."),
      );
    }
    if (config.preset === "ozmikhail") {
      const rule = NAMING.find(([extension]) => extension.test(path));
      if (rule) {
        const [, pattern, style] = rule;
        if (!pattern.test(posix.basename(path))) {
          problems.push(
            entry("files.names", path, `Use lowercase ${style} with a supported filename suffix.`),
          );
        }
        const folders = path.split("/").slice(0, -1);
        if (!folders.some((folder) => folder.startsWith("."))) {
          const folderPattern =
            style === "kebab-case" ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/ : /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
          for (const folder of folders) {
            if (!folderPattern.test(folder)) {
              problems.push(
                entry("files.names", path, `Rename folder ${folder} in lowercase ${style}.`),
              );
            }
          }
        }
      }
    }
    if (config.files?.maxLines !== undefined) {
      const text = read(path) ?? "";
      const count = text === "" ? 0 : text.split("\n").length - Number(text.endsWith("\n"));
      if (!text.includes("\0") && count > config.files.maxLines) {
        problems.push(
          entry(
            "files.max-lines",
            path,
            `${count} lines exceeds the limit of ${config.files.maxLines}.`,
          ),
        );
      }
    }
  }
  for (const rule of config.files?.names ?? []) {
    const selected = files.filter((path) => globMatches(rule.files, path));
    if (!selected.length) {
      problems.push(
        entry(
          "files.scope",
          "plumb.json",
          `No files match naming contract ${rule.files.join(", ")}.`,
          { status: "incomplete", suppressible: false },
        ),
      );
    }
    const pattern = new RegExp(rule.pattern);
    for (const path of selected) {
      if (!pattern.test(posix.basename(path))) {
        problems.push(
          entry("files.names", path, `The filename must match ${rule.pattern}: ${rule.reason}`),
        );
      }
    }
  }
  return problems;
}
