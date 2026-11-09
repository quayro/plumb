import { type Coverage, validateCoverage } from "./adapter-coverage.ts";
import { externalRun } from "./adapter-external.ts";
import { type CoverageRecord, nativeRun, type ToolIdentity } from "./adapter-native.ts";
import {
  type AdapterPlan,
  issue,
  needsJavascript,
  planAdapters,
  type PlanContext,
  registryAdapters,
  RULES,
  statusOf,
} from "./adapter-plan.ts";
import { type AdapterRegistry, registryIdentity } from "./adapter-registry.ts";
import type { Context } from "./context.ts";
import type { Diagnostic, Rule } from "./diagnostics.ts";
import { errorMessage } from "./errors.ts";
import { canonical } from "./files.ts";
import { type Execute, run } from "./process.ts";
import { isRecord } from "./schema.ts";

export { validateCoverage } from "./adapter-coverage.ts";
export {
  needsJavascript,
  planAdapters,
  profileFamily,
  profileSource,
  projectFiles,
  RULES,
  sourceProfiles,
} from "./adapter-plan.ts";

// the optional JavaScript pack, as the engine loads it
export interface JavascriptPack {
  identity?: unknown;
  rules: () => Rule[] | Promise<Rule[]>;
  check: (
    ctx: Context,
    checks: AdapterPlan["checks"],
  ) => Promise<{
    diagnostics: Diagnostic[];
    coverage?: CoverageRecord[];
    versions?: Record<string, string>;
    typedCoverage?: unknown[];
  }>;
  doctor?: (
    ctx: Context,
  ) => Promise<{ diagnostics?: Diagnostic[]; versions?: Record<string, string> }>;
  fix: (ctx: Context) => Promise<{ diagnostics: Diagnostic[]; written: string[] }>;
  snapshot: (
    ctx: Context,
    project: string | undefined,
  ) => Promise<{ path: string; content: string }[]>;
  surfaceSnapshotIsValid: (value: unknown) => boolean;
}

export interface AdapterOptions {
  registry?: AdapterRegistry;
  loadJavascript?: () => Promise<JavascriptPack>;
  execute?: Execute;
}

interface RunIdentity {
  registry: unknown;
  native: ToolIdentity[];
  javascript?: unknown;
}

export interface AdapterResult {
  diagnostics: Diagnostic[];
  checks: {
    id: string;
    adapter: string;
    root: string;
    capability: string;
    status: string;
    files: string[];
    evidence: string;
  }[];
  coverage: Coverage[];
  typedCoverage?: unknown[];
  versions: Record<string, string>;
  rules: Rule[];
  identity: RunIdentity;
}

export interface DoctorCheck {
  id: string;
  status: string;
  evidence?: string;
  root?: string;
  checkedFiles?: string[];
}

export interface Suggestion {
  project: { root: string; profile: string; compileCommands?: string };
  files: string[];
  reason: string;
}

export async function runAdapters(
  ctx: Context & PlanContext,
  plan: AdapterPlan,
  { registry, loadJavascript, execute = run }: AdapterOptions = {},
): Promise<AdapterResult> {
  const diagnostics: Diagnostic[] = [...plan.diagnostics],
    coverage: CoverageRecord[] = [],
    typedCoverage: unknown[] = [],
    checks: AdapterResult["checks"] = [],
    versions: Record<string, string> = {},
    rules: Rule[] = [...RULES],
    identity: RunIdentity = { registry: registryIdentity(registry), native: [] };
  const mergeVersions = (source: Record<string, string> | undefined): void => {
    for (const [name, value] of Object.entries(source ?? {})) {
      versions[name] ??= value;
    }
  };
  if (needsJavascript(ctx.config)) {
    try {
      if (!loadJavascript) {
        throw new Error("Install and supply the matching JavaScript adapter");
      }
      const pack = await loadJavascript();
      rules.push(...(await pack.rules()));
      identity.javascript = pack.identity ?? { source: "injected" };
      const result = await pack.check(
        ctx,
        plan.checks.filter((check) => check.adapter === "javascript"),
      );
      diagnostics.push(...result.diagnostics);
      coverage.push(...(result.coverage ?? []));
      mergeVersions(result.versions);
      typedCoverage.push(...(result.typedCoverage ?? []));
    } catch (error) {
      diagnostics.push(issue("tools.missing", ".", errorMessage(error)));
    }
  }
  for (const project of ctx.config.projects) {
    if (["typescript", "react"].includes(project.profile)) {
      continue;
    }
    const expected = plan.checks.filter(
      (check) => check.adapter === project.profile && check.root === project.root,
    );
    if (["ruby", "cpp"].includes(project.profile)) {
      const result = await nativeRun(ctx, project, execute, false);
      diagnostics.push(...result.diagnostics);
      coverage.push(...result.coverage);
      mergeVersions(result.versions);
      identity.native.push(...result.identities);
    } else {
      const entry = registryAdapters(registry).find((adapter) => adapter.id === project.profile);
      if (!entry || !registry) {
        continue;
      }
      rules.push(...entry.rules);
      try {
        if (canonical(registryIdentity(registry)) !== canonical(plan.identity)) {
          throw new Error("The adapter environment changed after planning");
        }
        const result = await externalRun(ctx, project, entry, registry, execute, false);
        diagnostics.push(...result.diagnostics);
        coverage.push(...result.coverage);
        mergeVersions(result.versions);
        if (canonical(registryIdentity(registry)) !== canonical(plan.identity)) {
          throw new Error("The adapter environment changed while checking");
        }
      } catch (error) {
        for (const check of expected) {
          const row = coverage.find((item) => item.id === check.id);
          if (row) {
            row.status = "incomplete";
          }
        }
        diagnostics.push(issue("adapters.protocol", project.root, errorMessage(error)));
      }
    }
  }
  // the pack reports its own rows, so a malformed row passes through to coverage validation
  const outcomes = coverage.map((row): unknown => {
    if (!isRecord(row)) {
      return row;
    }
    if (!["pass", "violation", "incomplete", "not-applicable"].includes(row.status)) {
      return row;
    }
    const found = diagnostics.filter((item) => item.check === row.id);
    if (found.length && (row.status !== "incomplete" || statusOf(found) === "incomplete")) {
      return { ...row, status: statusOf(found) };
    }
    if (["violation", "incomplete"].includes(row.status)) {
      diagnostics.push(
        issue(
          "adapters.protocol",
          ".",
          `Check ${row.id} reported ${row.status} without a matching diagnostic.`,
          row.id,
        ),
      );
      return { ...row, status: "incomplete" };
    }
    return row;
  });
  const validated = validateCoverage(plan.checks, outcomes);
  diagnostics.push(...validated.diagnostics);
  for (const item of validated.coverage) {
    checks.push({
      id: item.id,
      adapter: item.adapter,
      root: item.root,
      capability: item.capability,
      status: item.status,
      files: item.checkedFiles,
      evidence: item.evidence,
    });
  }
  return {
    diagnostics,
    checks,
    coverage: validated.coverage,
    ...(typedCoverage.length ? { typedCoverage } : {}),
    versions,
    rules: [...new Map(rules.map((rule) => [rule.id, rule])).values()],
    identity,
  };
}

