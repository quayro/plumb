import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { hashComments } from "./comment-hash.ts";
import { pythonComments } from "./comment-python.ts";
import { slashComments } from "./comment-slash.ts";
import type { Config } from "./config.ts";
import type { Rule } from "./diagnostics.ts";
import { isWithin, safePath } from "./files.ts";

export type CommentCode = keyof typeof commentMessages;

const isCommentCode = (code: string): code is CommentCode => Object.hasOwn(commentMessages, code);

export interface CommentFinding {
  line: number;
  code: CommentCode | "directive" | "block" | "syntax";
  message: string;
  status?: "incomplete";
  suppressible?: false;
}

// one comment standard for every language: the eslint rule and the text engine both read it

const COMMENT_CHARS_MAX = 100;

const DIRECTIVES =
  /^(?:eslint(?:\s|[-/])|globals?\b|exported\b|(?:istanbul|c8|v8)\s+ignore\b|prettier-ignore\b|@(?:ts-|jsx|license|preserve)|[#@]\s*source(?:Mapping)?URL=|[#@]__PURE__|\/\s*<reference\b|-\*-|syntax=|escape=)/; // tool directives speak to a tool, not a reader

const DECORATION = /^[-=*_~#\s]{3,}$|^[-=*_~#]{3,}\s*\S[^\n]*[-=*_~#]{3,}$/; // a rule of dashes, or a title fenced by them

const CAPITAL = /^(?:A|[A-Z][a-z]+)[,.:;]?$/; // a sentence's first word; an acronym or an identifier reads as itself

const CODE: Record<string, RegExp> = {
  script:
    /^(?:(?:export\s+)?(?:const|let|var)\s+[$\w]+(?:\s*:\s*[^=]+)?\s*=\s*\S[\s\S]*|(?:return|throw|await)\s+\S[^\n]*);$/,
  sql: /^(?:SELECT\b[\s\S]+\bFROM\b|INSERT\s+INTO\b|DELETE\s+FROM\b|UPDATE\s+\S+\s+SET\b|(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TYPE|FUNCTION|POLICY)\b)[\s\S]*;$/i,
  prisma:
    /^\w+\s+(?:String|Int|Float|Boolean|DateTime|Json|Bytes|Decimal)(?:\?|\[\])?(?:\s+@[^\n]+)?$/,
  jsonc: /^"(?:\\.|[^"\\])+"\s*:\s*[^\n]+[,}]$/,
  css: /^(?:--)?[a-z][a-z0-9-]*\s*:\s*[^;{}]+;$|^[^{}]+\{[^{}]*\}$/,
}; // a comment that is code, which the history keeps better than a comment does

export const commentMessages = {
  empty: "Remove empty comments; use a blank line for separation.",
  decoration: "Remove decorative comment separators; use a plain explanation when needed.",
  code: "Remove commented-out code; label intentional examples with Example: or @example.",
  spacing: "Separate the comment delimiter from its text with a space.",
  capital: "A comment starts lowercase unless its first word is an acronym or an identifier.",
  long: `A comment line is at most ${COMMENT_CHARS_MAX} characters.`,
  task: "Resolve the task marker or name its issue, for example TODO(#12).",
};

const normalize = (value: string): string =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*(?:\s|$)/, ""))
    .join("\n")
    .trim();

export const commentIsDirective = (value: string): boolean => DIRECTIVES.test(normalize(value));

const BLOCK_ONLY = /^(?:eslint\s|globals?\b|exported\b)/; // eslint reads these only from a block comment

const isDirective = (text: string, language: string): boolean =>
  DIRECTIVES.test(text) && !(language === "script" && BLOCK_ONLY.test(text));

