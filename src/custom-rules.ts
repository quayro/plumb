import { posix } from "node:path";

import type { Config } from "./config.ts";
import type { Context } from "./context.ts";
import type { Diagnostic, Rule } from "./diagnostics.ts";
import { errorMessage } from "./errors.ts";
import { globMatches } from "./files.ts";
import { changedFiles } from "./ratchet.ts";

const REMEDY = "Change the file to satisfy the rule; the rule changes only by review.";

const SCOPE: Rule = {
  id: "rules.scope",
  description: "Every custom rule selects files and can read the document it names.",
  remedy: "Correct the rule's file patterns or restore the document it names.",
  suppressible: false,
};

const BASE: Rule = {
  id: "rules.base",
  description: "A change-coupling rule needs the files changed since --base.",
  remedy: "Fetch the base ref or pass a revision this checkout descends from, then retry.",
  suppressible: false,
};

export const RULES: Rule[] = [SCOPE, BASE];

// a policy's own rules, as the metadata that exceptions, inspect and explain read
export const customRules = (config: Pick<Config, "rules">): Rule[] =>
  (config.rules ?? []).map((rule) => ({
    id: `custom.${rule.id}`,
    description: rule.reason,
    remedy: rule.remedy ?? REMEDY,
  }));

export const customRuleFiles = (ctx: Pick<Context, "files" | "config">): string[] =>
  ctx.files.filter((path) =>
    (ctx.config.rules ?? []).some((rule) => globMatches(rule.files, path)),
  );

// the name must stand alone: a longer word that contains it is not a mention
const mentions = (document: string, name: string): boolean =>
  new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(document);

// shortcut: these rules read text, not syntax, so a pattern split across lines or built at run
// time is not seen; use a convention role or an adapter when a rule needs the syntax tree.
export async function checkCustomRules(
  ctx: Pick<Context, "files" | "config" | "configFile" | "read">,
  base?: { revision: string; gitRoot: string },
): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  const incomplete = (rule: Rule, message: string): void => {
    out.push({
      rule: rule.id,
      path: ctx.configFile,
      message,
      remedy: rule.remedy,
      status: "incomplete",
      suppressible: false,
    });
  };
  let changed: string[] | undefined;
  for (const rule of ctx.config.rules ?? []) {
    const selected = ctx.files.filter((path) => globMatches(rule.files, path));
    if (!selected.length) {
      incomplete(SCOPE, `Rule ${rule.id} selects no files.`);
      continue;
    }
    const violation = (path: string, message: string, line?: number): void => {
      out.push({
        rule: `custom.${rule.id}`,
        path,
        message: `${rule.reason} ${message}`,
        remedy: rule.remedy ?? REMEDY,
        ...(line ? { line } : {}),
      });
    };
    const forbid = rule.forbid ? new RegExp(rule.forbid) : undefined,
      require = rule.require ? new RegExp(rule.require, "m") : undefined,
      companions = rule.changesWith;
    const document = rule.mentionedIn
      ? ctx.read(rule.mentionedIn, { allowMissing: true })
      : undefined;
    if (document === null) {
      incomplete(SCOPE, `Rule ${rule.id}: ${rule.mentionedIn} cannot be read.`);
    }
    for (const path of selected) {
      const content = forbid || require ? (ctx.read(path) ?? "") : "";
      for (const [index, line] of (forbid ? content.split("\n") : []).entries()) {
        if (forbid?.test(line)) {
          violation(path, `This line matches the forbidden pattern ${rule.forbid}.`, index + 1);
        }
      }
      if (require && !require.test(content)) {
        violation(path, `The file must match ${rule.require}.`);
      }
      const name = posix.basename(path).split(".")[0] ?? "";
      if (document && !mentions(document, name)) {
        violation(path, `${rule.mentionedIn} must mention ${name}.`);
      }
    }
    if (companions && base) {
      try {
        changed ??= await changedFiles(base.gitRoot, base.revision);
      } catch (error) {
        incomplete(BASE, `Rule ${rule.id}: ${errorMessage(error)}`);
        continue;
      }
      if (!changed.some((path) => globMatches(companions, path))) {
        for (const path of changed.filter((entry) => globMatches(rule.files, entry))) {
          violation(path, `It changed without a change to ${companions.join(", ")}.`);
        }
      }
    }
  }
  return out;
}
