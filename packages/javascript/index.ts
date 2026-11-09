import { join, relative, resolve } from "node:path";

import { type PlannedCheck, statusOf } from "../../src/adapter-plan.ts";
import { planAdapters } from "../../src/adapters.ts";
import type { Project } from "../../src/config.ts";
import type { Context } from "../../src/context.ts";
import type { Diagnostic, Rule } from "../../src/diagnostics.ts";
import { errorMessage } from "../../src/errors.ts";
import { executeSteps, type Step } from "../../src/process.ts";
import { isRecord } from "../../src/schema.ts";
import { lint, strictOptions, types } from "./adapter-checks.ts";
import { dependencyProblems } from "./adapter-dependencies.ts";
import { format } from "./adapter-format.ts";
import {
  type CheckRow,
  type Coverage,
  diagnostic,
  knipConfiguration,
  location,
  owned,
  scripts,
  toolVersions,
  type TypedCoverage,
} from "./adapter-shared.ts";
import { getRuleMetadata, scopeProblems, validateOptions } from "./eslint/index.ts";
import type { PackOptions } from "./eslint/options.ts";
import { Analysis } from "./src/analysis.ts";
import {
  check as semanticCheck,
  RULES as SEMANTIC_RULES,
  snapshot as semanticSnapshot,
} from "./src/index.ts";

const ADAPTER_RULES: Rule[] = [
  {
    id: "javascript/format",
    description: "Source follows the pack's formatter policy.",
    remedy: "Run plumb fix and review the formatting change.",
  },
  {
    id: "javascript/types",
    description: "TypeScript passes strict checking without emitting files.",
    remedy: "Fix the reported type error.",
  },
  {
    id: "javascript/config",
    description: "Language policy uses supported data-only configuration.",
    remedy: "Correct the language configuration; executable policy is not loaded.",
    suppressible: false,
  },
  {
    id: "javascript/dependencies",
    description:
      "ozmikhail dependency policy: exact versions, a pinned packageManager, a root lockfile and an optional allow-list.",
    remedy:
      "Pin the exact version, remove the refused specifier, or review the dependency allow-list change.",
    suppressible: false,
  },
  {
    id: "javascript/knip",
    description: "Configured dead-code, dependency and cycle checks complete.",
    remedy: "Resolve the dead-code or dependency diagnostic.",
    suppressible: false,
  },
];

export const rules = (): Rule[] => [...getRuleMetadata(), ...SEMANTIC_RULES, ...ADAPTER_RULES];

export const snapshot = (
  context: Context,
  projectRoot?: string,
): { path: string; content: string }[] => semanticSnapshot(context, projectRoot);

export { surfaceSnapshotIsValid } from "./src/exports.ts";

export const plan = (ctx: Context): PlannedCheck[] =>
  planAdapters(ctx).checks.filter((check) => check.adapter === "javascript");

function validated(options: unknown): PackOptions {
  for (const key of ["root", "profile"]) {
    if (isRecord(options) && key in options) {
      throw new Error(`javascript.${key} is set by projects, not by rule options`);
    }
  }
  validateOptions(options);
  return options;
}

// a project's own javascript block replaces the top-level one for that project
function optionsOf(ctx: Context, project?: Project): PackOptions {
  const own = project?.javascript;
  if (!own || !project) {
    return validated(ctx.config.javascript ?? {});
  }
  try {
    if ("dependencies" in own) {
      throw new Error("javascript.dependencies is repo-wide; set it in the top-level block");
    }
    return validated(own);
  } catch (error) {
    throw new Error(`projects ${project.root}: ${errorMessage(error)}`, { cause: error });
  }
}

export function doctor(ctx: Context): {
  diagnostics: Diagnostic[];
  versions: Record<string, string>;
} {
  const diagnostics: Diagnostic[] = [],
    versions = toolVersions();
  optionsOf(ctx);
  const analysis = new Analysis(ctx);
  for (const project of ctx.config.projects.filter((entry) =>
    ["typescript", "react"].includes(entry.profile),
  )) {
    optionsOf(ctx, project);
    try {
      for (const config of project.tsconfigs ?? ["tsconfig.json"]) {
        const parsed = analysis.compilerConfig(
          location(ctx, resolve(ctx.root, project.root, config)),
        );
        for (const [key, expected] of Object.entries(strictOptions)) {
          if (parsed.options[key] !== undefined && parsed.options[key] !== expected) {
            throw new Error(`${key} conflicts with Plumb's strict compiler policy`);
          }
        }
      }
      if (project.knip) {
        versions.knip = knipConfiguration(ctx, project).info.version;
      }
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "javascript/config",
          project.root,
          errorMessage(error),
          "Restore the declared configuration or install its pinned tools before checking.",
          true,
        ),
      );
    }
  }
  return { diagnostics, versions };
}

