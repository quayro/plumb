import { resolve } from "node:path";

import { ESLint } from "eslint";
import ts from "typescript";

import { statusOf } from "../../src/adapter-plan.ts";
import type { Project } from "../../src/config.ts";
import type { Context } from "../../src/context.ts";
import type { Diagnostic } from "../../src/diagnostics.ts";
import {
  type Coverage,
  diagnostic,
  location,
  owned,
  scripts,
  type TypedCoverage,
} from "./adapter-shared.ts";
import { createConfig } from "./eslint/index.ts";
import type { PackOptions } from "./eslint/options.ts";
import { strictCompilerOptions, typedRuntime } from "./eslint/typed.ts";
import type { ModuleResolver } from "./shared/module-resolver.ts";
import type { Analysis } from "./src/analysis.ts";

export async function lint(
  ctx: Context,
  project: Project,
  options: PackOptions,
  analysis: Analysis,
): Promise<{
  diagnostics: Diagnostic[];
  coverage: Coverage;
  typedCoverage: TypedCoverage;
}> {
  const root = ctx.safePath(project.root),
    results: Diagnostic[] = [],
    checkedFiles: string[] = [];
  // lint rules resolve with the compiler options of the file they inspect
  const resolver: ModuleResolver = {
    optionsFor: (from) => analysis.options(from),
    resolve: (from, specifier) =>
      analysis.resolver.resolve(from, specifier, analysis.options(from)),
    runtime: (from, specifier) =>
      analysis.resolver.runtime(from, specifier, analysis.options(from)),
    isLocal: (from, specifier) =>
      analysis.resolver.isLocal(from, specifier, analysis.options(from)),
  };
  const selected = ctx.files.filter((path) => owned(ctx, project, path) && scripts.test(path));
  const typed = typedRuntime(analysis, project, selected);
  const linter = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: createConfig(
      {
        ...options,
        root,
        profile: project.profile === "react" ? "react" : "backend",
      },
      { resolver, ...typed, preset: ctx.config.preset },
    ),
    fix: false,
    cache: false,
  });
  for (const file of selected) {
    const reports = await linter.lintText(ctx.read(file) ?? "", {
      filePath: ctx.safePath(file),
      warnIgnored: true,
    });
    if (!reports.length) {
      results.push(
        diagnostic(
          "javascript/config",
          file,
          "ESLint returned no coverage for this source file.",
          "Correct the language scope; every selected file must be checked.",
          true,
        ),
      );
    } else {
      checkedFiles.push(file);
    }
    for (const report of reports) {
      for (const item of report.messages) {
        const incomplete = item.fatal || !item.ruleId || item.messageId === "unresolved";
        results.push({
          ...diagnostic(
            item.ruleId ? `javascript/${item.ruleId}` : "javascript/config",
            file,
            item.message,
            incomplete
              ? "Correct the source, resolution or language configuration so the complete file can be checked."
              : "Resolve the violation in source, or propose a narrow, reasoned exception for review.",
            incomplete,
          ),
          line: item.line ?? 1,
          column: item.column ?? 1,
          ...(item.ruleId === "plumb/directive" ? { suppressible: false } : {}),
        });
      }
    }
  }
  return {
    diagnostics: results,
    coverage: {
      id: `javascript.lint:${project.root}`,
      checkedFiles,
      status: statusOf(results),
    },
    typedCoverage: {
      root: project.root,
      typedFiles: typed.typedFiles,
      syntaxOnlyFiles: typed.syntaxOnlyFiles,
    },
  };
}

export const strictOptions = strictCompilerOptions;

export function types(
  ctx: Context,
  project: Project,
  analysis: Analysis,
): { diagnostics: Diagnostic[]; coverage: Coverage } {
  const diagnostics: Diagnostic[] = [],
    covered = new Set<string>();
  for (const config of project.tsconfigs ?? ["tsconfig.json"]) {
    const path = location(ctx, resolve(ctx.root, project.root, config));
    const parsed = analysis.compilerConfig(path);
    const options: ts.CompilerOptions = {
      ...parsed.options,
      ...strictOptions,
      noEmit: true,
      incremental: false,
      composite: false,
    };
    for (const [key, expected] of Object.entries(strictOptions)) {
      if (parsed.options[key] !== undefined && parsed.options[key] !== expected) {
        diagnostics.push(
          diagnostic(
            "javascript/config",
            path,
            `${key} conflicts with Plumb's strict compiler policy.`,
            `Use ${key}: ${expected}; strict defaults are applied by the checker.`,
            true,
          ),
        );
      }
    }
    const [first] = parsed.fileNames;
    if (first === undefined) {
      diagnostics.push(
        diagnostic(
          "javascript/config",
          path,
          "The TypeScript project selects no source files.",
          "Correct its include/files settings.",
          true,
        ),
      );
      continue;
    }
    const program = analysis.program(
      location(ctx, first),
      [],
      options,
      parsed.fileNames,
      parsed.projectReferences,
    );
    for (const file of program.getSourceFiles()) {
      covered.add(location(ctx, file.fileName));
    }
    for (const item of ts.getPreEmitDiagnostics(program)) {
      const position =
        item.file && item.start !== undefined
          ? item.file.getLineAndCharacterOfPosition(item.start)
          : null;
      const incomplete = !item.file || [2307, 2688, 6053, 6305, 6306, 6310].includes(item.code);
      diagnostics.push({
        ...diagnostic(
          "javascript/types",
          item.file ? location(ctx, item.file.fileName) : path,
          `TS${item.code}: ${ts.flattenDiagnosticMessageText(item.messageText, "\n")}`,
          incomplete
            ? "Restore the missing input, prepare referenced declarations, or correct the compiler configuration; check never emits build files."
            : "Fix the reported type error; check never emits build files.",
          incomplete,
        ),
        ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
      });
    }
  }
  for (const file of ctx.files.filter(
    (path) => owned(ctx, project, path) && /\.[cm]?tsx?$/.test(path),
  )) {
    if (!covered.has(file)) {
      diagnostics.push(
        diagnostic(
          "javascript/config",
          file,
          "Selected TypeScript source is outside every configured type-checking program.",
          "Include this source in a configured tsconfig; exclusions cannot silently remove type coverage.",
          true,
        ),
      );
    }
  }
  const selected = ctx.files.filter(
    (path) => owned(ctx, project, path) && /\.[cm]?tsx?$/.test(path),
  );
  return {
    diagnostics,
    coverage: {
      id: `javascript.types:${project.root}`,
      checkedFiles: selected.filter((file) => covered.has(file)),
      status: diagnostics.length
        ? statusOf(diagnostics)
        : selected.length
          ? "pass"
          : "not-applicable",
    },
  };
}
