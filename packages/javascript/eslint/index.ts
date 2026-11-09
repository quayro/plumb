import js from "@eslint/js";
import type { Linter } from "eslint";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import type { Program } from "typescript";
import tseslint from "typescript-eslint";

import { createModuleResolver, type ModuleResolver } from "../shared/module-resolver.ts";
import { errorHandlingRule } from "./errors.ts";
import { customRuleMetadata } from "./metadata.ts";
import { DEFAULT_SOURCE, eslintGlobs, validateOptions } from "./options.ts";
import { plumbReactRules } from "./react.ts";
import { plumbTypescriptRules } from "./rules.ts";
import { scopedRule } from "./scoped.ts";
import { syntaxRule } from "./syntax.ts";
import { typeCheckedRules, typeInformationRule } from "./typed-policy.ts";
import type { RuleModule, TypedServices } from "./types.ts";

export interface EslintRuntime {
  preset?: string;
  resolver?: ModuleResolver;
  typed?: TypedServices;
  programs?: Program[];
  typedFiles?: string[];
}

export { strictCompilerOptions, typedRuntime } from "./typed.ts";

const SCRIPTS = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const TYPED = "**/*.{ts,tsx,mts,cts}";
export const PLUMB_MAX_LINES = Object.freeze({
  max: 400,
  skipBlankLines: true,
  skipComments: true,
});

const namingConvention = (react: boolean): Linter.RuleEntry => [
  "error",
  { selector: "typeLike", format: ["PascalCase"] },
  {
    selector: "function",
    format: react ? ["camelCase", "PascalCase"] : ["camelCase"],
    leadingUnderscore: "allow",
  },
  { selector: "parameter", format: ["camelCase"], leadingUnderscore: "allow" },
  {
    selector: "variable",
    format: ["camelCase", "UPPER_CASE", "PascalCase"],
    ...(react
      ? {
          leadingUnderscore: "allowSingleOrDouble",
          trailingUnderscore: "allowDouble",
        }
      : { leadingUnderscore: "allow" }),
  },
];

const baseRules = (react: boolean): Linter.RulesRecord => ({
  curly: ["error", "all"],
  "no-console": "error",
  "no-empty": ["error", { allowEmptyCatch: false }],
  "no-throw-literal": "error",
  "prefer-promise-reject-errors": ["error", { allowEmptyReject: false }],
  "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
  "simple-import-sort/imports": "error",
  "simple-import-sort/exports": "error",
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
  "@typescript-eslint/naming-convention": namingConvention(react),
  "plumb/comments": "error",
  "plumb/directive": "error",
  "plumb/imports-first": "error",
  "plumb/module-spacing": "error",
});

const typedRules = (profile: string): Linter.RulesRecord => ({
  "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
  "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
  "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-import-type-side-effects": "error",
  ...(profile === "backend" && {
    "@typescript-eslint/explicit-module-boundary-types": "error",
  }),
});

const reactRules = (): Linter.RulesRecord => ({
  ...Object.fromEntries(
    Object.keys(reactHooks.configs["recommended-latest"].rules).map((name) => [name, "error"]),
  ),
  "plumb-react/props": "error",
  "plumb-react/refresh-boundary": "error",
});

// the rules are written against typescript-eslint's AST, which ESLint's ESTree plugin type cannot
// describe; like typescript-eslint's CompatiblePlugin, the plugin is typed by its meta alone
export const plugin = (
  name: string,
  rules: Record<string, RuleModule>,
): { meta: { name: string } } => {
  const value = { meta: { name }, rules };
  return value;
};

