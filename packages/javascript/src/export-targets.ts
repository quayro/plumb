import { resolve } from "node:path";

import type { Project } from "../../../src/config.ts";
import { isRecord } from "../../../src/schema.ts";
import { type Analysis, AnalysisError } from "./analysis.ts";
import type { ExportTarget } from "./signature-snapshot.ts";

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const exportTargets = (
  analysis: Analysis,
  project: Project,
): { targets: ExportTarget[]; routing: string } => {
  const manifestPath = analysis.relative(resolve(analysis.root, project.root, "package.json"));
  let manifest: unknown;
  try {
    manifest = JSON.parse(analysis.read(manifestPath));
  } catch (error) {
    if (error instanceof AnalysisError) {
      throw error;
    }
    throw new AnalysisError(manifestPath, "The package manifest is not valid JSON.");
  }
  if (!isRecord(manifest) || !("exports" in manifest)) {
    throw new AnalysisError(
      manifestPath,
      "A surface contract requires an explicit package exports map.",
    );
  }
  const targets: ExportTarget[] = [];
  const append = (
    key: string,
    target: unknown,
    conditions: string[],
    priority: number[] = [],
  ): void => {
    const label = conditions.length ? `${key} [${conditions.join("/")}]` : key;
    if (target === null) {
      return;
    }
    if (typeof target === "string") {
      if (!target.startsWith("./") || target.split("/").includes("..") || target.includes("\\")) {
        throw new AnalysisError(
          manifestPath,
          `The export ${label} must target a package-relative path beginning with ./ without traversal.`,
        );
      }
      if (!/\.[cm]?[jt]sx?$/.test(target)) {
        return;
      }
      if (target.includes("*")) {
        if ((key.match(/\*/g) ?? []).length !== 1) {
          throw new AnalysisError(
            manifestPath,
            `The export ${label} needs exactly one subpath wildcard to expand its target.`,
          );
        }
        const parts = target.split("*");
        const expression = new RegExp(
          `^${escape(parts[0] ?? "")}(.*)${parts.slice(1).map(escape).join("\\1")}$`,
        );
        const candidates = analysis.files.filter((file) => analysis.scope(project.root, file));
        let expanded = 0;
        for (const file of candidates) {
          const folder = analysis.relative(project.root);
          const local = `./${folder === "." ? file : file.slice(folder.length + 1)}`;
          const match = expression.exec(local);
          if (match) {
            targets.push({
              key: label.replace("*", match[1] ?? ""),
              file,
              priority,
            });
            expanded++;
          }
        }
        if (!expanded) {
          throw new AnalysisError(
            manifestPath,
            `The export ${label} matches no checked script files.`,
            "Run the explicit preparation step and include its outputs, or correct the export map.",
          );
        }
      } else {
        targets.push({
          key: label,
          file: analysis.relative(resolve(analysis.root, project.root, target)),
          priority,
        });
      }
      return;
    }
    if (Array.isArray(target)) {
      if (!target.length) {
        throw new AnalysisError(manifestPath, `The export ${label} has no fallback target.`);
      }
      target.forEach((item: unknown, index) => {
        append(key, item, [...conditions, `fallback:${index}`], [...priority, index]);
      });
    } else if (isRecord(target)) {
      for (const [index, [condition, value]] of Object.entries(target).entries()) {
        if (condition.startsWith(".")) {
          throw new AnalysisError(
            manifestPath,
            `The conditional export ${label} contains a misplaced subpath key.`,
          );
        }
        append(key, value, [...conditions, condition], [...priority, index]);
      }
    } else {
      throw new AnalysisError(manifestPath, `The export ${label} is not a valid export target.`);
    }
  };
  const map = manifest.exports;
  if (isRecord(map) && Object.keys(map).some((key) => key.startsWith("."))) {
    for (const [index, [key, value]] of Object.entries(map).entries()) {
      if (key !== "." && !key.startsWith("./")) {
        throw new AnalysisError(
          manifestPath,
          "An exports map cannot mix condition keys and subpath keys.",
        );
      }
      append(key, value, [], [index]);
    }
  } else {
    append(".", map, []);
  }
  if (!targets.length) {
    throw new AnalysisError(
      manifestPath,
      "The exports map selects no script entries for this surface contract.",
    );
  }
  return {
    targets: targets.sort((a, b) => a.key.localeCompare(b.key)),
    routing: JSON.stringify(map),
  };
};
