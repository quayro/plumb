import { resolve } from "node:path";

import { loadAdapterRegistry } from "./adapter-registry.ts";
import * as adapters from "./adapters.ts";
import * as assets from "./assets.ts";
import { customRules } from "./custom-rules.ts";
import type { Diagnostic, Report, Rule } from "./diagnostics.ts";
import { checkContext } from "./engine-check.ts";
import { context, type EngineOptions, FIXTURE_RUN } from "./engine-context.ts";
import { checkerIdentity, javascriptPack } from "./engine-pack.ts";
import {
  compare,
  coreRules,
  executionPlan,
  failure,
  packageRoot,
  report,
  validateInputs,
} from "./engine-plan.ts";
import { errorMessage } from "./errors.ts";
import { canonical, digest, inventory, normalize, snapshot } from "./files.ts";
import * as hooks from "./hooks.ts";
import { detectProfiles } from "./init.ts";
import { loadInputs, materializeInputs } from "./inputs.ts";
import { verifyInstall } from "./install.ts";
import { fileConventions } from "./instructions.ts";
import * as policyTests from "./policy-tests.ts";
import { scaffold } from "./scaffold.ts";
import * as tasks from "./task.ts";
import { copyWorkspace } from "./workspace.ts";

// engine.ts is the public entry; the context, plan and check stages live in their own modules
export { context, type EngineOptions } from "./engine-context.ts";
export { checkerIdentity, javascriptPack } from "./engine-pack.ts";
export { coreRules, packageRoot, report } from "./engine-plan.ts";

export async function testPolicy(options: EngineOptions = {}): Promise<Report> {
  let ctx;
  try {
    ctx = context(options);
  } catch (error) {
    return report([
      failure("config.invalid", options.configFile ?? "plumb.json", errorMessage(error)),
    ]);
  }
  if (!ctx.config.policyTests?.length) {
    return report(
      [
        failure(
          "policy-tests.incomplete",
          ctx.configFile,
          "No policy acceptance fixtures are configured",
        ),
      ],
      { command: "policy-test" },
    );
  }
  const before = snapshot(ctx.root, ctx.allFiles);
  const inputBundle = options.inputManifest
    ? loadInputs(options.inputManifest, ctx.root)
    : undefined;
  const examples = await policyTests.runPolicyTests(
    ctx,
    (fixture) =>
      checkContext({
        ...fixture,
        originalRoot: ctx.root,
        registry: ctx.registry,
        loadJavascript: options.loadJavascript,
        execute: options.execute,
        date: options.date,
        temporaryRoot: options.temporaryRoot,
        [FIXTURE_RUN]: true,
      }),
    { inputs: inputBundle, temporaryRoot: options.temporaryRoot },
  );
  return report(
    [...ctx.problems, ...examples.diagnostics, ...validateInputs(ctx, before, { inputBundle })],
    {
      command: "policy-test",
      checks: examples.checks,
      policyTests: examples.results,
      identity: { policy: digest(canonical(ctx.config)), checker: checkerIdentity() },
    },
  );
}

export async function scaffoldRepository(options: EngineOptions = {}): Promise<Report> {
  try {
    const ctx = context(options),
      checker = checkerIdentity();
    const inputs = options.inputManifest ? loadInputs(options.inputManifest, ctx.root) : undefined;
    const result = await scaffold(
      ctx,
      (candidate) =>
        checkContext({
          ...candidate,
          originalRoot: ctx.root,
          registry: ctx.registry,
          loadJavascript: options.loadJavascript,
          execute: options.execute,
          date: options.date,
          temporaryRoot: options.temporaryRoot,
        }),
      {
        role: options.role ?? "",
        name: options.name,
        dryRun: options.dryRun,
        inputs,
        checker,
        temporaryRoot: options.temporaryRoot,
        verify: () => {
          if (canonical(checkerIdentity()) !== canonical(checker)) {
            throw new Error("The scaffold checker changed during validation");
          }
        },
      },
    );
    const checked = result.written.length ? await checkRepository(options) : result.checked;
    return report(checked.diagnostics, {
      command: "scaffold",
      dryRun: !!options.dryRun,
      plan: result.plan,
      written: result.written,
      checks: checked.checks,
      ...(result.written.length ? { identity: checked.identity } : {}),
      next: result.written.length
        ? "Review the new source and companion files."
        : result.checked.status === "pass"
          ? "Run scaffold without --dry-run to validate and create these files."
          : "Resolve the reported convention or prerequisite failures before creating these files.",
    });
  } catch (error) {
    return report([failure("run.failed", ".", `Scaffold: ${errorMessage(error)}`)], {
      command: "scaffold",
      written: [],
    });
  }
}

export async function checkRepository(options: EngineOptions = {}): Promise<Report> {
  let workspace, inputOverlay;
  const originalRoot = resolve(options.root ?? process.cwd());
  try {
    const loadedTask =
      options.loadedTask ??
      (options.task ? tasks.loadTask(options.task, { root: originalRoot }) : undefined);
    const inputBundle =
      options.inputBundle ??
      (options.inputManifest ? loadInputs(options.inputManifest, originalRoot) : undefined);
    const registry = options.registry ?? loadAdapterRegistry(options.adapters, originalRoot);
    let subjectContext;
    if (inputBundle) {
      const original = context({ ...options, root: originalRoot, registry });
      workspace = copyWorkspace(originalRoot, {
        files: original.allFiles,
        temporaryRoot: options.temporaryRoot,
      });
      subjectContext = {
        subject: { kind: "worktree", snapshot: workspace.identity.snapshot },
        verify: workspace.verify,
      };
      inputOverlay = materializeInputs(workspace.root, inputBundle);
    }
    const result = await checkContext({
      ...options,
      root: workspace?.root ?? originalRoot,
      originalRoot,
      registry,
      loadedTask,
      inputBundle,
      inputOverlay,
      subjectContext,
      workspace,
    });
    return result;
  } catch (error) {
    return report([failure("run.subject", ".", errorMessage(error))]);
  } finally {
    workspace?.cleanup();
  }
}

