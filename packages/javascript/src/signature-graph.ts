import type ts from "typescript";

import { type Analysis, AnalysisError } from "./analysis.ts";
import { type Collector, type SignatureGraph, sorted } from "./signature-nodes.ts";
import { printSignatures } from "./signature-print.ts";
import type { ExportTarget } from "./signature-snapshot.ts";
import { reference, selectAmbient, sourceRecord } from "./signature-sources.ts";
import { request, select, visitSymbol } from "./signature-symbols.ts";

export function signatureGraph(
  analysis: Analysis,
  program: ts.Program,
  host: ts.CompilerHost,
  targetFiles: readonly ExportTarget[],
  nameOf: (file: string) => string,
  libraries: Set<string>,
  originalProgram: ts.Program,
): SignatureGraph {
  const c: Collector = {
    analysis,
    program,
    checker: program.getTypeChecker(),
    host,
    nameOf,
    libraries,
    originalProgram,
    included: new Set(),
    containers: new Set(),
    scanned: new Set(),
    ambient: new Set(),
    symbols: new Map(),
    requests: new Map(),
    records: new Map(),
    labels: new Map(),
    rewrites: new Map(),
    sourceRecord: (source) => sourceRecord(c, source),
    selectAmbient: (node) => {
      selectAmbient(c, node);
    },
    reference: (node) => reference(c, node),
    request: (module, name, full) => {
      request(c, module, name, full);
    },
    visitSymbol: (symbol, full) => {
      visitSymbol(c, symbol, full);
    },
    select: (declaration, full) => {
      select(c, declaration, full);
    },
  };
  const targets = new Map<string, { module: string; priority: number[] }>();
  for (const target of targetFiles) {
    const source = c.program.getSourceFile(c.analysis.absolute(target.file)),
      module = source && c.checker.getSymbolAtLocation(source),
      entry = source && c.sourceRecord(source);
    if (!module || !entry) {
      throw new AnalysisError(
        target.file,
        "The emitted package entry is not an analyzable declaration module.",
      );
    }
    targets.set(target.key, {
      module: entry.name,
      priority: target.priority,
    });
    for (const symbol of c.checker.getExportsOfModule(module)) {
      c.request(module, symbol.name, true);
    }
  }
  return {
    targets: sorted(targets),
    signatures: printSignatures(c.records.values(), c.included, c.containers, c.rewrites),
  };
}
