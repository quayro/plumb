import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { syncAssets } from "./assets.ts";
import type { CliOptions } from "./cli-arguments.ts";
import { checkMessage, checkRange, commentChar } from "./commits.ts";
import { loadConfig } from "./config.ts";
import type { Diagnostic, Report } from "./diagnostics.ts";
import { fixDocs } from "./docs.ts";
import type { EngineOptions } from "./engine.ts";
import {
  checkerIdentity,
  checkRepository,
  context,
  inspect,
  javascriptPack,
  report,
} from "./engine.ts";
import { compare } from "./engine-plan.ts";
import { canonical } from "./files.ts";
import { checkFormatTools } from "./format-tools.ts";
import { fixFormatting } from "./formatting.ts";
import { loadInputs } from "./inputs.ts";
import { nativeSteps } from "./native.ts";
import { executeSteps } from "./process.ts";
import { comparePolicies, gitTop } from "./ratchet.ts";
import { applyRepairs, previewRepairs } from "./repair.ts";
import { at, isArray } from "./schema.ts";

export async function discover(start: string, file: string): Promise<string> {
  const top = await gitTop(resolve(start));
  if (top) {
    return top;
  }
  let root = resolve(start);
  for (;;) {
    if (existsSync(join(root, file))) {
      return root;
    }
    const parent = dirname(root);
    if (parent === root) {
      return resolve(start);
    }
    root = parent;
  }
}

export const issue = (rule: string, path: string, message: string, remedy: string): Diagnostic => ({
  rule,
  path,
  message,
  remedy,
  status: "incomplete",
  suppressible: false,
});

async function conservativeFix(
  options: EngineOptions,
): Promise<{ diagnostics: Diagnostic[]; written: string[] }> {
  const ctx = context({ ...options, mode: "fix" }),
    { diagnostics, written } = fixFormatting(ctx);
  if (ctx.config.projects.some((project) => ["typescript", "react"].includes(project.profile))) {
    const result = await (await javascriptPack()).fix(ctx);
    diagnostics.push(...result.diagnostics);
    written.push(...result.written);
  }
  const native = await executeSteps(ctx, nativeSteps(ctx, "fix"));
  diagnostics.push(...native.diagnostics);
  diagnostics.push(...(await checkFormatTools(ctx, undefined, "fix")).diagnostics);
  const generated = await fixDocs(ctx);
  diagnostics.push(...generated.diagnostics);
  written.push(...generated.written);
  return { diagnostics, written };
}

