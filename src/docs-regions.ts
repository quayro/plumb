import { readFileSync, writeFileSync } from "node:fs";

import type { Config } from "./config.ts";
import type { Context } from "./context.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { entry, incomplete } from "./docs-rules.ts";
import { safePath } from "./files.ts";
import { type Execute, run } from "./process.ts";

export type DocsPolicy = Pick<Config, "preset" | "docs" | "tools">;

export type DocsContext = Pick<Context, "root" | "files"> & {
  config: DocsPolicy;
  read?: (path: string) => string | null;
  writableFiles?: string[];
};

export type Region =
  | { path: string; region: string; problem: Diagnostic }
  | {
      path: string;
      region: string;
      start: number;
      end: number;
      lines: string[];
      eol: string;
      expected: string[];
      drift: boolean;
      line: number;
    };

// documentation rules: Markdown structure, links, folder layout, document kinds and generated regions

// the regions are read raw so a fix can rewrite a file that other checks already read.
export async function regions(
  { root, files, config }: Pick<DocsContext, "root" | "files" | "config">,
  execute: Execute,
): Promise<Region[]> {
  const results: Region[] = [];
  for (const gen of config.docs?.generated ?? []) {
    const base = { path: gen.file, region: gen.region };
    if (!files.includes(gen.file)) {
      results.push({
        ...base,
        problem: incomplete(
          "docs.scope",
          gen.file,
          `Generated documentation file ${gen.file} does not exist.`,
        ),
      });
      continue;
    }
    const source = readFileSync(safePath(root, gen.file), "utf8"),
      lines = source.split(/\r?\n/);
    const start = lines.indexOf(`<!-- plumb:generated ${gen.region} -->`);
    const end = start < 0 ? -1 : lines.indexOf("<!-- /plumb:generated -->", start + 1);
    if (start < 0 || end < 0) {
      results.push({
        ...base,
        problem: incomplete(
          "docs.generated",
          gen.file,
          `Region ${gen.region} needs both its start and end markers.`,
        ),
      });
      continue;
    }
    const result = await execute(gen.command, { cwd: root, timeout: config.tools?.timeout });
    if (result.error || result.code !== 0) {
      results.push({
        ...base,
        problem: incomplete(
          "docs.generated",
          gen.file,
          `Region ${gen.region} command failed: ${result.error ?? (result.stderr || `exit ${result.code}`).trim()}`,
          { line: start + 1 },
        ),
      });
      continue;
    }
    // blank lines around the fence keep the region in the shape markdown formatters print
    const expected = ["", "```text", ...result.stdout.trim().split(/\r?\n/), "```", ""];
    const drift = lines.slice(start + 1, end).join("\n") !== expected.join("\n");
    results.push({
      ...base,
      start,
      end,
      lines,
      eol: source.includes("\r\n") ? "\r\n" : "\n",
      expected,
      drift,
      line: start + 1,
    });
  }
  return results;
}

// plumb fix rewrites only the content between a generated region's markers
export async function fixDocs(
  context: DocsContext,
  { execute = run }: { execute?: Execute } = {},
): Promise<{ diagnostics: Diagnostic[]; written: string[] }> {
  const diagnostics: Diagnostic[] = [],
    written: string[] = [],
    writable = new Set(context.writableFiles ?? context.files);
  for (const region of await regions(context, execute)) {
    if ("problem" in region) {
      diagnostics.push(region.problem);
      continue;
    }
    if (!region.drift) {
      continue;
    }
    if (!writable.has(region.path)) {
      diagnostics.push(
        entry(
          "docs.generated",
          region.path,
          `Region ${region.region} differs and this file cannot be rewritten.`,
          { line: region.line },
        ),
      );
      continue;
    }
    const content = [
      ...region.lines.slice(0, region.start + 1),
      ...region.expected,
      ...region.lines.slice(region.end),
    ].join(region.eol);
    writeFileSync(safePath(context.root, region.path), content);
    written.push(region.path);
  }
  return { diagnostics, written };
}
