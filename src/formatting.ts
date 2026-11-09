import { writeFileSync } from "node:fs";

import { alignKeyColumns, alignMarkdownTables, jsonKeyOrder, sortJsonKeys } from "./align.ts";
import type { Context } from "./context.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { errorMessage } from "./errors.ts";

type FormatContext = Pick<Context, "config" | "files" | "matches" | "read" | "safePath"> &
  Partial<Pick<Context, "ownedFiles" | "writableFiles">>;

type Kind = "markdown-table" | "key-columns" | "json-keys";

// plumb-owned layout passes for files no language pack formats: tables, KEY columns and listed JSON
// key order

const REMEDY = "Run plumb fix and review the alignment.";
export const RULES = [
  {
    id: "format.markdown-table",
    description: "Markdown tables keep padded, aligned columns.",
    remedy: REMEDY,
    suppressible: true,
  },
  {
    id: "format.key-columns",
    description: "KEY files keep their value and comment columns aligned.",
    remedy: REMEDY,
    suppressible: true,
  },
  {
    id: "format.json-keys",
    description: "Listed JSON files keep their keys in code-point order.",
    remedy: REMEDY,
    suppressible: true,
  },
];
export const KEY_COLUMNS = ["**/.env.schema", "**/.env.example"];

const javascript = (ctx: FormatContext): boolean =>
  ctx.config.projects.some((project) => ["typescript", "react"].includes(project.profile));

// the deepest matching entry applies, so an added entry can only sort more, never shadow another
const sortEntry = (ctx: FormatContext, path: string) =>
  (ctx.config.format?.sortKeys ?? [])
    .filter((entry) => ctx.matches(entry.files, path))
    .sort((a, b) => (b.depth ?? 1) - (a.depth ?? 1))[0];

const kindOf = (ctx: FormatContext, path: string): Kind | null => {
  const ozmikhail = ctx.config.preset === "ozmikhail";
  if (ozmikhail && path.endsWith(".md") && !javascript(ctx)) {
    return "markdown-table";
  }
  if (ozmikhail && ctx.matches(ctx.config.format?.keyColumns ?? KEY_COLUMNS, path)) {
    return "key-columns";
  }
  return sortEntry(ctx, path) ? "json-keys" : null;
};

export function formattingFiles(ctx: FormatContext): string[] {
  const owned = new Set(ctx.ownedFiles ?? []);
  return ctx.files.filter(
    (path) =>
      !owned.has(path) &&
      !ctx.config.format?.ignore?.some((entry) => ctx.matches(entry.path, path)) &&
      kindOf(ctx, path),
  );
}

export function expectedLayout(ctx: FormatContext, path: string, source: string): string {
  const entry = sortEntry(ctx, path),
    sorted = entry ? sortJsonKeys(source, entry.depth ?? 1) : source;
  const kind = kindOf(ctx, path);
  return kind === "markdown-table"
    ? alignMarkdownTables(sorted)
    : kind === "key-columns"
      ? alignKeyColumns(sorted)
      : sorted;
}

const differs = (ctx: FormatContext, path: string, source: string, expected: string): boolean => {
  if (kindOf(ctx, path) !== "json-keys") {
    return source !== expected;
  }
  // prettier owns JSON whitespace in a JavaScript repository, so only the key sequence is compared
  const depth = sortEntry(ctx, path)?.depth ?? 1;
  return jsonKeyOrder(source, depth) !== jsonKeyOrder(expected, depth);
};

const diagnostic = (
  ctx: FormatContext,
  path: string,
  message: string,
  status: "violation" | "incomplete" = "violation",
): Diagnostic => ({
  rule: `format.${kindOf(ctx, path) ?? "json-keys"}`,
  path,
  status,
  message,
  remedy:
    status === "incomplete" ? "Correct the file's syntax so its layout can be checked." : REMEDY,
});

function run(ctx: FormatContext, write: boolean): { diagnostics: Diagnostic[]; written: string[] } {
  const diagnostics: Diagnostic[] = [],
    written: string[] = [],
    writable = new Set(ctx.writableFiles ?? ctx.files);
  for (const path of formattingFiles(ctx)) {
    let source: string | null, expected: string;
    try {
      source = ctx.read(path);
      if (source === null) {
        throw new Error("the file is missing");
      }
      expected = expectedLayout(ctx, path, source);
    } catch (error) {
      diagnostics.push(
        diagnostic(ctx, path, `The file could not be parsed: ${errorMessage(error)}`, "incomplete"),
      );
      continue;
    }
    if (!differs(ctx, path, source, expected)) {
      continue;
    }
    if (write && writable.has(path)) {
      writeFileSync(ctx.safePath(path), expected);
      written.push(path);
    } else {
      diagnostics.push(diagnostic(ctx, path, "File differs from the aligned layout."));
    }
  }
  return { diagnostics, written };
}

export const checkFormatting = (ctx: FormatContext): Diagnostic[] => run(ctx, false).diagnostics;

export const fixFormatting = (
  ctx: FormatContext,
): { diagnostics: Diagnostic[]; written: string[] } => run(ctx, true);
