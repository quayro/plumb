import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { globMatches } from "../shared/glob.ts";
import {
  flag,
  type FromSchema,
  isObject,
  list,
  object,
  text,
  validateSchema,
} from "./json-schema.ts";

const strings = list(text);
const files = list(text, 1);
const glob = { ...text, format: "glob" } as const;
const patterns = list(glob, 1);
const regex = { ...text, format: "regex" } as const;
const ruleRoot = { root: text } as const;
const imported = object(
  {
    from: text,
    name: { ...text, pattern: "^(?:default|[A-Za-z_$][A-Za-z0-9_$]*)$" },
  },
  ["from", "name"],
);
const errorHandlingSchema = object({
  files: patterns,
  factories: list(imported, 1),
  result: imported,
  background: list(imported, 1),
});

export type ErrorHandlingOptions = FromSchema<typeof errorHandlingSchema>;

export const DEFAULT_SOURCE = Object.freeze(["src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]);

// convert Plumb's literal path characters to ESLint globs without changing root or folder scopes
export const eslintGlobs = (patterns: readonly string[]): string[] =>
  patterns.map((value) => {
    const raw = value.replaceAll("\\", "/");
    let clean = raw.replace(/^(?:\.\/)+/, "").replace(/\/{2,}/g, "/");
    if (!clean || clean === ".") {
      return "**";
    }
    if (clean.endsWith("/")) {
      clean += "**";
    }
    return clean.replace(/[[\]()]/g, (character) => `[${character}]`);
  });

const ruleSchemas = {
  "plumb/layers": object(
    {
      ...ruleRoot,
      layers: list(
        {
          type: "array",
          items: [regex, { type: "number", minimum: 0 }, text],
          minItems: 3,
          maxItems: 3,
        } as const,
        1,
      ),
      packages: list(
        object({ tree: text, source: text, reason: text }, ["tree", "source", "reason"]),
      ),
    },
    ["layers"],
  ),
  "plumb/owners": object(
    {
      ...ruleRoot,
      rows: list(
        {
          ...object(
            {
              owner: list(glob),
              message: text,
              importFrom: text,
              name: text,
              global: text,
              member: text,
              meta: text,
              now: { const: true },
              construct: files,
              dynamicImport: { const: true },
              jsxAttribute: text,
              value: { type: "string" },
            },
            ["owner", "message"],
          ),
          anyOf: [
            ...[
              "global",
              "member",
              "meta",
              "now",
              "construct",
              "dynamicImport",
              "jsxAttribute",
            ].map((name) => ({ required: [name] })),
            { required: ["importFrom", "name"] },
          ],
        },
        1,
      ),
    },
    ["rows"],
  ),
  "plumb/export-prefix": object(
    {
      ...ruleRoot,
      map: list(
        object(
          {
            match: regex,
            names: strings,
            singular: { enum: [true, false, "both"] },
          } as const,
          ["match", "names"],
        ),
        1,
      ),
      aliases: { type: "object", additionalProperties: text },
      kinds: list({ enum: ["camel", "pascal", "constant"] }, 1),
      exceptions: list(
        object({ file: text, names: files, reason: text }, ["file", "names", "reason"]),
      ),
      skip: list(object({ files: patterns, names: regex }, ["files", "names"])),
      types: flag,
    },
    ["map"],
  ),
  "plumb/literal-calls": object(
    {
      calls: list(
        object(
          {
            callee: regex,
            args: list({
              enum: ["literal", "literal?", "literal-object", "literal-array"],
            }),
            moduleScope: flag,
          },
          ["callee", "args"],
        ),
        1,
      ),
    },
    ["calls"],
  ),
  "plumb/chained-call": object({ object: text, methods: files, chain: text }, [
    "object",
    "methods",
    "chain",
  ]),
  "plumb/keyed-numbers": object({ keys: files, message: text }, ["keys"]),
  "plumb/plain-module": {
    ...object({ packages: regex, specifiers: regex, extensions: files, reason: text }, ["reason"]),
    anyOf: [{ required: ["packages"] }, { required: ["specifiers"] }, { required: ["extensions"] }],
  },
  "plumb-react/tokens": object({ allow: strings }),
  "plumb-react/class-set": object({
    physical: flag,
    joins: flag,
    variants: flag,
    inline: flag,
  }),
  "plumb/test-assertions": object({ root: text, assertions: regex }),
} as const;

type RuleName = keyof typeof ruleSchemas;

export type RuleOptions<N extends RuleName> = FromSchema<(typeof ruleSchemas)[N]>;

const isRuleName = (name: string): name is RuleName => Object.hasOwn(ruleSchemas, name);

// a JSON copy of one of the schemas above is an object schema by construction
const isJsonSchema = (value: unknown): value is JSONSchema4 => isObject(value);

export const eslintRuleSchema = (name: RuleName): JSONSchema4[] => {
  const copy: unknown = JSON.parse(
    JSON.stringify(ruleSchemas[name], (key, value: unknown) =>
      key === "format" ? undefined : value,
    ),
  );
  if (!isJsonSchema(copy)) {
    throw new TypeError(`${name}: rule schema must be an object`);
  }
  return [copy];
};

const noOptions = [
  "plumb/class-style",
  "plumb-react/client-directive",
  "plumb-react/words",
  "plumb-react/lines",
];

export const configurableRules = new Set([...Object.keys(ruleSchemas), ...noOptions]);

const optionSchema = object({
  root: text,
  profile: { enum: ["backend", "react"] },
  source: patterns,
  logCalls: regex,
  errorFactory: object({ message: text, allowIn: patterns }, ["message"]),
  errorHandling: errorHandlingSchema,
  tailwind: object({ files: patterns }),
  clientDirective: patterns,
  words: patterns,
  wordAttributes: strings,
  tests: object({ assertions: regex }),
  dependencies: object({ allowed: list(text) }),
  knip: object({ exports: flag }),
  lines: patterns,
  syntax: list(
    object(
      {
        files: patterns,
        selectors: list(object({ selector: text, message: text }, ["selector", "message"]), 1),
      },
      ["selectors"],
    ),
  ),
  rules: list(
    object(
      {
        files: patterns,
        rules: { type: "object", minProperties: 1, additionalProperties: true },
      },
      ["rules"],
    ),
  ),
});

export type PackOptions = FromSchema<typeof optionSchema>;

export function validateOptions(options: unknown): asserts options is PackOptions {
  validateSchema(options, optionSchema);
  checkRules(options);
}

function checkRules(options: PackOptions): void {
  const presetRules = new Set<string>();
  if (options.tailwind) {
    ["plumb-react/tokens", "plumb-react/class-set"].forEach((name) => presetRules.add(name));
  }
  for (const [key, name] of [
    ["clientDirective", "client-directive"],
    ["words", "words"],
    ["lines", "lines"],
  ] as const) {
    if (options[key]) {
      presetRules.add(`plumb-react/${name}`);
    }
  }
  for (const [index, block] of (options.rules ?? []).entries()) {
    for (const [name, setting] of Object.entries(block.rules)) {
      const location = `javascript.rules[${index}].rules.${name}`;
      if (!configurableRules.has(name) || presetRules.has(name)) {
        throw new TypeError(
          `${location}: cannot reconfigure a preset rule; only supported opt-in contracts may be added`,
        );
      }
      const array: unknown[] = Array.isArray(setting) ? setting : [setting];
      if (array[0] !== "error" && array[0] !== 2) {
        throw new TypeError(`${location}: every rule must be an error`);
      }
      const schema = isRuleName(name) ? ruleSchemas[name] : undefined;
      if (array.length > (schema ? 2 : 1)) {
        throw new TypeError(`${location}: unsupported rule options`);
      }
      if (schema) {
        validateSchema(array[1] ?? {}, schema, location);
        if (isObject(array[1]) && Object.hasOwn(array[1], "root")) {
          throw new TypeError(`${location}: root is supplied by the project, never by a rule`);
        }
      }
    }
  }
}

export const scopeProblems = (options: PackOptions, relativeFiles: readonly string[]): string[] => {
  const scopes: [string, readonly string[]][] = [];
  if (
    !relativeFiles.length &&
    Object.keys(options).some((key) => !["root", "profile"].includes(key))
  ) {
    return [
      "javascript: configured language contracts have no selected JavaScript or TypeScript source",
    ];
  }
  const add = (name: string, patterns: readonly string[]): number =>
    scopes.push([`javascript.${name}`, patterns]);
  if (options.source) {
    add("source", options.source);
  }
  if (options.errorFactory?.allowIn) {
    add("errorFactory.allowIn", options.errorFactory.allowIn);
  }
  if (options.errorHandling) {
    add("errorHandling.files", options.errorHandling.files ?? ["."]);
  }
  if (options.tailwind) {
    add("tailwind.files", options.tailwind.files ?? options.source ?? DEFAULT_SOURCE);
  }
  for (const name of ["clientDirective", "words", "lines"] as const) {
    const patterns = options[name];
    if (patterns) {
      add(name, patterns);
    }
  }
  (options.syntax ?? []).forEach((row, index) => add(`syntax[${index}].files`, row.files ?? ["."]));
  (options.rules ?? []).forEach((row, index) => add(`rules[${index}].files`, row.files ?? ["."]));
  return scopes
    .filter(([, patterns]) => !relativeFiles.some((file) => globMatches(patterns, file)))
    .map(
      ([name]) => `${name}: matches no selected source files; correct or remove the unused scope`,
    );
};