// a guarantee cannot be excepted; a convention admits budgeted, reviewed exceptions
export const describeRule = (rule: Rule): Rule & { kind: "guarantee" | "convention" } => ({
  ...rule,
  kind: rule.suppressible === false ? "guarantee" : "convention",
});

export async function inspect(options: EngineOptions = {}): Promise<Record<string, unknown>> {
  const ctx = context(options),
    metadata = [...coreRules(), ...customRules(ctx.config)];
  let javascriptIdentity;
  if (adapters.needsJavascript(ctx.config)) {
    const pack = await (options.loadJavascript ?? javascriptPack)();
    metadata.push(...(await pack.rules()));
    javascriptIdentity = pack.identity;
  }
  if (ctx.registry) {
    metadata.push(...ctx.registry.adapters.flatMap((adapter) => adapter.rules));
  }
  const plan = executionPlan(ctx, options);
  const selected = options.file ? normalize(options.file) : undefined;
  if (selected) {
    ctx.safePath(selected, { allowMissing: true });
  }
  return {
    schemaVersion: 1,
    policy: ctx.config,
    policyHash: digest(canonical(ctx.config)),
    origins: ctx.origins,
    policySources: ctx.policySources,
    files: ctx.files,
    excludedFiles: ctx.allFiles.filter((file) => !ctx.files.includes(file)),
    rules: metadata.sort((a, b) => compare(a.id, b.id)).map(describeRule),
    checker: checkerIdentity(javascriptIdentity),
    plan: { checks: plan.checks, files: plan.files, diagnostics: plan.diagnostics },
    ...(selected
      ? {
          file: {
            ...(plan.files.find((file) => file.path === selected) ?? {
              path: selected,
              present: false,
              checks: [],
            }),
            conventions: fileConventions(ctx, selected),
          },
        }
      : {}),
  };
}

export function planRepository(options: EngineOptions = {}): Report {
  const ctx = context(options);
  const loaded = options.task ? tasks.loadTask(options.task, { root: ctx.root }) : undefined;
  const plan = executionPlan(ctx, options);
  let task;
  if (loaded) {
    task = tasks.taskRequirements(loaded.task);
    for (const name of task.tests) {
      if (!(ctx.config.verification ?? []).some((suite) => suite.id === name)) {
        plan.diagnostics.push(
          failure("task.tests", ".", `Required suite ${name} is not configured`),
        );
      }
    }
    for (const name of task.checks) {
      if (!plan.checks.some((check) => check.id === name || check.capability === name)) {
        plan.diagnostics.push(
          failure("task.checks", ".", `Required check ${name} is not configured`),
        );
      }
    }
  }
  return report(plan.diagnostics, {
    command: "plan",
    executed: false,
    complete: false,
    checks: plan.checks,
    files: plan.files,
    origins: ctx.origins,
    ...(task ? { task } : {}),
  });
}

export async function doctor(options: EngineOptions = {}): Promise<Report> {
  let ctx;
  try {
    ctx = context(options);
  } catch (error) {
    const problems: Diagnostic[] = [];
    let suggestion: Record<string, unknown> | undefined;
    try {
      const found = inventory(options.root ?? process.cwd());
      suggestion = {
        schemaVersion: 1,
        preset: "ozmikhail",
        projects: detectProfiles(found.files).map((profile) => ({
          root: ".",
          profile,
          ...(profile === "cpp" ? { compileCommands: "build" } : {}),
        })),
      };
    } catch (error) {
      // without a readable inventory no starter policy can be suggested; say why alongside the policy error
      suggestion = undefined;
      problems.push(failure("inventory.unsafe", ".", errorMessage(error)));
    }
    return report(
      [
        ...problems,
        failure("config.invalid", options.configFile ?? "plumb.json", errorMessage(error)),
      ],
      {
        command: "doctor",
        executed: false,
        ...(suggestion
          ? {
              suggestedPolicy: suggestion,
              next: "Review this starter policy and install approved adapters for any external profiles before checking.",
            }
          : {}),
      },
    );
  }
  let before;
  try {
    before = snapshot(ctx.root, ctx.allFiles);
  } catch (error) {
    return report([failure("inventory.unsafe", ".", errorMessage(error))], {
      command: "doctor",
      executed: false,
      complete: false,
    });
  }
  const prerequisite = await adapters.doctorAdapters(ctx, {
    registry: ctx.registry,
    loadJavascript: options.loadJavascript ?? javascriptPack,
    execute: options.execute,
  });
  const assetProblems = assets.checkAssets(ctx);
  const hookProblems = [
    ...(await hooks.checkHooks(ctx.config, ctx.root)),
    ...(await verifyInstall(packageRoot)).diagnostics,
  ];
  const plan = planRepository(options);
  return report(
    [
      ...prerequisite.diagnostics,
      ...assetProblems,
      ...hookProblems,
      ...plan.diagnostics,
      ...validateInputs(ctx, before, options),
    ],
    {
      command: "doctor",
      executed: false,
      complete: false,
      checks: prerequisite.checks,
      plan: { checks: plan.checks, files: prerequisite.plan.files },
      tools: prerequisite.versions,
      identity: prerequisite.identity,
      suggestions: prerequisite.suggestions,
      origins: ctx.origins,
      verification: (ctx.config.verification ?? []).map((suite) => ({
        id: suite.id,
        command: suite.command,
        format: suite.format,
        status: "not-run",
      })),
    },
  );
}
