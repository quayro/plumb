import ts from "typescript";

import { planConventions } from "../../../src/conventions.ts";
import type { Diagnostic } from "../../../src/diagnostics.ts";
import { errorMessage } from "../../../src/errors.ts";
import { canonical, digest } from "../../../src/files.ts";
import { Analysis, type AnalysisContext, AnalysisError } from "./analysis.ts";
import { isScript, walk } from "./source-syntax.ts";

export type ConventionsContext = AnalysisContext & Parameters<typeof planConventions>[0];

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

export const RULES = [
  [
    "conventions.budget",
    "Role implementations stay within explicit function size, parameter and nesting limits.",
  ],
  [
    "conventions.duplication",
    "Token-identical statement blocks stay within their role's explicit copy budget.",
  ],
].map(([id, description]) => ({
  id,
  description,
  remedy:
    "Simplify the implementation or reuse the shared behavior; review budget changes separately.",
  suppressible: true,
}));

const functionLike = (node: ts.Node): node is FunctionLike =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

const branch = (node: ts.Node): boolean =>
  ts.isIfStatement(node) ||
  ts.isSwitchStatement(node) ||
  ts.isForStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isWhileStatement(node) ||
  ts.isDoStatement(node) ||
  ts.isTryStatement(node) ||
  ts.isConditionalExpression(node);

function nesting(body: ts.Node): number {
  let maximum = 0;
  const visit = (node: ts.Node, depth: number): void => {
    if (functionLike(node)) {
      return;
    }
    const next = depth + (branch(node) ? 1 : 0);
    maximum = Math.max(maximum, next);
    node.forEachChild((child) => {
      visit(child, next);
    });
  };
  visit(body, 0);
  return maximum;
}

// AST token leaves preserve literal/identifier spelling, including regex and template content.
// trivia and positions are absent; this deliberately does not infer semantic near-duplicates.
function fingerprint(node: ts.Node, source: ts.SourceFile): string {
  const tokens: [ts.SyntaxKind, string][] = [];
  const visit = (child: ts.Node): void => {
    if (child.kind >= ts.SyntaxKind.FirstJSDocNode && child.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = child.getChildren(source);
    if (children.length) {
      for (const entry of children) {
        visit(entry);
      }
    } else if (child.kind <= ts.SyntaxKind.LastToken) {
      tokens.push([child.kind, child.getText(source)]);
    }
  };
  visit(node);
  return digest(canonical(tokens));
}

export function checkMetrics(
  context: ConventionsContext,
  shared?: Analysis,
  suppliedPlan?: ReturnType<typeof planConventions>,
): Diagnostic[] {
  const analysis = shared ?? new Analysis(context),
    plan = suppliedPlan ?? planConventions(context),
    diagnostics: Diagnostic[] = [];
  if (!context.config.conventions || plan.diagnostics.length) {
    return diagnostics;
  }
  for (const role of context.config.conventions.roles) {
    const budgets = role.javascript?.budgets;
    if (!budgets) {
      continue;
    }
    const { duplicateBlocks } = budgets;
    const copies = new Map<string, { file: string; node: ts.Node }[]>(),
      files = plan.roles.find((entry) => entry.id === role.id)?.files ?? [];
    for (const file of files) {
      try {
        if (!isScript(file)) {
          throw new AnalysisError(
            file,
            `Role ${role.id} declares JavaScript budgets for an unsupported source language.`,
          );
        }
        const source = analysis.source(file);
        walk(source, (node) => {
          if (functionLike(node) && node.body) {
            const start = source.getLineAndCharacterOfPosition(node.body.getStart(source)).line;
            const end = source.getLineAndCharacterOfPosition(
              Math.max(node.body.getStart(source), node.body.end - 1),
            ).line;
            const actual = {
              functionLines: end - start + 1,
              maxParameters: node.parameters.length,
              maxNesting: nesting(node.body),
            };
            for (const metric of ["functionLines", "maxParameters", "maxNesting"] as const) {
              const count = actual[metric],
                limit = budgets[metric];
              if (limit !== undefined && count > limit) {
                diagnostics.push(
                  analysis.issue(
                    "conventions.budget",
                    file,
                    `Role ${role.id}: ${metric} is ${count}; allowed maximum is ${limit}.`,
                    "Reduce this function's size, parameter count or control-flow nesting.",
                    node,
                  ),
                );
              }
            }
          }
          if (
            duplicateBlocks &&
            ts.isBlock(node) &&
            node.statements.length >= duplicateBlocks.minStatements
          ) {
            const hash = fingerprint(node, source),
              group = copies.get(hash) ?? [];
            group.push({ file, node });
            copies.set(hash, group);
          }
        });
      } catch (error) {
        diagnostics.push({
          rule: "conventions.analysis",
          path: error instanceof AnalysisError ? error.path : file,
          message: `Role ${role.id} budgets: ${errorMessage(error)}`,
          remedy: "Restore readable, parsable inputs for every selected budget scope.",
          status: "incomplete",
          suppressible: false,
        });
      }
    }
    for (const group of copies.values()) {
      const [first] = group;
      if (!duplicateBlocks || !first || group.length <= duplicateBlocks.maxCopies) {
        continue;
      }
      const { file, node } = first;
      const locations = group.map((entry) => ({
        path: entry.file,
        line:
          entry.node.getSourceFile().getLineAndCharacterOfPosition(entry.node.getStart()).line + 1,
      }));
      diagnostics.push({
        ...analysis.issue(
          "conventions.duplication",
          file,
          `Role ${role.id}: ${group.length} token-identical blocks exceed the ${duplicateBlocks.maxCopies}-copy limit.`,
          "Extract the shared behavior or use an explicit, bounded exception for intentional duplication.",
          node,
        ),
        relatedLocations: locations,
      });
    }
  }
  return diagnostics;
}
