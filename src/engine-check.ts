import type { AdapterResult } from "./adapters.ts";
import * as adapters from "./adapters.ts";
import * as assets from "./assets.ts";
import { prepareCache } from "./cache.ts";
import * as comments from "./comments.ts";
import type { Context } from "./context.ts";
import * as contracts from "./contracts.ts";
import * as conventions from "./conventions.ts";
import type { Diagnostic, Report } from "./diagnostics.ts";
import { attachOrigins, enrichDiagnostics } from "./diagnostics.ts";
import * as docs from "./docs.ts";
import { context, type EngineOptions, FIXTURE_RUN } from "./engine-context.ts";
import { checkerIdentity, javascriptPack } from "./engine-pack.ts";
import {
  compare,
  coreRules,
  type EngineCheck,
  executionPlan,
  failure,
  governedComments,
  type PlannedEntry,
  reconcile,
  report,
  sortDiagnostics,
  statusOf,
  validateInputs,
} from "./engine-plan.ts";
import { errorCode, errorMessage } from "./errors.ts";
import { canonical, digest, snapshot } from "./files.ts";
import * as formatTools from "./format-tools.ts";
import * as formatting from "./formatting.ts";
import { applyExceptions } from "./policy.ts";
import * as policyTests from "./policy-tests.ts";
import { versionOf } from "./process.ts";
import { checkPolicyBase, nestedPolicyDiagnostics } from "./ratchet.ts";
import * as tasks from "./task.ts";
import * as verification from "./verification.ts";

interface CoverageRow extends Partial<Omit<PlannedEntry, "id">> {
  id: string;
  checkedFiles: string[];
  status: string;
  completed: boolean;
  suppressed?: number;
  reason?: string;
  notApplicable?: unknown;
}

