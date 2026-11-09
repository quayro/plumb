import { issue, type PlannedCheck, same } from "./adapter-plan.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { at, isArray, isRecord } from "./schema.ts";

interface NotApplicable {
  path: string;
  reason: string;
}

export interface Coverage extends PlannedCheck {
  checkedFiles: string[];
  notApplicable?: NotApplicable[];
  status: string;
  completed: boolean;
}

// parses an untrusted coverage row; anything malformed is undefined and fails its check
const coverageRow = (
  row: unknown,
): { id: string; status: string; checkedFiles: unknown; notApplicable: unknown } | undefined => {
  const id = at(row, "id");
  return isRecord(row) && typeof id === "string"
    ? {
        id,
        status: String(row.status),
        checkedFiles: row.checkedFiles,
        notApplicable: row.notApplicable ?? [],
      }
    : undefined;
};

const strings = (value: unknown): value is string[] =>
  isArray(value) && value.every((item) => typeof item === "string");

const reasons = (value: unknown): value is NotApplicable[] =>
  isArray(value) &&
  value.every((entry) => {
    const reason = at(entry, "reason");
    return typeof reason === "string" && !!reason.trim() && typeof at(entry, "path") === "string";
  });

export function validateCoverage(
  planned: readonly PlannedCheck[],
  returned: unknown = [],
): { diagnostics: Diagnostic[]; coverage: Coverage[] } {
  const diagnostics: Diagnostic[] = [],
    coverage: Coverage[] = [],
    ids = new Set(planned.map((entry) => entry.id)),
    seen = new Set<string>(),
    rows = (isArray(returned) ? returned : []).map(coverageRow);
  for (const row of rows) {
    if (!row || !ids.has(row.id) || seen.has(row.id)) {
      diagnostics.push(
        issue(
          "adapters.protocol",
          ".",
          `Unexpected or duplicate coverage record ${row?.id ?? "(missing id)"}.`,
        ),
      );
    } else {
      seen.add(row.id);
    }
  }
  for (const check of planned) {
    const row = rows.find((entry) => entry?.id === check.id),
      files = row?.checkedFiles,
      excluded = row?.notApplicable;
    const shaped = !!row && strings(files) && reasons(excluded);
    let valid =
      shaped &&
      new Set(files).size === files.length &&
      files.every((file) => check.files.includes(file)) &&
      excluded.every((entry) => check.allowNotApplicable && check.files.includes(entry.path)) &&
      new Set([...files, ...excluded.map((entry) => entry.path)]).size ===
        files.length + excluded.length &&
      same([...files, ...excluded.map((entry) => entry.path)], check.files);
    valid &&=
      shaped &&
      ["pass", "violation", "incomplete", "not-applicable"].includes(row.status) &&
      (row.status !== "not-applicable" ||
        (!files.length &&
          !check.scope &&
          (check.files.length === 0 || excluded.length === check.files.length)));
    valid &&=
      shaped &&
      (!["pass", "violation"].includes(row.status) || !check.files.length || files.length > 0);
    if (!valid || !shaped) {
      diagnostics.push(
        issue(
          "adapters.coverage",
          check.root,
          `Check ${check.id} did not account for its complete planned scope.`,
          check.id,
        ),
      );
      coverage.push({ ...check, checkedFiles: [], status: "incomplete", completed: false });
      continue;
    }
    coverage.push({
      ...check,
      checkedFiles: files,
      ...(excluded.length ? { notApplicable: excluded } : {}),
      status: row.status,
      completed: ["pass", "violation"].includes(row.status),
    });
  }
  return { diagnostics, coverage };
}
