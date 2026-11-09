import type { TSESLint } from "@typescript-eslint/utils";

import { constants, isRequireCall } from "../shared/edges.ts";
import type { Node, RuleContext, TSESTree } from "./types.ts";

export type Variable = TSESLint.Scope.Variable;

type Key = string | undefined;

type Step = Key | { uncertain: true } | { rest: true };

export interface Origin {
  path: Key[];
  container?: Key[];
  meta?: true;
  module?: string;
  unknownModule?: true;
  global?: string;
  caught?: true;
  uncertain?: true;
}

const WRAPPERS = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "ParenthesizedExpression",
]);

// bounded lexical provenance complements compiler symbol identity. It never evaluates source.
export const unwrapExpression = (node: Node | null | undefined): Node | null | undefined =>
  node && WRAPPERS.has(node.type) && "expression" in node && typeof node.expression === "object"
    ? unwrapExpression(node.expression)
    : node;

// unit tests drive these helpers with minimal scope mocks, so scope and reference lookups stay
// optional
export function variableOf(
  context: RuleContext,
  node: Node | null | undefined,
): Variable | undefined {
  if (node?.type !== "Identifier") {
    return undefined;
  }
  for (
    let scope: TSESLint.Scope.Scope | null = context.sourceCode?.getScope?.(node);
    scope;
    scope = scope.upper
  ) {
    const variable = scope.set?.get(node.name);
    if (variable) {
      return variable;
    }
  }
  return undefined;
}

interface EffectOrigins {
  origins: (input: Node | null | undefined, seen?: Set<Variable>) => Origin[];
  append: (origins: readonly Origin[], key: Step) => Origin[];
  literal: (node: Node | null | undefined) => string | undefined;
  property: (
    node: TSESTree.MethodDefinition | TSESTree.Property | TSESTree.PropertyDefinition,
  ) => Key;
  initialization: (input: Node | null | undefined, seen?: Set<Variable>) => Node | null | undefined;
}

export function effectOrigins(context: RuleContext): EffectOrigins {
  const modified = (variable: Variable): boolean =>
    (variable.references ?? []).some((reference) => reference.isWrite?.() && !reference.init);
  const { literal } = constants(context);
  const property = (
    node: TSESTree.Property | TSESTree.MethodDefinition | TSESTree.PropertyDefinition,
  ): Key => (!node.computed && node.key.type === "Identifier" ? node.key.name : literal(node.key));
  const paths = (pattern: Node | null | undefined, name: string, prefix: Step[] = []): Step[][] => {
    if (!pattern) {
      return [];
    }
    if (pattern.type === "Identifier") {
      return pattern.name === name ? [prefix] : [];
    }
    if (pattern.type === "AssignmentPattern") {
      return paths(pattern.left, name, [...prefix, { uncertain: true }]);
    }
    if (pattern.type === "RestElement") {
      return paths(pattern.argument, name, [...prefix, { rest: true }]);
    }
    if (pattern.type === "ObjectPattern") {
      return pattern.properties.flatMap((item) =>
        item.type === "RestElement"
          ? paths(item, name, prefix)
          : paths(item.value, name, [...prefix, property(item)]),
      );
    }
    if (pattern.type === "ArrayPattern") {
      return pattern.elements.flatMap((item, index) =>
        paths(item, name, [...prefix, String(index)]),
      );
    }
    return [];
  };
  const append = (origins: readonly Origin[], key: Step): Origin[] =>
    origins.flatMap((origin): Origin[] => {
      if (typeof key === "object") {
        return [{ ...origin, uncertain: true }];
      }
      if (origin.container?.length) {
        if (key !== undefined && key !== origin.container[0]) {
          return [];
        }
        return [
          {
            ...origin,
            container: origin.container.slice(1),
            ...(key === undefined ? { uncertain: true } : {}),
          },
        ];
      }
      return [
        {
          ...origin,
          path: [...origin.path, key],
          ...(key === undefined ? { uncertain: true } : {}),
        },
      ];
    });
  const origins = (input: Node | null | undefined, seen = new Set<Variable>()): Origin[] => {
    const node = unwrapExpression(input);
    if (!node || seen.size > 48) {
      return [];
    }
    if (
      node.type === "MetaProperty" &&
      node.meta.name === "import" &&
      node.property.name === "meta"
    ) {
      return [{ meta: true, path: [] }];
    }
    if (node.type === "MemberExpression") {
      return append(
        origins(node.object, seen),
        !node.computed && node.property.type === "Identifier"
          ? node.property.name
          : literal(node.property),
      );
    }
    if (node.type === "AssignmentExpression") {
      return origins(node.right, seen);
    }
    if (node.type === "ConditionalExpression" || node.type === "LogicalExpression") {
      return [
        ...origins(node.type === "ConditionalExpression" ? node.consequent : node.left, seen),
        ...origins(node.type === "ConditionalExpression" ? node.alternate : node.right, seen),
      ].map((row): Origin => ({ ...row, uncertain: true }));
    }
    if (node.type === "SequenceExpression") {
      return origins(node.expressions.at(-1), seen);
    }
    if (node.type === "ObjectExpression") {
      return node.properties.flatMap((item) => {
        if (item.type === "SpreadElement") {
          return origins(item.argument, seen).map((row): Origin => ({ ...row, uncertain: true }));
        }
        return origins(item.value, seen).map((row): Origin => ({
          ...row,
          container: [property(item), ...(row.container ?? [])],
        }));
      });
    }
    if (node.type === "ArrayExpression") {
      return node.elements.flatMap((item, index) =>
        origins(item, seen).map((row): Origin => ({
          ...row,
          container: [String(index), ...(row.container ?? [])],
        })),
      );
    }
    if (isReflectiveRead(context, node) && node.type === "CallExpression") {
      // Reflect.get(target, key) and Object.getOwnPropertyDescriptor(target, key) read the same
      // property as target[key]
      const [target, key] = node.arguments;
      return append(origins(target, seen), key === undefined ? undefined : literal(key));
    }
    if (node.type === "CallExpression" && isRequireCall(context, node)) {
      const module = literal(node.arguments[0]);
      return [{ ...(module === undefined ? { unknownModule: true } : { module }), path: [] }];
    }
    if (node.type !== "Identifier") {
      return [];
    }
    const variable = variableOf(context, node);
    if (!variable?.defs?.length) {
      return [{ global: node.name, path: [] }];
    }
    if (seen.has(variable)) {
      return [];
    }
    const next = new Set([...seen, variable]),
      result: Origin[] = [];
    for (const definition of variable.defs) {
      if (definition.type === "ImportBinding") {
        const imported = definition.node,
          declaration = definition.parent;
        const module = declaration.type === "ImportDeclaration" ? declaration.source.value : "";
        if (
          !module ||
          (declaration.type === "ImportDeclaration" && declaration.importKind === "type") ||
          (imported.type === "ImportSpecifier" && imported.importKind === "type")
        ) {
          continue;
        }
        result.push({
          module,
          path:
            imported.type === "ImportSpecifier"
              ? [
                  imported.imported.type === "Identifier"
                    ? imported.imported.name
                    : imported.imported.value,
                ]
              : imported.type === "ImportDefaultSpecifier"
                ? ["default"]
                : [],
        });
      }
      if (definition.type === "Variable") {
        for (const path of paths(definition.node.id, node.name)) {
          let values = origins(definition.node.init, next);
          for (const key of path) {
            values = append(values, key);
          }
          result.push(...values);
        }
      }
      if (definition.type === "CatchClause") {
        result.push({ caught: true, path: [] });
      }
    }
    if (modified(variable)) {
      for (const reference of variable.references ?? []) {
        const assignment = reference.identifier?.parent;
        if (reference.isWrite() && !reference.init && assignment?.type === "AssignmentExpression") {
          result.push(...origins(assignment.right, next));
        }
      }
      return result.map((row): Origin => ({ ...row, uncertain: true }));
    }
    return result;
  };
  const initialization = (
    input: Node | null | undefined,
    seen = new Set<Variable>(),
  ): Node | null | undefined => {
    const node = unwrapExpression(input);
    if (node?.type !== "Identifier") {
      return node;
    }
    const variable = variableOf(context, node);
    if (!variable || seen.has(variable) || modified(variable)) {
      return node;
    }
    const definition = variable.defs?.find(
      (item) => item.type === "Variable" && item.node.id.type === "Identifier",
    );
    const init = definition?.type === "Variable" ? definition.node.init : null;
    return init ? initialization(init, new Set([...seen, variable])) : node;
  };
  return { origins, append, literal, property, initialization };
}