export async function doctorAdapters(
  ctx: Context & PlanContext,
  { registry, loadJavascript, execute = run }: AdapterOptions = {},
): Promise<{
  diagnostics: Diagnostic[];
  checks: DoctorCheck[];
  versions: Record<string, string>;
  identity: RunIdentity;
  plan: AdapterPlan;
  suggestions: Suggestion[];
}> {
  const plan = planAdapters(ctx, { registry }),
    diagnostics: Diagnostic[] = [...plan.diagnostics],
    versions: Record<string, string> = {},
    identity: RunIdentity = { registry: registryIdentity(registry), native: [] },
    checks: DoctorCheck[] = [];
  if (needsJavascript(ctx.config)) {
    try {
      if (!loadJavascript) {
        throw new Error("Install the matching JavaScript adapter");
      }
      const pack = await loadJavascript();
      identity.javascript = pack.identity ?? { source: "injected" };
      if (typeof pack.doctor !== "function") {
        throw new Error("The JavaScript pack does not provide a prerequisite probe");
      }
      const result = await pack.doctor(ctx);
      diagnostics.push(...(result.diagnostics ?? []));
      Object.assign(versions, result.versions);
      checks.push({
        id: "javascript",
        status: result.diagnostics?.length ? statusOf(result.diagnostics) : "ready",
        evidence: "prerequisites-only",
      });
    } catch (error) {
      diagnostics.push(issue("tools.missing", ".", errorMessage(error)));
    }
  }
  for (const project of ctx.config.projects) {
    if (["ruby", "cpp"].includes(project.profile)) {
      const result = await nativeRun(ctx, project, execute, true);
      diagnostics.push(...result.diagnostics);
      checks.push(...result.coverage);
      Object.assign(versions, result.versions);
      identity.native.push(...result.identities);
    } else if (!["typescript", "react"].includes(project.profile)) {
      const entry = registryAdapters(registry).find((adapter) => adapter.id === project.profile);
      if (!entry || !registry) {
        continue;
      }
      try {
        const result = await externalRun(ctx, project, entry, registry, execute, true);
        diagnostics.push(...result.diagnostics);
        Object.assign(versions, result.versions);
        checks.push({
          id: entry.id,
          root: project.root,
          status: result.diagnostics.length ? statusOf(result.diagnostics) : "ready",
          evidence: "prerequisites-only",
        });
      } catch (error) {
        diagnostics.push(issue("adapters.protocol", project.root, errorMessage(error)));
      }
    }
  }
  const suggestions: Suggestion[] = [];
  const profiles: [string, RegExp][] = [
    ["typescript", /\.[cm]?[jt]sx?$/],
    ["ruby", /\.(rb|rake|gemspec)$|(?:^|\/)(Gemfile|Rakefile)$/],
    ["cpp", /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/],
    ["python", /\.py$/],
    ["go", /\.go$/],
    ["rust", /\.rs$/],
  ];
  for (const [profile, pattern] of profiles) {
    const files = plan.files
      .filter((file) => !file.excluded && !file.owners.length && pattern.test(file.path))
      .map((file) => file.path);
    if (files.length) {
      suggestions.push({
        project: { root: ".", profile, ...(profile === "cpp" ? { compileCommands: "build" } : {}) },
        files,
        reason:
          registryAdapters(registry).some((entry) => entry.id === profile) ||
          ["typescript", "ruby", "cpp"].includes(profile)
            ? "Review a project profile for these unowned source files."
            : "Install an approved external adapter, then review this project profile.",
      });
    }
  }
  return { diagnostics, checks, versions, identity, plan, suggestions };
}
