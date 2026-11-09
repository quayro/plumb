import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import type { Project } from "../../src/config.ts";
import type { Context } from "../../src/context.ts";
import type { Diagnostic } from "../../src/diagnostics.ts";
import { isWithin } from "../../src/files.ts";
import { isRecord } from "../../src/schema.ts";
import { diagnostic, location } from "./adapter-shared.ts";
import type { PackOptions } from "./eslint/options.ts";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

// refuse ranges, tags, git, file, link and http specs; workspace:* links the local package the
// lockfile records
const exactSpec = (range: string): boolean =>
  EXACT_VERSION.test(range) ||
  range === "workspace:*" ||
  (range.startsWith("workspace:") && EXACT_VERSION.test(range.slice(10)));

// a peer declares the versions a host may provide, so it is a plain semver range: never a tag, link
// or wildcard
const COMPARATOR = /^(?:[\^~]|[<>]=?)?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/;

const peerRange = (range: string): boolean =>
  range.split("||").every((set) => {
    const parts = set.trim().split(/\s+/);
    return parts.length >= 1 && parts.length <= 2 && parts.every((part) => COMPARATOR.test(part));
  });

const allowedSpec = (field: string, range: string): boolean =>
  exactSpec(range) || (field === "peerDependencies" && peerRange(range));

const allowedName = (allowed: readonly string[], name: string): boolean =>
  allowed.some((pattern) =>
    pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  );

// the ozmikhail dependency policy over the repo root manifest and every manifest under a JavaScript
// project
export function dependencyProblems(
  ctx: Context,
  options: PackOptions,
  projects: readonly Project[],
): Diagnostic[] {
  const problems: Diagnostic[] = [],
    rootManifest = join(ctx.root, "package.json");
  const manifests = ctx.files.filter(
    (file) =>
      basename(file) === "package.json" &&
      (ctx.safePath(file) === rootManifest ||
        projects.some((project) => isWithin(ctx.safePath(project.root), ctx.safePath(file)))),
  );
  if (!manifests.length) {
    return [
      diagnostic(
        "javascript/dependencies",
        "package.json",
        "No package.json was found under the JavaScript projects to check.",
        "Declare the project manifest so its dependencies can be checked.",
        true,
      ),
    ];
  }
  for (const file of manifests) {
    const path = location(ctx, file);
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(ctx.read(file) ?? "");
      if (!isRecord(parsed)) {
        throw new TypeError("package.json is not an object");
      }
      manifest = parsed;
    } catch {
      problems.push(
        diagnostic(
          "javascript/dependencies",
          path,
          "The package manifest is not valid JSON.",
          "Correct the manifest so its dependencies can be checked.",
          true,
        ),
      );
      continue;
    }
    for (const field of DEPENDENCY_FIELDS) {
      const declared = manifest[field];
      for (const [name, range] of Object.entries(isRecord(declared) ? declared : {})) {
        if (!allowedSpec(field, String(range))) {
          problems.push(
            diagnostic(
              "javascript/dependencies",
              path,
              `${name} is ${String(range)}, not an exact version.`,
              field === "peerDependencies"
                ? "Declare the peer as a semver range such as ^1.2.3; tags, links and wildcards are refused."
                : "Pin the exact version (for example 1.2.3); ranges, tags and links are refused.",
            ),
          );
        }
        if (options.dependencies?.allowed && !allowedName(options.dependencies.allowed, name)) {
          problems.push(
            diagnostic(
              "javascript/dependencies",
              path,
              `${name} is not on the reviewed dependency allow-list.`,
              "Adding a dependency is a reviewed policy change: add it to javascript.dependencies.allowed first.",
            ),
          );
        }
      }
    }
    if (
      ctx.safePath(file) === rootManifest &&
      !/^[a-z]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(
        typeof manifest.packageManager === "string" ? manifest.packageManager : "",
      )
    ) {
      problems.push(
        diagnostic(
          "javascript/dependencies",
          path,
          "packageManager is missing or not name@x.y.z.",
          "Declare the exact package manager, for example bun@1.2.3.",
        ),
      );
    }
  }
  if (!LOCKFILES.some((name) => existsSync(join(ctx.root, name)))) {
    problems.push(
      diagnostic(
        "javascript/dependencies",
        ".",
        "No lockfile is present at the repository root.",
        `Commit one lockfile: ${LOCKFILES.join(", ")}.`,
      ),
    );
  }
  return problems;
}
