import ts from "typescript";

import { planConventions, validateConventions } from "../../../src/conventions.ts";
import type { Diagnostic } from "../../../src/diagnostics.ts";
import { errorMessage } from "../../../src/errors.ts";
import { strictCompilerOptions } from "../eslint/typed-policy.ts";
import { Analysis, AnalysisError } from "./analysis.ts";
import { exportsOf, imports, nodes } from "./convention-shapes.ts";
import {
  type ExportView,
  exportView,
  observeProgram,
  type Role,
  type TypeAssertion,
  typeDeclaration,
  unalias,
} from "./convention-view.ts";
import type { ConventionsContext } from "./metrics.ts";
import { isScript } from "./source-syntax.ts";

export const RULES = (
  [
    [
      "conventions.analysis",
      "Declared JavaScript role contracts have complete, supported semantic inputs.",
      false,
    ],
    [
      "conventions.imports",
      "Literal and resolved dependencies obey their role's allowed and denied scopes.",
      true,
    ],
    [
      "conventions.exports",
      "A role's resolved ECMAScript exports obey required and allowed names.",
      true,
    ],
    ["conventions.nodes", "Selected declarations satisfy positive role shape counts.", true],
    [
      "conventions.types",
      "A concrete exported value is assignable to its declared contract type.",
      true,
    ],
  ] as const
).map(([id, description, suppressible]) => ({
  id,
  description,
  suppressible,
  remedy:
    "Correct the source to satisfy its role contract; missing semantic evidence cannot be excepted.",
}));

const incomplete = (error: unknown, file: string, label: string): Diagnostic => ({
  rule: "conventions.analysis",
  path: error instanceof AnalysisError ? error.path : file,
  message: `${label}: ${errorMessage(error)}`,
  remedy:
    error instanceof AnalysisError
      ? error.remedy
      : "Restore the selected compiler/source inputs and use supported declaration contracts.",
  status: "incomplete",
  suppressible: false,
});

const isReference = (type: ts.Type): type is ts.TypeReference =>
  "objectFlags" in type &&
  typeof type.objectFlags === "number" &&
  !!(type.objectFlags & ts.ObjectFlags.Reference);

// assignability involving any, unknown, never or uninstantiated generic shapes is not proof.
function concrete(
  checker: ts.TypeChecker,
  program: ts.Program,
  type: ts.Type | undefined,
  place: ts.Node | undefined,
  file: string,
  seen = new Set<ts.Type>(),
): void {
  if (
    !type ||
    type.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Never |
        ts.TypeFlags.TypeParameter |
        ts.TypeFlags.Conditional |
        ts.TypeFlags.IndexedAccess |
        ts.TypeFlags.Index |
        ts.TypeFlags.Substitution)
  ) {
    throw new AnalysisError(
      file,
      "The assignability contract contains an unsafe or unevaluated type (any, unknown, never or an uninstantiated generic).",
    );
  }
  if (seen.has(type)) {
    return;
  }
  if (seen.size >= 2048) {
    throw new AnalysisError(
      file,
      "The assignability contract exceeds the bounded type-graph inspection limit.",
    );
  }
  seen.add(type);
  if (type.isUnionOrIntersection()) {
    for (const part of type.types) {
      concrete(checker, program, part, place, file, seen);
    }
    return;
  }
  if (!(type.flags & ts.TypeFlags.Object)) {
    return;
  }
  const args = [
    ...(type.aliasTypeArguments ?? []),
    ...(isReference(type) ? checker.getTypeArguments(type) : []),
  ];
  for (const argument of args) {
    concrete(checker, program, argument, place, file, seen);
  }
  const declarations = type.getSymbol()?.declarations ?? [];
  if (
    declarations.length &&
    declarations.every((node) => program.isSourceFileDefaultLibrary(node.getSourceFile()))
  ) {
    return;
  }
  for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
    if (signature.typeParameters?.length) {
      throw new AnalysisError(
        file,
        "Generic call signatures must be instantiated before they can prove a role type contract.",
      );
    }
    for (const parameter of signature.getParameters()) {
      concrete(checker, program, typeAt(checker, parameter, place), place, file, seen);
    }
    concrete(checker, program, checker.getReturnTypeOfSignature(signature), place, file, seen);
  }
  for (const property of checker.getPropertiesOfType(type)) {
    concrete(checker, program, typeAt(checker, property, place), place, file, seen);
  }
  for (const index of checker.getIndexInfosOfType(type)) {
    concrete(checker, program, index.type, place, file, seen);
  }
}

// a symbol's type where it is declared; an undeclared symbol has no type to prove
function typeAt(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  place: ts.Node | undefined,
): ts.Type | undefined {
  const at = typeDeclaration(symbol) ?? place;
  return at && checker.getTypeOfSymbolAtLocation(symbol, at);
}

