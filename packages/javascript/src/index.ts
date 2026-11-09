import { resolve } from "node:path";

import ts from "typescript";

import { planConventions } from "../../../src/conventions.ts";
import type { Diagnostic } from "../../../src/diagnostics.ts";
import { Analysis, AnalysisError, type Contract, type Contracts } from "./analysis.ts";
import { boundaries, importGraph, lazyModules, manifest, writtenOnce } from "./contracts.ts";
import { checkConventions, RULES as CONVENTION_RULES } from "./conventions.ts";
import { surfaceProblems, surfaceProposal, uniqueExports } from "./exports.ts";
import { checkMetrics, type ConventionsContext, RULES as METRIC_RULES } from "./metrics.ts";
import { registrations } from "./registrations.ts";
import { isScript, isTest, literal, walk } from "./source-syntax.ts";

export { Analysis } from "./analysis.ts";

export const RULES = [
  ...CONVENTION_RULES,
  ...METRIC_RULES,
  {
    id: "javascript.analysis",
    description:
      "Every configured semantic input parses and every local edge used by a contract resolves.",
    remedy: "Restore the missing input or correct its syntax, compiler configuration or scope.",
    suppressible: false,
  },
  {
    id: "contracts.boundaries",
    description: "Static, type and literal dynamic dependencies respect module boundaries.",
    remedy: "Route the dependency through an allowed layer or owner.",
    suppressible: true,
  },
  {
    id: "contracts.manifests",
    description: "A literal catalogue covers its entry and direct local runtime dependencies.",
    remedy: "Correct the source catalogue and remove stale exemptions.",
    suppressible: true,
  },
  {
    id: "contracts.registrations",
    description:
      "Named synchronous registrars have exactly one direct lexical call in the configured composition function.",
    remedy:
      "Use a synchronous non-generator registrar and compose it once directly; runtime execution remains a separate property.",
    suppressible: true,
  },
  {
    id: "contracts.lazy-modules",
    description: "Literal lazy imports, their catalogue and their filenames agree.",
    remedy: "Keep the lazy-module catalogue and naming scope in agreement.",
    suppressible: true,
  },
  {
    id: "contracts.written-once",
    description: "Selected table literals are not repeated in value positions elsewhere.",
    remedy: "Import the table's named value.",
    suppressible: true,
  },
  {
    id: "contracts.import-graphs",
    description:
      "The static runtime dependency graph stays within its allowed package, specifier and file kinds.",
    remedy: "Remove a refused dependency; this contract does not prove dynamic reachability.",
    suppressible: true,
  },
  {
    id: "exports.unique",
    description:
      "Owned exported names and renamed reexports have one owner within the selected folders.",
    remedy: "Give each owned exported name a unique name.",
    suppressible: true,
  },
  {
    id: "exports.surface",
    description:
      "Each package export condition agrees with its reviewed public names or opt-in declaration-signature snapshot.",
    remedy:
      "Review the API change and explicitly propose a new snapshot; fix never updates expectations.",
    suppressible: true,
  },
  {
    id: "tests.focused",
    description:
      "Conventional test files contain no focused test/it/describe/suite calls or only options.",
    remedy:
      "Remove the focus marker so the whole suite runs; custom test wrappers need their own adapter support.",
    suppressible: true,
  },
  {
    id: "tests.skipped",
    description: "Conventional test files contain no skip/todo markers on recognized test calls.",
    remedy: "Restore the test or record a narrow reviewed exception.",
    suppressible: true,
  },
];

const testCall = (node: ts.Node): { base: string; properties: string[] } | undefined => {
  if (ts.isIdentifier(node)) {
    return { base: node.text, properties: [] };
  }
  if (ts.isCallExpression(node)) {
    return testCall(node.expression);
  }
  if (ts.isPropertyAccessExpression(node)) {
    const path = testCall(node.expression);
    return (
      path && {
        base: path.base,
        properties: [...path.properties, node.name.text],
      }
    );
  }
  if (ts.isElementAccessExpression(node) && literal(node.argumentExpression)) {
    const path = testCall(node.expression);
    return (
      path && {
        base: path.base,
        properties: [...path.properties, node.argumentExpression.text],
      }
    );
  }
  return undefined;
};