export async function checkContext(options: EngineOptions): Promise<Report> {
  let ctx: Context;
  try {
    ctx = context(options);
  } catch (error) {
    return report([
      failure("config.invalid", options.configFile ?? "plumb.json", errorMessage(error)),
    ]);
  }
  let before: string;
  try {
    before = snapshot(ctx.root, ctx.allFiles);
  } catch (error) {
    return report([failure("inventory.unsafe", ".", errorMessage(error))]);
  }
  let memo: ReturnType<typeof prepareCache>;
  try {
    memo = prepareCache(ctx, options, checkerIdentity());
  } catch (error) {
    return report([
      failure(
        errorCode(error) === "PLUMB_CACHE_MUTATED" ? "run.mutated" : "config.invalid",
        ".",
        errorMessage(error),
      ),
    ]);
  }
  if (memo?.result) {
    return { ...memo.result, cache: memo.info };
  }
  const subject = options.subjectContext?.subject ?? { kind: "worktree", snapshot: before };
  const plan = executionPlan(ctx, options),
    checks: EngineCheck[] = [],
    coverage: CoverageRow[] = [];
  let diagnostics: Diagnostic[] = [...ctx.problems];
  const metadata = coreRules();
  const tools: Record<string, string> = process.versions.bun
    ? { bun: process.versions.bun }
    : { node: process.versions.node };
  // every id this run executes is planned by executionPlan, so a missing entry is a planning bug
  const plannedFor = (id: string): PlannedEntry => {
    const planned = plan.checks.find((check) => check.id === id);
    if (!planned) {
      throw new Error(`Check ${id} was not planned`);
    }
    return planned;
  };
  const execute = async (
    id: string,
    action: () => Diagnostic[] | Promise<Diagnostic[]>,
    applicable = true,
  ): Promise<void> => {
    const planned = plannedFor(id);
    if (!applicable) {
      checks.push({ id, capability: planned.capability, status: "not-applicable" });
      coverage.push({
        ...planned,
        checkedFiles: [],
        status: "not-applicable",
        completed: false,
        reason: "No configured scope for this check.",
      });
      return;
    }
    let found: Diagnostic[];
    try {
      found = (await action()).map((item) => ({ ...item, check: item.check ?? id }));
    } catch (error) {
      found = [{ ...failure("run.failed", ".", `${id}: ${errorMessage(error)}`), check: id }];
    }
    diagnostics.push(...found);
    const status = statusOf(found);
    checks.push({ id, capability: planned.capability, status });
    coverage.push({
      ...planned,
      checkedFiles: status === "incomplete" ? [] : planned.files,
      status,
      completed: status !== "incomplete",
    });
  };
  await execute("files", async () => [
    ...contracts.checkFiles(ctx),
    ...(docs.docsApplicable(ctx.config)
      ? await docs.checkDocs(ctx, { execute: options.execute })
      : []),
  ]);
  if (ctx.config.conventions) {
    await execute("conventions", () => conventions.checkConventions(ctx, plan.conventions));
  }
  await execute("generated", () => assets.checkAssets(ctx), ctx.ownedFiles.length > 0);
  await execute("comments", () => comments.checkComments(ctx), governedComments(ctx).length > 0);
  await execute(
    "formatting",
    () => formatting.checkFormatting(ctx),
    formatting.formattingFiles(ctx).length > 0,
  );
  await execute(
    "format-tools",
    async () => {
      const result = await formatTools.checkFormatTools(ctx, options.execute);
      Object.assign(tools, result.versions);
      return result.diagnostics;
    },
    (ctx.config.format?.tools ?? []).length > 0,
  );
  let language: AdapterResult = {
    diagnostics: [],
    checks: [],
    coverage: [],
    versions: {},
    rules: [],
    identity: { registry: undefined, native: [] },
  };
  try {
    language = await adapters.runAdapters(ctx, plan.adapterPlan, {
      registry: ctx.registry,
      loadJavascript: options.loadJavascript ?? javascriptPack,
      execute: options.execute,
    });
  } catch (error) {
    language.diagnostics.push(failure("run.failed", ".", `adapters: ${errorMessage(error)}`));
  }
  diagnostics.push(...language.diagnostics);
  metadata.push(...language.rules);
  checks.push(...language.checks);
  coverage.push(...language.coverage);
  Object.assign(tools, language.versions);
  if (!adapters.needsJavascript(ctx.config)) {
    checks.push({ id: "javascript", status: "not-applicable" });
  }
  if (!ctx.config.projects.some((project) => ["ruby", "cpp"].includes(project.profile))) {
    checks.push({ id: "native", status: "not-applicable" });
  }
  const behavioral = await verification.verifySuites(ctx, {
    subject,
    inputs: options.inputBundle,
    execute: options.execute,
    temporaryRoot: options.temporaryRoot,
  });
  diagnostics.push(...behavioral.diagnostics);
  checks.push(...behavioral.checks);
  for (const check of behavioral.checks) {
    const planned = plannedFor(check.id);
    coverage.push({
      ...planned,
      checkedFiles: check.status === "incomplete" ? [] : planned.files,
      status: check.status,
      completed: check.status !== "incomplete",
    });
  }
  const examples = options[FIXTURE_RUN]
    ? { diagnostics: [], checks: [], results: [] }
    : await policyTests.runPolicyTests(
        ctx,
        (fixture) =>
          checkContext({
            ...fixture,
            originalRoot: options.originalRoot ?? ctx.root,
            registry: ctx.registry,
            loadJavascript: options.loadJavascript,
            execute: options.execute,
            date: options.date,
            temporaryRoot: options.temporaryRoot,
            [FIXTURE_RUN]: true,
          }),
        { inputs: options.inputBundle, temporaryRoot: options.temporaryRoot },
      );
  diagnostics.push(...examples.diagnostics);
  checks.push(...examples.checks);
  for (const check of examples.checks) {
    coverage.push({
      ...plannedFor(check.id),
      checkedFiles: [],
      status: check.status,
      completed: check.status !== "incomplete",
    });
  }
  for (const [tool, expected] of Object.entries(ctx.config.tools?.versions ?? {})) {
    const found = tools[tool];
    if (found !== undefined) {
      const actual = versionOf(found);
      if (actual !== expected) {
        diagnostics.push(
          failure(
            "tools.version",
            ".",
            `${tool} is ${actual}; policy requires ${expected}.`,
            "Install the exact approved tool version.",
          ),
        );
      }
    } else {
      diagnostics.push(
        failure(
          "tools.version",
          ".",
          `No version was verified for configured tool ${tool}.`,
          "Correct the tool name or enable its required check; a version pin cannot be silently ignored.",
        ),
      );
    }
  }
  diagnostics.push(...validateInputs(ctx, before, options));
  const gitRoot = options.originalRoot ?? ctx.root,
    ratchet = options.base ? await checkPolicyBase(ctx, options.base, gitRoot) : undefined;
  diagnostics.push(
    ...(ratchet?.diagnostics ?? []),
    ...(await nestedPolicyDiagnostics(ctx, gitRoot)),
  );
  diagnostics = enrichDiagnostics(
    sortDiagnostics([...new Map(diagnostics.map((item) => [canonical(item), item])).values()]),
  );
  const applied = applyExceptions(diagnostics, ctx.config.exceptions, metadata, options.date);
  reconcile(checks, diagnostics, applied.diagnostics, applied.suppressed);
  let task: ReturnType<typeof tasks.checkTask> | undefined;
  if (options.loadedTask) {
    task = tasks.checkTask(options.loadedTask, {
      checks,
      testResults: behavioral.results,
      subject,
    });
    applied.diagnostics.push(...task.diagnostics);
    checks.push({ id: "task", capability: "task", status: statusOf(task.diagnostics) });
  }
  for (const row of coverage) {
    const check = checks.find((entry) => entry.id === row.id);
    if (check) {
      row.status = check.status;
      row.completed = ["pass", "violation"].includes(check.status);
      if (check.suppressed) {
        row.suppressed = check.suppressed;
      }
    }
  }
  const result = report(attachOrigins(applied.diagnostics, ctx.origins), {
    command: options[FIXTURE_RUN] ? "policy-fixture" : "check",
    identity: {
      snapshot: before,
      subject,
      inputs: digest(canonical([...ctx.inputs].sort(([a], [b]) => compare(a, b)))),
      ...(ctx.compilerInputs.size || ctx.compilerDirectories.size
        ? {
            compilerInputs: digest(
              canonical({
                files: [...ctx.compilerInputs].sort(([a], [b]) => compare(a, b)),
                directories: [...ctx.compilerDirectories].sort(([a], [b]) => compare(a, b)),
              }),
            ),
          }
        : {}),
      policy: digest(canonical(ctx.config)),
      policySources: ctx.policySources,
      checker: checkerIdentity(language.identity.javascript),
      adapters: language.identity,
      tools,
      ...(options.loadedTask ? { task: options.loadedTask.identity } : {}),
      ...(options.inputBundle ? { approvedInputs: options.inputBundle.identity } : {}),
      ...(ctx.config.exceptions.some((entry) => entry.expires)
        ? { date: options.date ?? new Date().toISOString().slice(0, 10) }
        : {}),
    },
    checks,
    coverage,
    ...(ratchet ? { policyChanges: ratchet.changes } : {}),
    ...(language.typedCoverage?.length ? { typedCoverage: language.typedCoverage } : {}),
    files: plan.files,
    tests: behavioral.results,
    ...(examples.results.length ? { policyTests: examples.results } : {}),
    ...(task ? { task: task.requirements } : {}),
    suppressed: enrichDiagnostics(sortDiagnostics(attachOrigins(applied.suppressed, ctx.origins))),
  });
  if (memo) {
    try {
      memo.verify?.();
    } catch (error) {
      return report([...result.diagnostics, failure("run.mutated", ".", errorMessage(error))], {
        ...result,
        cache: { ...memo.info, hit: false },
      });
    }
    try {
      memo.save?.(result);
    } catch (error) {
      if (errorCode(error) === "PLUMB_CACHE_MUTATED") {
        return report([...result.diagnostics, failure("run.mutated", ".", errorMessage(error))], {
          ...result,
          cache: { ...memo.info, hit: false },
        });
      }
      memo.info.reason = `Cache was not saved: ${errorMessage(error)}`;
    }
    try {
      memo.verify?.();
    } catch (error) {
      return report([...result.diagnostics, failure("run.mutated", ".", errorMessage(error))], {
        ...result,
        cache: { ...memo.info, hit: false },
      });
    }
    result.cache = memo.info;
  }
  return result;
}