function assignable(
  analysis: Analysis,
  file: string,
  role: Role,
  assertion: TypeAssertion,
): Diagnostic[] {
  const config = analysis.compilerConfig(assertion.tsconfig);
  for (const [key, expected] of Object.entries(strictCompilerOptions)) {
    if (config.options[key] !== undefined && config.options[key] !== expected) {
      throw new AnalysisError(
        assertion.tsconfig,
        `${key} conflicts with the strict role type contract.`,
      );
    }
  }
  if (!config.fileNames.length) {
    throw new AnalysisError(assertion.tsconfig, "The contract tsconfig selects no source files.");
  }
  const options = {
    ...config.options,
    ...strictCompilerOptions,
    noEmit: true,
    incremental: false,
    composite: false,
  };
  const program = analysis.program(file, [], options, config.fileNames, config.projectReferences);
  observeProgram(analysis, program);
  analysis.source(assertion.contract.file);
  if (
    !program.getSourceFile(analysis.absolute(file)) ||
    !program.getSourceFile(analysis.absolute(assertion.contract.file))
  ) {
    throw new AnalysisError(
      file,
      "The declared tsconfig must include both the checked source and its contract symbol's file.",
    );
  }
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((item) => item.category === ts.DiagnosticCategory.Error);
  const [first] = errors;
  if (first) {
    throw new AnalysisError(
      first.file ? analysis.relative(first.file.fileName) : assertion.tsconfig,
      `The contract Program has compiler errors: TS${first.code}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
    );
  }
  const source = exportView(analysis, file, program),
    contract = exportView(analysis, assertion.contract.file, program);
  const exported = source.symbols.find((symbol) => symbol.name === assertion.export);
  if (!exported) {
    return [
      analysis.issue(
        "conventions.types",
        file,
        `Role ${role.id}, assertion ${assertion.id}: required value export ${assertion.export} is missing.`,
        "Export the concrete value required by this role.",
      ),
    ];
  }
  const actual = unalias(source.checker, exported),
    expected = unalias(
      source.checker,
      contract.symbols.find((symbol) => symbol.name === assertion.contract.symbol),
    );
  if (!expected || !(expected.flags & ts.SymbolFlags.Type)) {
    throw new AnalysisError(
      assertion.contract.file,
      `Contract symbol ${assertion.contract.symbol} must be an exported declared type.`,
    );
  }
  if (!actual || !(actual.flags & ts.SymbolFlags.Value)) {
    return [
      analysis.issue(
        "conventions.types",
        file,
        `${assertion.export} is a type-only export; role ${role.id} requires a value.`,
        "Export a value implementing the declared type contract.",
      ),
    ];
  }
  const place = typeDeclaration(actual),
    sourceType = typeAt(source.checker, actual, place),
    targetType = source.checker.getDeclaredTypeOfSymbol(expected);
  concrete(source.checker, program, sourceType, place, file);
  concrete(source.checker, program, targetType, typeDeclaration(expected), assertion.contract.file);
  return sourceType && source.checker.isTypeAssignableTo(sourceType, targetType)
    ? []
    : [
        analysis.issue(
          "conventions.types",
          file,
          `Role ${role.id}, assertion ${assertion.id}: export ${assertion.export} is not assignable to ${assertion.contract.symbol} from ${assertion.contract.file}.`,
          "Implement the declared contract in source; a type assertion does not establish runtime behavior.",
          place,
        ),
      ];
}

export function checkConventions(
  context: ConventionsContext,
  shared?: Analysis,
  suppliedPlan?: ReturnType<typeof planConventions>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!context.config.conventions) {
    return diagnostics;
  }
  let analysis: Analysis, plan: ReturnType<typeof planConventions>;
  try {
    validateConventions(context.config.conventions);
    analysis = shared ?? new Analysis(context);
    plan = suppliedPlan ?? planConventions(context);
  } catch (error) {
    return [incomplete(error, "plumb.json", "conventions")];
  }
  const run = (file: string, label: string, inspect: () => Diagnostic[]): void => {
    try {
      diagnostics.push(...inspect());
    } catch (error) {
      diagnostics.push(incomplete(error, file, label));
    }
  };
  for (const role of context.config.conventions.roles) {
    if (!role.imports && !role.exports && !role.javascript) {
      continue;
    }
    const files = plan.roles.find((entry) => entry.id === role.id)?.files ?? [];
    if (!files.length) {
      diagnostics.push(
        incomplete(
          new Error("Role has no unambiguously owned selected source files."),
          "plumb.json",
          role.id,
        ),
      );
      continue;
    }
    for (const file of files) {
      if (!isScript(file)) {
        diagnostics.push(
          incomplete(
            new Error(
              "Import, export and JavaScript shape conventions require the JavaScript adapter and a JS/TS source file.",
            ),
            file,
            role.id,
          ),
        );
        continue;
      }
      let source: ts.SourceFile;
      try {
        source = analysis.source(file);
      } catch (error) {
        diagnostics.push(incomplete(error, file, role.id));
        continue;
      }
      const { imports: allowed, exports: exported } = role;
      if (allowed) {
        run(file, role.id, () => imports(analysis, file, { ...role, imports: allowed }, source));
      }
      let view: ExportView | undefined;
      const getView = (): ExportView => (view ??= exportView(analysis, file));
      if (exported) {
        run(file, role.id, () =>
          exportsOf(analysis, file, { ...role, exports: exported }, getView()),
        );
      }
      for (const assertion of role.javascript?.nodes ?? []) {
        run(file, `${role.id}/${assertion.id}`, () => {
          const selected = assertion.select.exported === undefined ? undefined : getView();
          return nodes(analysis, file, role, assertion, selected?.source ?? source, selected);
        });
      }
      for (const assertion of role.javascript?.assignable ?? []) {
        run(file, `${role.id}/${assertion.id}`, () => assignable(analysis, file, role, assertion));
      }
    }
  }
  return diagnostics.sort(
    (left, right) =>
      (left.path ?? "").localeCompare(right.path ?? "") ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.rule.localeCompare(right.rule) ||
      left.message.localeCompare(right.message),
  );
}
