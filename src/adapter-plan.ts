import { extname } from "node:path";

import { type AdapterRegistry, registryIdentity } from "./adapter-registry.ts";
import type { Config, Project } from "./config.ts";
import type { Context } from "./context.ts";
import type { Diagnostic, Rule, Status } from "./diagnostics.ts";
import { errorMessage } from "./errors.ts";
import { canonical, globMatches, isWithin } from "./files.ts";
import { formatToolFiles } from "./format-tools.ts";
import { nativeSource } from "./native.ts";
import { validateSchema } from "./schema.ts";

// which checks a run owes: every selected file maps to an adapter capability or an explanation

export interface PlannedCheck {
  id: string;
  adapter: string;
  root: string;
  capability: string;
  files: string[];
  evidence: string;
  scope?: string;
  allowNotApplicable?: boolean;
}

interface PlanFile {
  path: string;
  excluded: boolean;
  reasons: string[];
  owners: { root: string; profile: string }[];
  checks: string[];
}

export interface AdapterPlan {
  schemaVersion: 1;
  checks: PlannedCheck[];
  files: PlanFile[];
  diagnostics: Diagnostic[];
  identity: unknown;
}

export type PlanContext = Pick<
  Context,
  "root" | "files" | "config" | "safePath" | "matches" | "read"
> &
  Partial<Pick<Context, "allFiles" | "ownedFiles">>;

export const RULES: Rule[] = (
  [
    [
      "adapters.registry",
      "External adapters are explicitly selected, pinned and outside the candidate checkout.",
    ],
    ["adapters.protocol", "An adapter returns complete, valid diagnostics and input evidence."],
    [
      "adapters.coverage",
      "Every planned file has an explicit completed check or a supported applicability explanation.",
    ],
    ["adapters.integrity", "Adapter code and registry files must retain their approved content."],
  ] as const
).map(([id, description]): Rule => ({
  id,
  description,
  remedy: "Correct the adapter installation or its declared scope, then run the complete check.",
  suppressible: false,
}));
// recognized source languages no built-in profile checks; each one must have a configured adapter
// or an exclusion
const UNSUPPORTED = new Set([
  ".py",
  ".pyi",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".cs",
  ".fs",
  ".swift",
  ".m",
  ".mm",
  ".php",
  ".lua",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".ml",
  ".clj",
  ".dart",
  ".r",
  ".jl",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
  ".tf",
  ".vue",
  ".svelte",
  ".astro",
  ".mdx",
]);

export const issue = (rule: string, path: string, message: string, check?: string): Diagnostic => ({
  rule,
  path,
  message,
  remedy: "Restore the required tool or input and rerun; incomplete coverage cannot be excepted.",
  status: "incomplete",
  suppressible: false,
  ...(check ? { check } : {}),
});

const script = (file: string): boolean => /\.[cm]?[jt]sx?$/.test(file);

const typed = (file: string): boolean => /\.[cm]?tsx?$/.test(file);

const sort = (items: readonly unknown[]): unknown[] => [...items].sort();

export const same = (left: readonly unknown[], right: readonly unknown[]): boolean =>
  canonical(sort(left)) === canonical(sort(right));

export const statusOf = (diagnostics: readonly Diagnostic[]): Status =>
  diagnostics.some((item) => item.status === "incomplete")
    ? "incomplete"
    : diagnostics.length
      ? "violation"
      : "pass";

export const registryAdapters = (
  registry: AdapterRegistry | undefined,
): AdapterRegistry["adapters"] => registry?.adapters ?? [];

export const profileFamily = (profile: string): string =>
  ["typescript", "react"].includes(profile) ? "javascript" : profile;

export function profileSource(
  profile: string,
  file: string,
  root = ".",
  registry?: AdapterRegistry,
): boolean {
  if (["typescript", "react"].includes(profile)) {
    return script(file);
  }
  if (["ruby", "cpp"].includes(profile)) {
    return nativeSource(profile, file);
  }
  const descriptor = registryAdapters(registry).find((entry) => entry.id === profile);
  const local = root === "." ? file : file.slice(root.length + 1);
  return !!descriptor && globMatches(descriptor.files, local);
}

export function projectFiles(
  ctx: Pick<Context, "files" | "config">,
  project: Project,
  registry?: AdapterRegistry,
): string[] {
  return ctx.files
    .filter(
      (file) =>
        isWithin(project.root, file) &&
        profileSource(project.profile, file, project.root, registry) &&
        !ctx.config.projects.some(
          (other) =>
            profileFamily(other.profile) === profileFamily(project.profile) &&
            other.root !== project.root &&
            isWithin(project.root, other.root) &&
            isWithin(other.root, file),
        ),
    )
    .sort();
}

export function sourceProfiles(file: string, registry?: AdapterRegistry): string[] {
  const profiles = ["typescript", "react", "ruby", "cpp"].filter((profile) =>
    profileSource(profile, file),
  );
  const parts = file.split("/");
  for (const entry of registryAdapters(registry)) {
    if (parts.some((_part, index) => globMatches(entry.files, parts.slice(index).join("/")))) {
      profiles.push(entry.id);
    }
  }
  return profiles;
}

export const needsJavascript = (
  config: Pick<Config, "projects" | "contracts" | "javascript" | "conventions">,
): boolean =>
  config.projects.some((project) => ["typescript", "react"].includes(project.profile)) ||
  Object.values(config.contracts ?? {}).some((items: unknown[]) => items.length > 0) ||
  config.javascript !== undefined ||
  !!config.conventions?.roles.some((role) => role.imports || role.exports || role.javascript);

