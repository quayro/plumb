import { existsSync } from "node:fs";
import { delimiter, join, posix } from "node:path";

import type { Config } from "./config.ts";
import type { Context } from "./context.ts";
import type { Diagnostic, Rule } from "./diagnostics.ts";
import { type Execute, executeSteps, run, type Step } from "./process.ts";

type Tool = "prisma" | "shfmt" | "sql-formatter" | "taplo";

type Entry = NonNullable<NonNullable<Config["format"]>["tools"]>[number];

type ToolContext = Pick<Context, "root" | "config" | "files" | "matches" | "read"> &
  Partial<Pick<Context, "ownedFiles" | "allFiles">>;

// pinned external formatters a policy opts into; they run through the same version-checked steps as
// native tools

const KINDS: Record<Tool, string> = {
  prisma: "prisma",
  shfmt: "shell",
  "sql-formatter": "sql",
  taplo: "toml",
};
// each tool exits 1 for a parse error as well as a difference; only output that shows a difference
// is a violation
const DIFFERENCE: Record<Tool, RegExp> = {
  prisma: /unformatted files/i,
  shfmt: /^@@ /m,
  "sql-formatter": /not (?:properly )?formatted|needs formatting|would be reformatted/i,
  taplo: /not properly formatted/i,
};

const isTool = (name: string): name is Tool => Object.hasOwn(KINDS, name);

export const RULES: Rule[] = Object.values(KINDS).map((kind) => ({
  id: `format.${kind}`,
  description: `Selected ${kind} files match their pinned formatter.`,
  remedy: "Run plumb fix; a file the formatter cannot parse must be corrected first.",
  suppressible: false,
}));

const entries = (ctx: ToolContext): Entry[] => ctx.config.format?.tools ?? [];

const selected = (ctx: ToolContext, entry: Entry): string[] => {
  const owned = new Set(ctx.ownedFiles ?? []);
  return ctx.files
    .filter(
      (path) =>
        !owned.has(path) &&
        ctx.matches(entry.files, path) &&
        !ctx.config.format?.ignore?.some((ignore) => ctx.matches(ignore.path, path)),
    )
    .sort();
};

const pinned = (ctx: ToolContext, entry: Entry): boolean =>
  Boolean(ctx.config.tools?.versions?.[entry.tool]);

// prisma formats a whole schema folder, so a folder holding any schema file it must not touch is
// refused
const blockedFolders = (ctx: ToolContext, entry: Entry, files: string[]): string[] =>
  entry.tool !== "prisma"
    ? []
    : [...new Set(files.map((file) => posix.dirname(file)))].filter((folder) =>
        (ctx.allFiles ?? ctx.files).some(
          (file) =>
            file.endsWith(".prisma") && posix.dirname(file) === folder && !files.includes(file),
        ),
      );

export const formatToolFiles = (ctx: ToolContext): string[] =>
  [...new Set(entries(ctx).flatMap((entry) => selected(ctx, entry)))].sort();

const binary = (ctx: ToolContext, tool: string, path: string | undefined): string => {
  for (const folder of (path ?? "").split(delimiter).filter(Boolean)) {
    if (existsSync(join(folder, tool))) {
      return join(folder, tool);
    }
  }
  const local = join(ctx.root, "node_modules", ".bin", tool);
  return existsSync(local) ? local : tool;
};

export function formatToolSteps(
  ctx: ToolContext,
  mode: string,
  {
    path = process.env.PATH,
    resolve = (tool: string) => binary(ctx, tool, path),
  }: { path?: string; resolve?: (tool: string) => string } = {},
): Step[] {
  const fix = mode === "fix";
  return entries(ctx).flatMap((entry): Step[] => {
    const files = selected(ctx, entry),
      bin = resolve(entry.tool),
      relative = files.map((file) => `./${file}`);
    if (!files.length || !pinned(ctx, entry)) {
      return [];
    }
    const kind = KINDS[entry.tool];
    const step = (command: string[], checked = files, env?: Record<string, string>): Step => ({
      id: `format.${kind}`,
      rule: `format.${kind}`,
      tool: entry.tool,
      path: ".",
      cwd: ctx.root,
      command: [bin, ...command],
      versionCommand: [bin, "--version"],
      fix,
      files: checked,
      ...(env ? { env } : {}),
    });
    if (entry.tool === "prisma") {
      // a multi-file schema only parses as a folder; the env keeps prisma from checking for updates
      // over the network
      const blocked = blockedFolders(ctx, entry, files),
        folders = [...new Set(files.map((file) => posix.dirname(file)))].filter(
          (folder) => !blocked.includes(folder),
        );
      return folders.map((folder) =>
        step(
          ["format", ...(fix ? [] : ["--check"]), "--schema", `./${folder}`],
          files.filter((file) => posix.dirname(file) === folder),
          { CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" },
        ),
      );
    }
    if (entry.tool === "shfmt") {
      return [step(["-i", "2", fix ? "-w" : "-d", ...relative])];
    }
    // sql-formatter has no --check: it prints the formatted file, which must equal the file's bytes
    if (entry.tool === "sql-formatter") {
      return relative.map((file, index) => ({
        ...step(
          ["--language", entry.dialect ?? "postgresql", ...(fix ? ["--fix"] : []), file],
          [files[index] ?? ""],
        ),
        ...(fix ? {} : { stdoutMatches: ctx.read(files[index] ?? "") ?? "" }),
      }));
    }
    return [step(["fmt", ...(fix ? [] : ["--check"]), ...relative])];
  });
}

export async function checkFormatTools(
  ctx: ToolContext,
  execute: Execute = run,
  mode = "check",
): Promise<{ diagnostics: Diagnostic[]; versions: Record<string, string> }> {
  const refused = (
    entry: Entry,
    message: string,
    remedy: string,
    rule = `format.${KINDS[entry.tool]}`,
  ): Diagnostic => ({
    rule,
    path: ".",
    status: "incomplete",
    suppressible: false,
    message,
    remedy,
  });
  const refusals = entries(ctx).flatMap((entry) => {
    const files = selected(ctx, entry);
    if (!files.length) {
      return [
        refused(
          entry,
          `format.tools ${entry.tool} (${entry.files.join(", ")}) matches no selected files.`,
          "Correct the globs or remove the entry from plumb.json.",
        ),
      ];
    }
    if (!pinned(ctx, entry)) {
      return [
        refused(
          entry,
          `format.tools ${entry.tool} has no pinned version.`,
          `Pin ${entry.tool} in tools.versions.`,
          "tools.version",
        ),
      ];
    }
    return blockedFolders(ctx, entry, files).map((folder) =>
      refused(
        entry,
        `prisma formats all of ${folder}, which holds a schema file that is excluded, ignored or not selected.`,
        "Select every schema file in the folder, or move the protected one out.",
      ),
    );
  });
  const result = await executeSteps(ctx, formatToolSteps(ctx, mode), execute);
  const tool = (rule: string): Tool | undefined =>
    Object.keys(KINDS)
      .filter(isTool)
      .find((name) => `format.${KINDS[name]}` === rule);
  const diagnostics = result.diagnostics.map((item): Diagnostic => {
    const name = tool(item.rule);
    return item.status === "violation" && name && !DIFFERENCE[name].test(item.message)
      ? {
          ...item,
          status: "incomplete",
          remedy: "The formatter could not read the file; correct its syntax and rerun.",
        }
      : item;
  });
  return {
    diagnostics: [...refusals, ...diagnostics.map((item) => ({ ...item, check: "format-tools" }))],
    versions: result.versions,
  };
}
