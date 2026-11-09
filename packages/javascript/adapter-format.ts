import { readFileSync, writeFileSync } from "node:fs";

import prettier from "prettier";

import { statusOf } from "../../src/adapter-plan.ts";
import { alignMarkdownTables } from "../../src/align.ts";
import type { Context } from "../../src/context.ts";
import type { Diagnostic } from "../../src/diagnostics.ts";
import { errorMessage } from "../../src/errors.ts";
import { isRecord } from "../../src/schema.ts";
import { type Coverage, diagnostic } from "./adapter-shared.ts";

export async function format(
  ctx: Context,
  write: boolean,
): Promise<{
  diagnostics: Diagnostic[];
  written: string[];
  coverage: Coverage;
}> {
  const diagnostics: Diagnostic[] = [],
    written: string[] = [],
    checkedFiles: string[] = [],
    notApplicable: { path: string; reason: string }[] = [];
  const owned = new Set(ctx.ownedFiles ?? []),
    writable = new Set(ctx.writableFiles ?? ctx.files);
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("./assets/prettier.json", import.meta.url), "utf8"),
  );
  const { $schema: _schema, ...options } = isRecord(parsed) ? parsed : {};
  for (const path of ctx.files) {
    if (
      owned.has(path) ||
      (write && !writable.has(path)) ||
      ctx.config.format?.ignore?.some((entry) => ctx.matches(entry.path, path))
    ) {
      continue;
    }
    try {
      const target = ctx.safePath(path),
        info = await prettier.getFileInfo(target, { resolveConfig: false });
      if (info.ignored) {
        throw new Error(
          "Prettier ignored a selected format input; declare an explicit reviewed Plumb exclusion",
        );
      }
      if (!info.inferredParser) {
        notApplicable.push({
          path,
          reason: "The pack's formatter has no parser for this file type.",
        });
        continue;
      }
      const before = ctx.read(path) ?? "",
        printed = await prettier.format(before, {
          ...options,
          filepath: target,
          parser: info.inferredParser,
        });
      const after =
        info.inferredParser === "markdown" && ctx.config.preset === "ozmikhail"
          ? alignMarkdownTables(printed)
          : printed; // the core table layout, chained after Prettier so the two never fight
      checkedFiles.push(path);
      if (before === after) {
        continue;
      }
      if (write) {
        writeFileSync(target, after);
        written.push(path);
      } else {
        diagnostics.push(
          diagnostic(
            "javascript/format",
            path,
            "File differs from the pack's formatting policy.",
            writable.has(path)
              ? "Run plumb fix and review the source formatting."
              : "Format this policy or snapshot explicitly and review it; fix does not alter enforcement inputs.",
          ),
        );
      }
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "javascript/format",
          path,
          errorMessage(error),
          "Correct the syntax before formatting.",
          true,
        ),
      );
    }
  }
  return {
    diagnostics,
    written,
    coverage: {
      id: "javascript.format:.",
      checkedFiles,
      notApplicable,
      status: diagnostics.length
        ? statusOf(diagnostics)
        : checkedFiles.length
          ? "pass"
          : "not-applicable",
    },
  };
}