export async function check(
  ctx: Context,
  planned: readonly PlannedCheck[] = plan(ctx),
): Promise<{
  diagnostics: Diagnostic[];
  checks: CheckRow[];
  versions: Record<string, string>;
  coverage: Coverage[];
  typedCoverage: TypedCoverage[];
}> {
  const options = optionsOf(ctx),
    diagnostics: Diagnostic[] = [],
    checks: CheckRow[] = [],
    coverage: Coverage[] = [],
    typedCoverage: TypedCoverage[] = [],
    versions = toolVersions();
  const projects = ctx.config.projects.filter((project) =>
    ["typescript", "react"].includes(project.profile),
  );
  // validated before any check runs, as the top-level block is
  const own = new Map(projects.map((project) => [project, optionsOf(ctx, project)]));
  const optionsFor = (project: Project): PackOptions => own.get(project) ?? options;
  const analysis = new Analysis(ctx);
  const semantic = semanticCheck(ctx, analysis);
  diagnostics.push(...semantic.map((item) => ({ ...item, check: "javascript.contracts:." })));
  const semanticFiles = planned.find((entry) => entry.id === "javascript.contracts:.")?.files ?? [];
  const inspected = semanticFiles.filter((file) => analysis.sources.has(file));
  coverage.push({
    id: "javascript.contracts:.",
    checkedFiles: inspected,
    notApplicable: semanticFiles
      .filter((file) => !analysis.sources.has(file))
      .map((path) => ({
        path,
        reason: "No direct semantic source inspection was required for this file.",
      })),
    status: semantic.length ? statusOf(semantic) : inspected.length ? "pass" : "not-applicable",
  });
  if (ctx.config.preset === "ozmikhail") {
    diagnostics.push(
      ...dependencyProblems(ctx, options, projects).map((item) => ({
        ...item,
        check: "javascript.dependencies:.",
      })),
    );
  }
  const scopedFiles = (members: readonly Project[]): string[] =>
    members.flatMap((project) =>
      ctx.files
        .filter((file) => owned(ctx, project, file) && scripts.test(file))
        .map((file) =>
          relative(ctx.safePath(project.root), ctx.safePath(file)).replaceAll("\\", "/"),
        ),
    );
  // each block's scopes must match source in the projects it governs
  const policy = [
    ...scopeProblems(options, scopedFiles(projects.filter((project) => !project.javascript))),
    ...projects
      .filter((project) => project.javascript)
      .flatMap((project) =>
        scopeProblems(optionsFor(project), scopedFiles([project])).map(
          (message) => `projects ${project.root}: ${message}`,
        ),
      ),
  ].map((message) => ({
    ...diagnostic(
      "javascript/config",
      "plumb.json",
      message,
      "Correct the declared rule scope; a configured contract cannot silently match nothing.",
      true,
    ),
    check: "javascript.policy:.",
  }));
  diagnostics.push(...policy);
  coverage.push({
    id: "javascript.policy:.",
    checkedFiles: [],
    status: statusOf(policy),
  });
  for (const project of projects) {
    try {
      const result = await lint(ctx, project, optionsFor(project), analysis);
      diagnostics.push(
        ...result.diagnostics.map((item) => ({
          ...item,
          check: result.coverage.id,
        })),
      );
      coverage.push(result.coverage);
      typedCoverage.push(result.typedCoverage);
    } catch (error) {
      diagnostics.push({
        ...diagnostic(
          "javascript/config",
          project.root,
          `ESLint: ${errorMessage(error)}`,
          "Correct the trusted language policy and rerun.",
          true,
        ),
        check: `javascript.lint:${project.root}`,
      });
    }
    try {
      const result = types(ctx, project, analysis);
      diagnostics.push(
        ...result.diagnostics.map((item) => ({
          ...item,
          check: result.coverage.id,
        })),
      );
      coverage.push(result.coverage);
    } catch (error) {
      diagnostics.push({
        ...diagnostic(
          "javascript/config",
          project.root,
          `TypeScript: ${errorMessage(error)}`,
          "Correct the TypeScript project and rerun.",
          true,
        ),
        check: `javascript.types:${project.root}`,
      });
    }
    if (project.knip) {
      try {
        const { cwd, configPath, info, bin } = knipConfiguration(ctx, project);
        versions.knip = info.version;
        const runtime = process.versions.bun ? "node" : process.execPath;
        const steps: Step[] = [
          [],
          [
            "--production",
            "--include",
            optionsFor(project).knip?.exports
              ? "files,dependencies,unlisted,unresolved,exports,types"
              : "files,dependencies,unlisted,unresolved",
          ],
          ["--include", "cycles"],
        ].map((args, index) => ({
          id: `knip.${project.root}.${index + 1}`,
          rule: "javascript/knip",
          path: project.root,
          cwd,
          command: [
            runtime,
            join(info.root, bin),
            "--config",
            configPath,
            "--no-progress",
            ...args,
          ],
          env: { JITI_FS_CACHE: "false" }, // knip loads configs through jiti, whose cache would write into the checked node_modules mid-run
          ...(process.versions.bun ? { tool: "node", versionCommand: [runtime, "--version"] } : {}),
        }));
        const result = await executeSteps(ctx, steps);
        diagnostics.push(...result.diagnostics);
        checks.push(...result.checks);
        Object.assign(versions, result.versions);
        coverage.push(
          ...result.checks.map((item) => ({
            id: item.id,
            checkedFiles: [],
            status: item.status,
          })),
        );
      } catch (error) {
        diagnostics.push(
          diagnostic(
            "javascript/config",
            project.root,
            `Knip: ${errorMessage(error)}`,
            "Install the pinned tool and use data-only configuration.",
            true,
          ),
        );
      }
    }
  }
  if (projects.length) {
    const result = await format(ctx, false);
    diagnostics.push(
      ...result.diagnostics.map((item) => ({
        ...item,
        check: result.coverage.id,
      })),
    );
    coverage.push(result.coverage);
  }
  for (const item of coverage) {
    if (!checks.some((entry) => entry.id === item.id)) {
      checks.push({ id: item.id, status: item.status });
    }
  }
  return { diagnostics, checks, versions, coverage, typedCoverage };
}

export async function fix(ctx: Context): Promise<{
  diagnostics: Diagnostic[];
  written: string[];
  coverage: Coverage;
}> {
  optionsOf(ctx);
  return await format(ctx, true);
}
