import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Diagnostic } from "../src/diagnostics.ts";
import { checkDocs } from "../src/docs.ts";
import { inventory } from "../src/files.ts";
import { policy } from "./support.ts";

// writes a repository, then checks its documentation with the files the engine would inventory
export async function docs(
  contents: Record<string, string>,
  config: Record<string, unknown> = { preset: "portable", docs: {} },
  options?: Parameters<typeof checkDocs>[1],
): Promise<Diagnostic[]> {
  const root = mkdtempSync(join(tmpdir(), "plumb-docs-"));
  try {
    for (const [path, content] of Object.entries(contents)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await checkDocs({ root, files: inventory(root).files, config: policy(config) }, options);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const summary = (problems: readonly Diagnostic[]): (string | undefined)[][] =>
  problems.map(({ rule, path, message }) => [rule, path, message]);

export const rules = (problems: readonly Diagnostic[]): string[] =>
  problems.map(({ rule }) => rule);

export const adr = {
  preset: "portable",
  docs: {
    kinds: [
      {
        files: ["docs/decisions/*.md"],
        exclude: ["docs/decisions/index.md"],
        name: "^\\d{4}-[a-z0-9-]+\\.md$",
        sections: ["Status", "Context", "Decision", "Consequences"],
        status: ["Proposed", "Accepted", "Superseded", "Deprecated"],
        sequence: true,
      },
    ],
  },
};

export const record = (title: string, status = "Status: Accepted"): string =>
  `# ${title}\n\n${status}\n\n## Context\n\nC\n\n## Decision\n\nD\n\n## Consequences\n\nQ\n`;

export const generated = (
  command = [process.execPath, "-e", "process.stdout.write('usage: plumb\\n')"],
): Record<string, unknown> => ({
  preset: "portable",
  docs: { generated: [{ file: "docs/reference.md", region: "cli", command }] },
});

export const region = (body: string): string =>
  `# Reference\n\n<!-- plumb:generated cli -->\n${body}\n<!-- /plumb:generated -->\n`;
