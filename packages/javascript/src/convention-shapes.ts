import ts from "typescript";

import type { Diagnostic } from "../../../src/diagnostics.ts";
import { globMatches } from "../../../src/files.ts";
import { type Analysis, AnalysisError } from "./analysis.ts";
import {
  exportedSymbol,
  type ExportView,
  type NodeAssertion,
  type Role,
} from "./convention-view.ts";
import { edges, literal, walk } from "./source-syntax.ts";

type Declared =
  | ts.FunctionDeclaration
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.VariableDeclaration
  | ts.MethodDeclaration
  | ts.MethodSignature
  | ts.PropertyDeclaration
  | ts.PropertySignature
  | ts.ConstructorDeclaration;

export function imports(
  analysis: Analysis,
  file: string,
  role: Role & { imports: NonNullable<Role["imports"]> },
  source: ts.SourceFile,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const edge of edges(source)) {
    const { specifier } = edge;
    if (!specifier) {
      throw new AnalysisError(
        file,
        `Role ${role.id}: a computed import cannot prove the declared import boundary.`,
      );
    }
    const deniedLiteral = !!role.imports.deny && globMatches(role.imports.deny, specifier);
    const target = deniedLiteral
      ? undefined
      : analysis.target(file, specifier, undefined, !edge.typeOnly);
    const matches = (patterns: string | readonly string[]): boolean =>
      globMatches(patterns, specifier) || (!!target && globMatches(patterns, target));
    if (
      deniedLiteral ||
      (role.imports.deny && matches(role.imports.deny)) ||
      (role.imports.allow && !matches(role.imports.allow))
    ) {
      diagnostics.push(
        analysis.issue(
          "conventions.imports",
          file,
          `Role ${role.id} does not allow dependency ${target ?? specifier}.`,
          "Route this dependency through an allowed module or review a narrow boundary exception.",
          edge.node,
        ),
      );
    }
  }
  return diagnostics;
}

export function exportsOf(
  analysis: Analysis,
  file: string,
  role: Role & { exports: NonNullable<Role["exports"]> },
  view: ExportView,
): Diagnostic[] {
  const names = view.symbols.map((symbol) => symbol.name),
    diagnostics: Diagnostic[] = [];
  for (const name of role.exports.require ?? []) {
    if (!names.includes(name)) {
      diagnostics.push(
        analysis.issue(
          "conventions.exports",
          file,
          `Role ${role.id} requires export ${name}.`,
          "Declare or reexport the required public name.",
        ),
      );
    }
  }
  for (const name of names) {
    if (
      (role.exports.allow && !role.exports.allow.includes(name)) ||
      (role.exports.name && !new RegExp(role.exports.name).test(name))
    ) {
      diagnostics.push(
        analysis.issue(
          "conventions.exports",
          file,
          `Role ${role.id} does not allow export ${name}.`,
          "Keep only public names allowed by this role.",
        ),
      );
    }
  }
  return diagnostics;
}

const kindOf = (node: ts.Node): string | undefined => {
  if (ts.isFunctionDeclaration(node)) {
    return "function";
  }
  if (ts.isClassDeclaration(node)) {
    return "class";
  }
  if (ts.isInterfaceDeclaration(node)) {
    return "interface";
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return "type";
  }
  if (ts.isVariableDeclaration(node)) {
    return "variable";
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    return "method";
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    return "property";
  }
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  return undefined;
};

const isDeclared = (node: ts.Node): node is Declared => kindOf(node) !== undefined;

const topLevel = (node: ts.Node): boolean =>
  ts.isSourceFile(node.parent) ||
  (ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    ts.isVariableStatement(node.parent.parent) &&
    ts.isSourceFile(node.parent.parent.parent));

const bindingNames = (name: ts.BindingName): ts.Identifier[] =>
  ts.isIdentifier(name)
    ? [name]
    : name.elements.flatMap((element) =>
        ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
      );

function namesOf(node: Declared): { name: string | undefined; node: ts.Node }[] {
  if (ts.isVariableDeclaration(node)) {
    return bindingNames(node.name).map((name) => ({
      name: name.text,
      node: name,
    }));
  }
  if (ts.isConstructorDeclaration(node)) {
    return [{ name: "constructor", node }];
  }
  if (!node.name) {
    return [
      {
        name: ts
          .getModifiers(node)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
          ? "default"
          : undefined,
        node,
      },
    ];
  }
  const name = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name;
  return [
    {
      name:
        (ts.isIdentifier(name) && !ts.isComputedPropertyName(node.name)) ||
        ts.isPrivateIdentifier(name) ||
        literal(name) ||
        ts.isNumericLiteral(name)
          ? name.text
          : undefined,
      node: node.name,
    },
  ];
}

export function nodes(
  analysis: Analysis,
  file: string,
  role: Role,
  assertion: NodeAssertion,
  source: ts.SourceFile,
  view: ExportView | undefined,
): Diagnostic[] {
  const matches: ts.Node[] = [];
  walk(source, (node) => {
    const kind = kindOf(node),
      selection = assertion.select;
    if (
      !kind ||
      !isDeclared(node) ||
      !selection.kinds.some((item) => item === kind) ||
      (selection.topLevel !== undefined && topLevel(node) !== selection.topLevel)
    ) {
      return;
    }
    for (const name of namesOf(node)) {
      if (selection.names && name.name === undefined) {
        throw new AnalysisError(
          file,
          `Assertion ${assertion.id}: a computed declaration name cannot be selected reliably.`,
        );
      }
      if (selection.names && !selection.names.some((item) => item === name.name)) {
        continue;
      }
      if (selection.exported !== undefined) {
        if (!view) {
          throw new AnalysisError(file, `Assertion ${assertion.id}: export evidence is missing.`);
        }
        const symbol = exportedSymbol(view.checker, view.checker.getSymbolAtLocation(name.node));
        const exported =
          (!!symbol && view.targets.has(symbol)) ||
          [...view.targets].some((target) => target.declarations?.includes(node));
        if (selection.exported !== exported) {
          continue;
        }
      }
      matches.push(node);
    }
  });
  const min = assertion.count.min ?? 0,
    max = assertion.count.max ?? Infinity;
  return matches.length >= min && matches.length <= max
    ? []
    : [
        analysis.issue(
          "conventions.nodes",
          file,
          `Role ${role.id}, assertion ${assertion.id}: matched ${matches.length} declarations; expected ${min}..${max === Infinity ? "unbounded" : max}.`,
          "Add or reshape the required declarations, or remove declarations beyond the approved count.",
          matches[0],
        ),
      ];
}