export const createConfig = (input: unknown, runtime: EslintRuntime = {}): Linter.Config[] => {
  validateOptions(input);
  if (!input.root) {
    throw new TypeError("createConfig: root is the absolute project folder");
  }
  const {
    root,
    profile = "backend",
    source = DEFAULT_SOURCE,
    rules = [],
    tailwind,
    clientDirective,
    words,
    wordAttributes,
    lines,
  } = input;
  const react = profile === "react";
  const syntax = { ...input, root, profile, source };
  const pluginRules: Record<string, Record<string, RuleModule>> = {
    plumb: {
      ...plumbTypescriptRules,
      syntax: syntaxRule,
      errors: errorHandlingRule,
      "type-information": typeInformationRule,
    },
    "plumb-react": { ...plumbReactRules },
  };
  const families: Record<string, Record<string, RuleModule>> = {
    plumb: plumbTypescriptRules,
    "plumb-react": plumbReactRules,
  };
  const contracts: Record<string, ["error", { files: string[]; options: unknown[] }[]]> = {},
    presetRules: Linter.RulesRecord = {};
  for (const block of rules) {
    for (const [id, setting] of Object.entries(block.rules)) {
      const [namespace = "", name = ""] = id.split("/");
      const values: unknown[] = Array.isArray(setting) ? setting.slice(1) : [];
      const first: unknown = values[0];
      const options = ["layers", "owners", "export-prefix"].includes(name)
        ? [{ ...(typeof first === "object" ? first : {}), root }]
        : values;
      const rule = families[namespace]?.[name],
        target = pluginRules[namespace];
      if (!rule || !target) {
        throw new TypeError(`javascript.rules: ${id} is not a Plumb contract`);
      }
      (contracts[id] ??= ["error", []])[1].push({
        files: block.files ?? [SCRIPTS],
        options,
      });
      target[name] = scopedRule(rule, root);
    }
  }
  // the ozmikhail preset adds the assertion check to every test file; it is never a per-rule opt-in
  if (runtime.preset === "ozmikhail") {
    presetRules["plumb/test-assertions"] = [
      "error",
      {
        root,
        ...(input.tests?.assertions && { assertions: input.tests.assertions }),
      },
    ];
  }
  return defineConfig(
    {
      linterOptions: {
        noInlineConfig: true,
        reportUnusedDisableDirectives: "error",
        reportUnusedInlineConfigs: "error",
      },
    },
    {
      files: [SCRIPTS],
      extends: [js.configs.recommended, ...tseslint.configs.recommended],
      languageOptions: {
        ecmaVersion: 2022,
        globals: react ? { ...globals.browser, ...globals.node } : { ...globals.node },
      },
      settings: {
        plumbResolver: runtime.resolver ?? createModuleResolver(root),
        plumbTyped: runtime.typed,
        plumbTrustedPrograms: runtime.programs ?? [],
      },
      plugins: {
        plumb: plugin("plumb", pluginRules.plumb ?? {}),
        "plumb-react": plugin("plumb-react", pluginRules["plumb-react"] ?? {}),
        "react-hooks": { rules: reactHooks.rules },
        "simple-import-sort": simpleImportSort,
      },
      rules: {
        ...baseRules(react),
        ...(react && reactRules()),
        "plumb/syntax": ["error", syntax],
        "plumb/errors": ["error", { ...input.errorHandling, root }],
        ...presetRules,
        ...contracts,
      },
    },
    { files: [TYPED], rules: typedRules(profile) },
    { files: [TYPED], rules: { "plumb/type-information": "error" } },
    ...(runtime.programs?.length && runtime.typedFiles?.length
      ? [
          {
            files: eslintGlobs(runtime.typedFiles),
            languageOptions: {
              parserOptions: {
                programs: runtime.programs,
                project: false,
                projectService: false,
                tsconfigRootDir: root,
              },
            },
            rules: {
              ...typeCheckedRules,
              "no-throw-literal": "off",
              "prefer-promise-reject-errors": "off",
              "plumb/type-information": "error",
            } satisfies Linter.RulesRecord,
          },
        ]
      : []),
    {
      files: eslintGlobs(source),
      rules: { "max-lines": ["error", PLUMB_MAX_LINES] },
    },
    ...(tailwind
      ? [
          {
            files: eslintGlobs(tailwind.files ?? source),
            rules: {
              "plumb-react/tokens": "error",
              "plumb-react/class-set": [
                "error",
                { physical: true, joins: true, variants: true, inline: true },
              ],
            } satisfies Linter.RulesRecord,
          },
        ]
      : []),
    ...(clientDirective
      ? [
          {
            files: eslintGlobs(clientDirective),
            rules: {
              "plumb-react/client-directive": "error",
            } satisfies Linter.RulesRecord,
          },
        ]
      : []),
    ...(words
      ? [
          {
            files: eslintGlobs(words),
            rules: {
              "plumb-react/words": wordAttributes
                ? ["error", { attributes: wordAttributes }]
                : "error",
            } satisfies Linter.RulesRecord,
          },
        ]
      : []),
    ...(lines
      ? [
          {
            files: eslintGlobs(lines),
            rules: {
              "plumb-react/lines": "error",
            } satisfies Linter.RulesRecord,
          },
        ]
      : []),
  );
};

export { scopeProblems, validateOptions } from "./options.ts";

export const ruleMetadata = Object.freeze([
  ...customRuleMetadata,
  ...[
    ...new Set([
      ...Object.keys(js.configs.recommended.rules),
      ...tseslint.configs.recommended.flatMap((config) => Object.keys(config.rules ?? {})),
      ...Object.keys(baseRules(true)),
      ...Object.keys(typedRules("backend")),
      ...Object.keys(typeCheckedRules),
      ...Object.keys(reactRules()),
      "max-lines",
    ]),
  ]
    .filter((name) => !name.startsWith("plumb/") && !name.startsWith("plumb-react/"))
    .sort()
    .map((name) => ({
      id: `javascript/${name}`,
      rule: name,
      family: "lint",
      description: `Enforces the release's ${name} rule.`,
      remedy: `Resolve the ${name} diagnostic without weakening the preset.`,
      configurable: false,
      suppressible: true,
      fix: null,
    })),
]);

export const getRuleMetadata = (): typeof ruleMetadata => ruleMetadata;