// reflective reads of a property: a missing or non-constant key is an unknown key, which the caller
// reports as incomplete
export function isReflectiveRead(context: RuleContext, node: Node): boolean {
  const callee = node.type === "CallExpression" ? node.callee : undefined;
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.property.type !== "Identifier" ||
    variableOf(context, callee.object)?.defs?.length
  ) {
    return false;
  }
  const method = callee.property.name;
  if (callee.object.name === "Reflect") {
    return ["get", "getOwnPropertyDescriptor"].includes(method);
  }
  return (
    callee.object.name === "Object" &&
    ["getOwnPropertyDescriptor", "getOwnPropertyDescriptors"].includes(method)
  );
}

export function isValueReference(node: Node): boolean {
  const parent = node.parent;
  if (!parent) {
    return true;
  }
  if (
    [
      "ImportSpecifier",
      "ImportDefaultSpecifier",
      "ImportNamespaceSpecifier",
      "ExportSpecifier",
    ].includes(parent.type)
  ) {
    return false;
  }
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) {
    return false;
  }
  if (
    (parent.type === "Property" ||
      parent.type === "MethodDefinition" ||
      parent.type === "PropertyDefinition") &&
    parent.key === node &&
    !parent.computed &&
    !(parent.type === "Property" && parent.shorthand)
  ) {
    return false;
  }
  if (
    (parent.type === "VariableDeclarator" ||
      parent.type === "FunctionDeclaration" ||
      parent.type === "FunctionExpression" ||
      parent.type === "ClassDeclaration" ||
      parent.type === "ClassExpression") &&
    parent.id === node
  ) {
    return false;
  }
  if (["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent.type)) {
    return false;
  }
  for (let cursor: Node | undefined = parent; cursor; cursor = cursor.parent) {
    if (
      [
        "TSTypeAnnotation",
        "TSTypeReference",
        "TSTypeQuery",
        "TSInterfaceDeclaration",
        "TSTypeAliasDeclaration",
        "TSImportType",
        "TSTypeParameter",
      ].includes(cursor.type)
    ) {
      return false;
    }
    if (
      ["Statement", "Expression"].some((suffix) => cursor?.type.endsWith(suffix)) ||
      cursor.type === "Program"
    ) {
      break;
    }
  }
  return true;
}