export function planAdapters(
  ctx: PlanContext,
  { registry }: { registry?: AdapterRegistry } = {},
): AdapterPlan {
  const checks: PlannedCheck[] = [],
    diagnostics: Diagnostic[] = [],
    known = [
      "typescript",
      "react",
      "ruby",
      "cpp",
      ...registryAdapters(registry).map((entry) => entry.id),
    ];
  const selections = new Map(
    ctx.config.projects.map((project) => [project, projectFiles(ctx, project, registry)]),
  );
  const ownership = new Map([...selections].map(([project, files]) => [project, new Set(files)]));
  const add = (
    adapter: string,
    root: string,
    capability: string,
    files: string[],
    evidence: string,
    extra: Pick<PlannedCheck, "scope" | "allowNotApplicable"> = {},
  ): number =>
    checks.push({
      id: `${adapter}.${capability}:${root}`,
      adapter,
      root,
      capability,
      files,
      evidence,
      ...extra,
    });
  for (const project of ctx.config.projects) {
    if (!known.includes(project.profile)) {
      diagnostics.push(
        issue(
          "adapters.registry",
          project.root,
          `No approved adapter provides profile ${project.profile}.`,
        ),
      );
      continue;
    }
    const selected = selections.get(project) ?? [],
      adapter = profileFamily(project.profile),
      descriptor = registryAdapters(registry).find((entry) => entry.id === adapter);
    try {
      ctx.safePath(project.root);
      if (!selected.length) {
        throw new Error(`No ${project.profile} source files are owned by this project`);
      }
      if (adapter !== "javascript" && !["ruby", "cpp"].includes(adapter)) {
        validateSchema(
          project.options ?? {},
          descriptor?.optionsSchema ?? {},
          `project ${project.root}.options`,
        );
      } else if (project.options && Object.keys(project.options).length) {
        throw new Error("Built-in profiles do not accept external adapter options");
      }
    } catch (error) {
      diagnostics.push(issue("projects.scope", project.root, errorMessage(error)));
    }
    if (adapter === "javascript") {
      add(adapter, project.root, "lint", selected, "api-reported");
      add(adapter, project.root, "types", selected.filter(typed), "api-reported");
      if (project.knip) {
        for (let i = 1; i <= 3; i++) {
          checks.push({
            id: `knip.${project.root}.${i}`,
            adapter,
            root: project.root,
            capability: "dependencies",
            files: [],
            evidence: "process-exit",
            scope: "project",
          });
        }
      }
    } else if (adapter === "ruby") {
      add(adapter, project.root, "lint", selected, "tool-reported");
    } else if (adapter === "cpp") {
      add(adapter, project.root, "format", selected, "explicit-inputs");
      add(
        adapter,
        project.root,
        "lint",
        selected.filter((file) => !/\.(h|hh|hpp|hxx)$/.test(file)),
        "explicit-inputs",
      );
    } else {
      for (const capability of descriptor?.capabilities ?? []) {
        add(adapter, project.root, capability, selected, "adapter-reported");
      }
    }
  }
  if (needsJavascript(ctx.config)) {
    add("javascript", ".", "policy", [], "validated-policy", { scope: "policy" });
    add("javascript", ".", "contracts", ctx.files.filter(script), "api-reported", {
      allowNotApplicable: true,
    });
    if (ctx.config.projects.some((project) => ["typescript", "react"].includes(project.profile))) {
      add(
        "javascript",
        ".",
        "format",
        ctx.files.filter(
          (file) =>
            !ctx.ownedFiles?.includes(file) &&
            !ctx.config.format?.ignore?.some((entry) => ctx.matches(entry.path, file)),
        ),
        "api-reported",
        { allowNotApplicable: true },
      );
    }
  }
  const formatted = new Set(formatToolFiles(ctx));
  if (ctx.config.preset === "ozmikhail") {
    for (const file of ctx.files) {
      if (ctx.config.projects.some((project) => ownership.get(project)?.has(file))) {
        continue;
      }
      // a pinned formatter is that file's checker, so it is covered
      if (formatted.has(file)) {
        continue;
      }
      if (sourceProfiles(file, registry).length) {
        diagnostics.push(
          issue(
            "projects.uncovered",
            file,
            "No configured language profile covers this supported source file.",
          ),
        );
      } else if (UNSUPPORTED.has(extname(file).toLowerCase())) {
        diagnostics.push({
          rule: "projects.unsupported",
          path: file,
          message: "A recognized source file has no configured project or adapter.",
          remedy:
            "Add a project or approved adapter for this language, or exclude the file with a reason.",
          status: "incomplete",
          suppressible: false,
        });
      }
    }
  }
  const selected = new Set(ctx.files),
    assigned = new Map<string, string[]>();
  for (const check of checks) {
    for (const path of check.files) {
      const list = assigned.get(path) ?? [];
      list.push(check.id);
      assigned.set(path, list);
    }
  }
  const files = (ctx.allFiles ?? ctx.files).map((path): PlanFile => ({
    path,
    excluded: !selected.has(path),
    reasons: ctx.config.exclude
      .filter((entry) => globMatches(entry.files, path))
      .map((entry) => entry.reason),
    owners: ctx.config.projects
      .filter((project) => ownership.get(project)?.has(path))
      .map(({ root, profile }) => ({ root, profile })),
    checks: assigned.get(path) ?? [],
  }));
  return { schemaVersion: 1, checks, files, diagnostics, identity: registryIdentity(registry) };
}