const hygiene = (analysis: Analysis): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const names = new Set([
    "test",
    "it",
    "describe",
    "suite",
    "xtest",
    "xit",
    "xdescribe",
    "fit",
    "fdescribe",
    "ftest",
  ]);
  const skipping = ["skip", "todo", "skipIf", "runIf"],
    focusedNames = ["fit", "fdescribe", "ftest"],
    skippedNames = ["xtest", "xit", "xdescribe"];
  const packages = new Set([
    "node:test",
    "bun:test",
    "vitest",
    "@jest/globals",
    "@playwright/test",
    "mocha",
  ]);
  for (const file of analysis.files.filter((path) => isScript(path) && isTest(path))) {
    const source = analysis.source(file);
    const calls = new Set(names);
    const namespaces = new Set<string>();
    const contexts = new Set<string>();
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !literal(statement.moduleSpecifier) ||
        !packages.has(statement.moduleSpecifier.text)
      ) {
        continue;
      }
      if (statement.importClause?.name) {
        calls.add(statement.importClause.name.text);
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (names.has((binding.propertyName ?? binding.name).text)) {
            calls.add(binding.name.text);
          }
        }
      }
    }
    walk(source, (node) => {
      if (!ts.isCallExpression(node)) {
        return;
      }
      if (
        (ts.isCallExpression(node.parent) ||
          ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      ) {
        return;
      }
      const path = testCall(node.expression);
      // this.skip() and a test context's skip() or todo() skip the running test
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ["skip", "todo"].includes(node.expression.name.text)
      ) {
        diagnostics.push(
          analysis.issue(
            "tests.skipped",
            file,
            "A recognized test is skipped or left as a todo.",
            "Implement the test or record an approved narrow exception with a reason.",
            node,
          ),
        );
        return;
      }
      if (
        !path ||
        (!calls.has(path.base) &&
          !(namespaces.has(path.base) && names.has(path.properties[0] ?? "")) &&
          !(contexts.has(path.base) && ["test", "skip", "todo"].includes(path.properties[0] ?? "")))
      ) {
        return;
      }
      let focused = path.properties.includes("only") || focusedNames.includes(path.base);
      let skipped =
        path.properties.some((name) => skipping.includes(name)) ||
        skippedNames.includes(path.base) ||
        (contexts.has(path.base) && ["skip", "todo"].includes(path.properties[0] ?? ""));
      for (const argument of node.arguments) {
        if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
          const parameter = argument.parameters[0]?.name;
          if (parameter && ts.isIdentifier(parameter)) {
            contexts.add(parameter.text);
          }
        }
        if (!ts.isObjectLiteralExpression(argument)) {
          continue;
        }
        for (const property of argument.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            property.initializer.kind === ts.SyntaxKind.FalseKeyword
          ) {
            continue;
          }
          const name =
            ts.isIdentifier(property.name) || literal(property.name) ? property.name.text : "";
          focused ||= name === "only";
          skipped ||= name === "skip" || name === "todo";
        }
      }
      if (focused) {
        diagnostics.push(
          analysis.issue(
            "tests.focused",
            file,
            "A focused test can leave the rest of the suite unexecuted.",
            "Remove.only or the only option before submitting this change.",
            node,
          ),
        );
      }
      if (skipped) {
        diagnostics.push(
          analysis.issue(
            "tests.skipped",
            file,
            "A recognized test is skipped or left as a todo.",
            "Implement the test or record an approved narrow exception with a reason.",
            node,
          ),
        );
      }
    });
  }
  return diagnostics;
};

const incomplete = (error: unknown, contract: string): Diagnostic => ({
  rule: "javascript.analysis",
  path: error instanceof AnalysisError ? error.path : "plumb.json",
  message: `${contract}: ${error instanceof Error ? error.message : "Semantic analysis failed."}`,
  remedy:
    error instanceof AnalysisError
      ? error.remedy
      : "Correct the adapter input or tool installation so the requested analysis can finish.",
  status: "incomplete",
  suppressible: false,
});

// both check and fix call this read-only function. Contract acceptance is a separate operation.
export const check = (context: ConventionsContext, shared?: Analysis): Diagnostic[] => {
  let analysis: Analysis;
  try {
    analysis = shared ?? new Analysis(context);
  } catch (error) {
    return [incomplete(error, "inventory")];
  }
  const diagnostics: Diagnostic[] = [];
  const run = (name: string, inspect: () => Diagnostic[]): void => {
    try {
      diagnostics.push(...inspect());
    } catch (error) {
      diagnostics.push(incomplete(error, name));
    }
  };
  const contracts: Contracts = context.config.contracts ?? {};
  const family = <K extends keyof Contracts>(
    name: K,
    inspect: (analysis: Analysis, contract: Contract<K>) => Diagnostic[],
  ): void => {
    const listed: readonly Contract<K>[] = contracts[name] ?? [];
    for (const contract of listed) {
      run(name, () => inspect(analysis, contract));
    }
  };
  family("boundaries", boundaries);
  family("manifests", manifest);
  family("registrations", registrations);
  family("lazyModules", lazyModules);
  family("writtenOnce", writtenOnce);
  family("importGraphs", importGraph);
  if (context.config.conventions) {
    const roles = planConventions(context);
    run("conventions", () => checkConventions(context, analysis, roles));
    run("role budgets", () => checkMetrics(context, analysis, roles));
  }
  for (const project of context.config.projects ?? []) {
    if (!["typescript", "react"].includes(project.profile)) {
      continue;
    }
    const { uniqueExports: folders } = project;
    if (folders?.length) {
      run("uniqueExports", () => {
        const patterns = folders.map(
          (folder) => `${analysis.relative(resolve(analysis.root, project.root, folder))}/**`,
        );
        const files = analysis
          .required(patterns)
          .filter((file) => !isTest(file) && !/\.d\.[cm]?ts$/.test(file));
        if (!files.length) {
          throw new AnalysisError(
            "plumb.json",
            "The unique-export scope contains no implementation modules.",
          );
        }
        return uniqueExports(analysis, files);
      });
    }
    if (project.surface) {
      run("surface", () => surfaceProblems(analysis, project));
    }
  }
  if (context.config.preset === "ozmikhail") {
    run("test hygiene", () => hygiene(analysis));
  }
  return diagnostics.sort(
    (a, b) =>
      (a.path ?? "").localeCompare(b.path ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.rule.localeCompare(b.rule) ||
      a.message.localeCompare(b.message),
  );
};

export const snapshot = (
  context: ConventionsContext,
  projectRoot?: string,
  shared?: Analysis,
): { path: string; content: string }[] => {
  const analysis = shared ?? new Analysis(context);
  const projects = (context.config.projects ?? []).filter(
    (project) =>
      project.surface &&
      (!projectRoot || analysis.relative(project.root) === analysis.relative(projectRoot)),
  );
  if (!projects.length) {
    throw new AnalysisError(
      "plumb.json",
      "No public API surface is configured for the requested project.",
    );
  }
  return projects.map((project) => surfaceProposal(analysis, project));
};