export function saveOutput(root: string, file: string, value: unknown): string {
  const target = resolve(file),
    candidate = existsSync(root) ? realpathSync(root) : resolve(root);
  let parent = dirname(target);
  const missing: string[] = [];
  while (!existsSync(parent)) {
    missing.unshift(basename(parent));
    parent = dirname(parent);
  }
  const actual = join(realpathSync(parent), ...missing, basename(target));
  const offset = relative(candidate, actual);
  if (
    offset !== ".." &&
    !offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(offset)
  ) {
    throw new Error("Save reports and repair plans outside the candidate repository");
  }
  mkdirSync(dirname(actual), { recursive: true });
  writeFileSync(actual, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  return actual;
}

export async function commitCheck(options: CliOptions): Promise<Report> {
  const configFile = options.configFile ?? "plumb.json",
    { config } = loadConfig(options.root, configFile, options.policy);
  if (!config.commits) {
    return report(
      [
        {
          rule: "config.invalid",
          path: configFile,
          message: "The commits policy is not configured.",
          remedy: "Add a commits object to plumb.json, then rerun.",
          status: "incomplete",
          suppressible: false,
        },
      ],
      { command: options.command },
    );
  }
  if (options.command === "commit-msg") {
    const file = resolve(options.rest[0] ?? "");
    return report(
      checkMessage(
        readFileSync(file, "utf8"),
        config.commits,
        relative(options.root, file),
        await commentChar(options.root),
      ),
      { command: "commit-msg" },
    );
  }
  if (options.message !== undefined) {
    return report(checkMessage(options.message, config.commits, "message", null), {
      command: "commits",
    });
  }
  return report(await checkRange(config.commits, options.range ?? "", { root: options.root }), {
    command: "commits",
  });
}

// one budgeted exception per rule for the violations a check reports today. Nothing is written:
// the policy changes only by review.
// shortcut: a violation over an existing exception's budget gets a second, overlapping entry;
// merge it into the existing one by hand, or teach this to raise that budget when it comes up.
export async function baseline(options: CliOptions, run?: Report): Promise<Report> {
  const checked = run ?? (await checkRepository(options)),
    known = (await inspect(options)).rules,
    taken = new Set(context(options).config.exceptions.map((entry) => entry.id)),
    groups = new Map<string, Diagnostic[]>(),
    remaining: Diagnostic[] = [];
  const suppressible = new Set(
    (isArray(known) ? known : [])
      .filter((rule) => at(rule, "suppressible") !== false)
      .map((rule) => at(rule, "id")),
  );
  for (const item of checked.diagnostics) {
    if (
      item.status === "incomplete" ||
      item.suppressible === false ||
      !suppressible.has(item.rule) ||
      // an exception's files are globs, so a path with glob syntax cannot be named exactly
      /[*?{]/.test(item.path ?? "")
    ) {
      remaining.push(item);
    } else {
      groups.set(item.rule, [...(groups.get(item.rule) ?? []), item]);
    }
  }
  const exceptions = [...groups]
    .sort(([a], [b]) => compare(a, b))
    .map(([rule, items]) => {
      let id = `baseline-${rule.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      while (taken.has(id)) {
        id += "-x";
      }
      taken.add(id);
      return {
        id,
        rules: [rule],
        files: [...new Set(items.map((item) => item.path ?? "."))],
        reason: "baseline: violations that predate this policy",
        max: items.length,
      };
    });
  return report(remaining, {
    command: "baseline",
    exceptions,
    next: "Review these entries, then add them to exceptions in the policy; budgets only shrink.",
  });
}

const tally = (items: readonly Diagnostic[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.rule, (counts.get(item.rule) ?? 0) + 1);
  }
  return counts;
};

// where adoption stands: what still fails, what each exception budget hides and, against a base,
// whether the budgets shrank. The exit code is the check's own, so a summary never hides a failure.
export async function progress(options: CliOptions): Promise<Report> {
  const checked = await checkRepository(options),
    hidden = checked.suppressed ?? [],
    failing = tally(checked.diagnostics.filter((item) => item.status !== "incomplete")),
    excepted = tally(hidden);
  const exceptions = context(options).config.exceptions.map((entry) => ({
    id: entry.id,
    used: hidden.filter((item) => item.exception === entry.id).length,
    max: entry.max,
    ...(entry.expires ? { expires: entry.expires } : {}),
  }));
  const changes = isArray(checked.policyChanges) ? checked.policyChanges : undefined,
    number = (value: unknown): number => (typeof value === "number" ? value : 0);
  return report(checked.diagnostics, {
    command: "progress",
    totals: {
      violations: [...failing.values()].reduce((sum, count) => sum + count, 0),
      incomplete: checked.diagnostics.filter((item) => item.status === "incomplete").length,
      suppressed: hidden.length,
      budget: exceptions.reduce((sum, entry) => sum + entry.max, 0),
    },
    rules: [...new Set([...failing.keys(), ...excepted.keys()])].sort(compare).map((rule) => ({
      rule,
      violations: failing.get(rule) ?? 0,
      suppressed: excepted.get(rule) ?? 0,
    })),
    exceptions,
    ...(changes
      ? {
          // a removed exception gives its whole budget back; an added one takes its budget
          budgetChange: changes
            .filter((item) => /^\/exceptions\/[^/]+(?:\/max)?$/.test(String(at(item, "pointer"))))
            .reduce(
              (sum: number, item) =>
                sum +
                number(at(item, "after", "max") ?? at(item, "after")) -
                number(at(item, "before", "max") ?? at(item, "before")),
              0,
            ),
        }
      : {}),
  });
}

// what adopting the policy given as --policy would change here: its classified policy changes, the
// diagnostics it introduces and resolves, and the exceptions that would budget what it reports
export async function upgrade(options: CliOptions): Promise<Report> {
  const current = { ...options, policy: undefined },
    before = await checkRepository(current),
    after = await checkRepository(options);
  const key = (item: Diagnostic): string =>
    item.fingerprint ?? canonical([item.rule, item.path, item.message]);
  const known = new Set(before.diagnostics.map(key)),
    kept = new Set(after.diagnostics.map(key));
  return report(
    // an incomplete candidate run is never a clean upgrade, even when today's run is incomplete too
    after.diagnostics.filter((item) => item.status === "incomplete" || !known.has(key(item))),
    {
      command: "upgrade",
      changes: comparePolicies(context(current).config, context(options).config),
      resolved: before.diagnostics.filter((item) => !kept.has(key(item))),
      exceptions: (await baseline(options, after)).exceptions,
      next: "Review the changes; fix the new violations or add the reviewed exceptions with the policy.",
    },
  );
}

export async function mutation(options: CliOptions): Promise<Report> {
  const ctx = context({ ...options, mode: options.command });
  if (options.command === "sync") {
    const result = syncAssets(ctx);
    return report(result.diagnostics, { command: "sync", written: result.written });
  }
  if (options.command === "snapshot") {
    const pack = await javascriptPack(),
      proposals = await pack.snapshot(ctx, options.project);
    if (!proposals.length) {
      throw new Error("No public API snapshot is configured for this project");
    }
    const prepared = proposals.map((item) => {
      if (!item.path.endsWith(".surface.json")) {
        throw new Error("API snapshots must use a dedicated .surface.json filename");
      }
      const target = ctx.safePath(item.path, { allowMissing: true });
      if (existsSync(target)) {
        const previous: unknown = JSON.parse(readFileSync(target, "utf8"));
        if (!pack.surfaceSnapshotIsValid(previous)) {
          throw new Error(`Refusing to replace an unrelated file at ${item.path}`);
        }
      }
      return { ...item, target };
    });
    for (const item of prepared) {
      mkdirSync(dirname(item.target), { recursive: true });
      writeFileSync(item.target, item.content);
    }
    return report([], {
      command: "snapshot",
      written: prepared.map((item) => item.path),
      next: "Review the public API change before approving the new snapshot.",
    });
  }
  if (options.command === "prepare") {
    const steps = ctx.config.projects.flatMap((project) =>
      (project.prepare ?? []).map((command, index) => ({
        id: `prepare.${project.root}.${index + 1}`,
        path: project.root,
        cwd: ctx.safePath(project.root),
        command,
      })),
    );
    const result = await executeSteps(ctx, steps);
    return report(result.diagnostics, { command: "prepare", checks: result.checks });
  }
  const inputs = options.inputManifest ? loadInputs(options.inputManifest, ctx.root) : undefined;
  const hasJavascript = ctx.config.projects.some((project) =>
    ["typescript", "react"].includes(project.profile),
  );
  const checker = checkerIdentity(hasJavascript ? (await javascriptPack()).identity : undefined);
  let plan: unknown;
  if (options.apply) {
    const saved: unknown = JSON.parse(readFileSync(resolve(options.apply), "utf8"));
    plan = at(saved, "plan") ?? saved;
  } else {
    plan = await previewRepairs(
      ctx,
      (root) =>
        conservativeFix({ ...options, root, originalRoot: ctx.root, registry: ctx.registry }),
      { checker, inputs },
    );
  }
  if (options.dryRun) {
    return report([], {
      command: "fix",
      dryRun: true,
      plan,
      written: [],
      next: "Review the patch and apply the saved plan with plumb fix --apply FILE.",
    });
  }
  const { written } = applyRepairs(ctx, plan, { checker, inputs });
  const checked = await checkRepository(options);
  return report(checked.diagnostics, { ...checked, command: "fix", written });
}
