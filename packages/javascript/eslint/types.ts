import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { isRecord } from "../../../src/schema.ts";
import type { ModuleResolver } from "../shared/module-resolver.ts";

// the pack's rules see typescript-eslint's AST, so they are typed against it rather than plain ESTree
export type RuleContext<Options extends readonly unknown[] = readonly unknown[]> = Readonly<
  TSESLint.RuleContext<string, Options>
>;

export type RuleListener = TSESLint.RuleListener;

export type Node = TSESTree.Node;

export interface RuleModule<Options extends readonly unknown[] = readonly unknown[]> {
  meta: {
    type: "problem" | "suggestion" | "layout";
    fixable?: "code" | "whitespace";
    hasSuggestions?: boolean;
    schema: JSONSchema4[];
    messages: Record<string, string>;
    docs?: Record<string, unknown>;
  };
  create(context: RuleContext<Options>): RuleListener;
}

export type { TSESTree };

export interface ImportReference {
  from: string;
  name: string;
}

interface BackgroundCall {
  voidReturn: boolean;
  asyncArgument: boolean;
}

export interface ResultExport {
  name: string;
  valid: boolean;
  unresolved: boolean;
}

// answers from the checker's trusted Programs; undefined means the types cannot settle the question
export interface TypedServices {
  matches: (context: RuleContext, node: Node, reference: ImportReference) => boolean | undefined;
  promise: (context: RuleContext, node: Node) => boolean | undefined;
  background: (context: RuleContext, node: Node) => BackgroundCall | undefined;
  resultExports: (context: RuleContext, reference: ImportReference) => ResultExport[] | undefined;
}

// rules ask a resolver only whether a specifier is local and where it runs from
type RuleResolver = Pick<ModuleResolver, "isLocal" | "runtime">;

export interface PlumbSettings {
  plumbTyped?: TypedServices;
  plumbResolver?: RuleResolver;
  plumbTrustedPrograms?: unknown;
}

// plumb writes these settings into the flat config it builds; a rule never receives them from a
// candidate
export const plumbSettings = (context: RuleContext): PlumbSettings => {
  const { plumbTyped, plumbResolver, plumbTrustedPrograms } = context.settings;
  return {
    ...(hasMethods<TypedServices>(plumbTyped, [
      "matches",
      "promise",
      "background",
      "resultExports",
    ]) && {
      plumbTyped,
    }),
    ...(hasMethods<RuleResolver>(plumbResolver, ["isLocal", "runtime"]) && {
      plumbResolver,
    }),
    plumbTrustedPrograms,
  };
};

// a settings value is the service Plumb installed when it carries every method that service exposes
function hasMethods<T>(value: unknown, methods: readonly (keyof T & string)[]): value is T {
  return isRecord(value) && methods.every((method) => typeof value[method] === "function");
}
