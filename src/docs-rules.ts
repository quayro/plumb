import type { Diagnostic, Rule } from "./diagnostics.ts";
import type { Extra } from "./docs-markdown.ts";

export const RULES: Rule[] = [
  {
    id: "docs.links",
    description:
      "Local Markdown links, reference labels and heading anchors resolve inside the repository.",
    remedy: "Update the link or restore its target.",
  },
  {
    id: "docs.index",
    description: "A documentation index links every guide beneath its folder.",
    remedy: "Add the missing guide to the index.",
  },
  {
    id: "docs.syntax",
    description: "Documentation can be inspected without hiding an unfinished code block.",
    remedy: "Close the fence or HTML comment.",
    suppressible: false,
  },
  {
    id: "docs.headings",
    description:
      "Headings use one leading H1, ATX syntax, no skipped levels and no repeated titles under one parent.",
    remedy: "Correct the heading structure.",
  },
  {
    id: "docs.fences",
    description: "Every fenced code block names its language.",
    remedy: "Add a language to the opening fence; use text when none applies.",
  },
  {
    id: "docs.layout",
    description:
      "Documentation folders follow the declared sections and index every page, folder and asset.",
    remedy: "Add the declared section, the folder's index.md, or the missing index link.",
  },
  {
    id: "docs.kinds",
    description:
      "Documents of a declared kind follow its filename, section, status and sequence contract.",
    remedy: "Correct the document so it matches its declared kind.",
  },
  {
    id: "docs.generated",
    description: "Generated documentation regions match the output of their pinned command.",
    remedy: "Run plumb fix to regenerate the region.",
  },
  {
    id: "docs.scope",
    description: "A configured documentation rule governs at least one Markdown file.",
    remedy: "Correct the documentation scope or add the governed files.",
    suppressible: false,
  },
];

export const entry = (
  rule: string,
  path: string,
  message: string,
  extra: Extra = {},
): Diagnostic => ({
  rule,
  path,
  message,
  remedy: RULES.find(({ id }) => id === rule)?.remedy ?? "Correct the documentation.",
  ...extra,
});

export const incomplete = (
  rule: string,
  path: string,
  message: string,
  extra: Extra = {},
): Diagnostic =>
  entry(rule, path, message, { status: "incomplete", suppressible: false, ...extra });

export const MARKDOWN = /\.(?:md|markdown)$/i;

export const pad = (number: number): string => String(number).padStart(4, "0");
