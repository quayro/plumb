import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { syncAssets } from "./assets.ts";
import type { CliOptions } from "./cli-arguments.ts";
import { checkMessage, checkRange, commentChar } from "./commits.ts";
import { loadConfig } from "./config.ts";
import type { Diagnostic, Report } from "./diagnostics.ts";
import { fixDocs } from "./docs.ts";
import type { EngineOptions } from "./engine.ts";
import { checkerIdentity, checkRepository, context, javascriptPack, report } from "./engine.ts";
import { safePath } from "./files.ts";
import { checkFormatTools } from "./format-tools.ts";
import { fixFormatting } from "./formatting.ts";
import { loadInputs } from "./inputs.ts";
import { nativeSteps } from "./native.ts";
import { executeSteps } from "./process.ts";
import { gitTop } from "./ratchet.ts";
import { applyRepairs, previewRepairs } from "./repair.ts";
import { at } from "./schema.ts";

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

export function init(options: CliOptions): Report {
  const root = options.root;
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  const path = safePath(root, options.configFile ?? "plumb.json", { allowMissing: true });
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite ${path}`);
  }
  const profile = options.profile ?? "generic",
    preset = options.preset ?? "ozmikhail";
  if (!["generic", "typescript", "react", "ruby", "cpp"].includes(profile)) {
    throw new Error(`Unknown profile ${profile}`);
  }
  if (!["ozmikhail", "portable"].includes(preset)) {
    throw new Error(`Unknown preset ${preset}`);
  }
  const config = {
    schemaVersion: 1,
    preset,
    projects:
      profile === "generic"
        ? []
        : [{ root: ".", profile, ...(profile === "cpp" ? { compileCommands: "build" } : {}) }],
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  const written = [options.configFile ?? "plumb.json"];
  if (preset === "ozmikhail" && !existsSync(join(root, "AGENTS.md"))) {
    writeFileSync(
      join(root, "AGENTS.md"),
      "# Agent instructions\n\nRun `plumb inspect` to read the effective policy and `plumb check --format json` for diagnostics.\nResolve violations in source. Changes to policy, exceptions or API snapshots require review.\nUse `plumb fix` for source formatting and `plumb sync` for owned assets.\n",
      { flag: "wx" },
    );
    written.push("AGENTS.md");
  }
  return report([], {
    command: "init",
    written,
    next: "Run plumb sync, then plumb check. Language profiles need their documented toolchains.",
  });
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