// value: the comment text after its delimiter, exactly as written; language picks the code shapes
// a script comment that reaches here is a line comment, since a block one is refused first
export const commentProblems = (value: string, language = "script"): CommentCode[] => {
  const text = normalize(value);
  if (isDirective(text, language)) {
    return [];
  }
  if (!text) {
    return ["empty"];
  }
  if (DECORATION.test(text)) {
    return ["decoration"];
  }
  if (/```|@example\b|^Example:/.test(text)) {
    return [];
  }
  if (CODE[language]?.test(text) || (language !== "script" && CODE.script?.test(text))) {
    return ["code"];
  }
  const problems: CommentCode[] = [];
  if (value && !/^[\s*!/#@]/.test(value)) {
    problems.push("spacing");
  }
  if (CAPITAL.test(text.split(/\s+/)[0] ?? "")) {
    problems.push("capital");
  }
  if (value.split(/\r?\n/).some((line) => line.trim().length > COMMENT_CHARS_MAX)) {
    problems.push("long");
  }
  return problems;
};

export const RULES: Rule[] = [
  ...Object.entries(commentMessages).map(([id, description]) => ({
    id: `comments.${id}`,
    description,
    remedy: description,
  })),
  {
    id: "comments.block",
    description: "Non-CSS/SQL block comments are reserved for tool directives.",
    remedy: "Write a line comment.",
  },
  {
    id: "comments.directive",
    description: "Source comments cannot disable native checks or formatting.",
    remedy: "Remove the suppression and resolve the tool's finding; policy changes require review.",
    suppressible: false,
  },
  {
    id: "comments.syntax",
    description: "The comment scanner must understand the selected syntax.",
    remedy: "Use the documented syntax subset or extend the language adapter.",
    suppressible: false,
  },
];
const SUPPRESSION =
  /\b(?:shellcheck\s+disable\s*=|shfmt:?\s+(?:off|skip|ignore)\b|prettier-ignore(?:\b|-))/i;

export function commentsLanguageOf(path: string): string | undefined {
  const name = posix.basename(path);
  const extension = posix.extname(path);
  if ([".prisma", ".sql", ".jsonc", ".css"].includes(extension)) {
    return extension.slice(1);
  }
  if ([".yml", ".yaml"].includes(extension)) {
    return "yaml";
  }
  if (/^\.env(?:\.(?:schema|example))?$/.test(name)) {
    return "env";
  }
  if (name === "Dockerfile" || name.endsWith(".dockerfile")) {
    return "docker";
  }
  if (extension === ".sh") {
    return "shell";
  }
  if ([".py", ".pyi"].includes(extension)) {
    return "python";
  }
  if (extension === ".rs") {
    return "rust";
  }
  return undefined; // JavaScript comments are checked from its parser's tokens in the optional pack.
}

// a tool's own directive, written as the first words of a comment; a bare word elsewhere in prose
// is not one
// Python's forms follow the adapter's directive list, so a comment is refused the same way in both
const TOOL_SUPPRESSION =
  /^\s*(?:biome-ignore|stylelint-disable|markdownlint-disable|cspell:\s*(?:disable|ignore)|hadolint\s+(?:global\s+)?ignore|yamllint\s+disable|sqlfluff[:\s]+noqa|nolint\b|eslint-disable|(?:ruff|flake8)\s*:\s*noqa\b|noqa\b|type\s*:\s*ignore\b|fmt\s*:\s*(?:off|skip)\b|yapf\s*:\s*disable\b|isort\s*:\s*(?:off|skip(?:_file)?)\b|autopep8\s*:\s*off\b|black\s*:\s*skip\b|pylint\s*:\s*(?:disable(?:-next)?|skip-file)\b|pragma\s*:\s*no\s*cover\b|nosec\b|pyright\s*:\s*ignore\b|mypy\s*:\s*ignore-errors\b|(?:istanbul|c8|v8)\s+ignore\b|@formatter:off|editorconfig-checker-disable|checkov:\s*skip|tflint-ignore|gitleaks:\s*allow)/i;
const TASK = /\b(?:TODO|FIXME|XXX|HACK)\b/g; // case-sensitive: lowercase prose is not a task marker

export function commentsFind(
  source: string,
  language: string,
  { tasks, markers = true }: { tasks?: string; markers?: boolean } = {},
): CommentFinding[] {
  const lineOf = (index: number): number => source.slice(0, index).split("\n").length;
  const { found, issues } =
    language === "python"
      ? pythonComments(source)
      : ["shell", "yaml", "env", "docker"].includes(language)
        ? hashComments(source, language)
        : slashComments(source, language);
  const task = (text: string, line: number): CommentFinding[] =>
    markers
      ? [...text.matchAll(TASK)]
          .filter(
            ({ index }) =>
              !(tasks !== undefined && new RegExp(`^(?:${tasks})`).test(text.slice(index))),
          )
          .map(() => ({ line, code: "task", message: commentMessages.task }))
      : [];
  return [
    ...found.flatMap(({ index, text, block }): CommentFinding[] => {
      const line = lineOf(index);
      if (SUPPRESSION.test(text) || TOOL_SUPPRESSION.test(normalize(text))) {
        return [
          {
            line,
            code: "directive",
            message: "Source comments cannot disable native checks or formatting.",
            suppressible: false,
          },
        ];
      }
      if (block && !["css", "sql"].includes(language) && !commentIsDirective(text)) {
        return [
          {
            line,
            code: "block",
            message: "Write a line comment; a block comment is reserved for tool directives.",
          },
          ...task(text, line),
        ];
      }
      return [
        ...commentProblems(text, language).map((code) => ({
          line,
          code,
          message: commentMessages[code],
        })),
        ...task(text, line),
      ];
    }),
    ...issues.map(({ index, message }): CommentFinding => ({
      line: lineOf(index),
      code: "syntax",
      message,
      status: "incomplete",
      suppressible: false,
    })),
  ];
}

export function checkComments({
  root,
  files,
  config,
  read = (path) => readFileSync(safePath(root, path), "utf8"),
}: {
  root: string;
  files: readonly string[];
  config: Pick<Config, "preset" | "comments" | "projects">;
  read?: (path: string) => string | null;
}): (Omit<CommentFinding, "code"> & { rule: string; path: string; remedy: string })[] {
  const wording = config.preset === "ozmikhail",
    markers = wording || config.comments?.tasks !== undefined;
  return files.flatMap((path) => {
    const language = commentsLanguageOf(path);
    const governed =
      wording ||
      (config.projects ?? []).some(
        (project) =>
          project.profile === language &&
          (language === "python" || language === "rust") &&
          isWithin(project.root, path),
      );
    return language && governed
      ? commentsFind(read(path) ?? "", language, { tasks: config.comments?.tasks, markers })
          .filter(
            ({ code }) =>
              wording || ["directive", "syntax"].includes(code) || (code === "task" && markers),
          )
          .map(({ code, ...finding }) => ({
            rule: `comments.${code}`,
            path,
            remedy:
              RULES.find(({ id }) => id === `comments.${code}`)?.remedy ??
              (isCommentCode(code) ? commentMessages[code] : ""),
            ...finding,
          }))
      : [];
  });
}
