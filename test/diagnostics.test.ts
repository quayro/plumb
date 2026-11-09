import assert from "node:assert/strict";
import test from "node:test";

import { attachOrigins, enrichDiagnostics, toSarif } from "../src/diagnostics.ts";
import { at, isArray } from "../src/schema.ts";

await test("diagnostic fingerprints survive line shifts and distinguish repeated findings", () => {
  const finding = {
    rule: "files.names",
    path: "src/Bad.js",
    line: 1,
    message: "Use the approved name",
    remedy: "Rename it",
  };
  const first = enrichDiagnostics([finding, { ...finding, line: 4 }]);
  const shifted = enrichDiagnostics([
    { ...finding, line: 20 },
    { ...finding, line: 23 },
  ]);
  assert.equal(first[0].fingerprint, shifted[0].fingerprint);
  assert.equal(first[1].fingerprint, shifted[1].fingerprint);
  assert.notEqual(first[0].fingerprint, first[1].fingerprint);
  assert.equal(first[0]?.actions?.[0]?.kind, "edit-source");
});

await test("repair/prerequisite actions and policy origins are explicit data", () => {
  const rows = enrichDiagnostics([
    { rule: "tools.missing", path: ".", status: "incomplete", message: "Missing compiler" },
    { rule: "javascript/format", path: "src/a.js", message: "Format" },
    { rule: "exceptions.stale", path: "plumb.json", message: "Review policy" },
  ]);
  assert.deepEqual(
    rows.map((row) => row.actions?.[0]?.kind),
    ["resolve-prerequisite", "preview-repair", "review-policy"],
  );
  const origin = { path: "/trusted/backend.json", pointer: "/javascript", sha256: "pinned" };
  assert.deepEqual(attachOrigins([rows[1]], { "/javascript": [origin] })[0].policyOrigins, [
    origin,
  ]);
});

await test("SARIF preserves findings, locations and accepted debt while incomplete runs remain unsuccessful", () => {
  const [finding, missing] = enrichDiagnostics([
    {
      rule: "files.names",
      path: "a b/file.js",
      line: 2,
      column: 3,
      message: "Name",
      relatedLocations: [{ path: "plumb.json", line: 1, message: "Rule" }],
    },
    { rule: "tools.missing", path: ".", status: "incomplete", message: "Compiler unavailable" },
  ]);
  const sarif = toSarif({
    status: "incomplete",
    diagnostics: [finding, missing],
    suppressed: [{ ...finding, path: "legacy.js", exception: "legacy" }],
  });
  assert.equal(sarif.version, "2.1.0");
  const run = at(sarif, "runs", 0);
  assert.equal(at(run, "invocations", 0, "executionSuccessful"), false);
  const results = at(run, "results");
  assert.ok(isArray(results));
  assert.equal(results.length, 2);
  assert.equal(
    at(results, 0, "locations", 0, "physicalLocation", "artifactLocation", "uri"),
    "a%20b/file.js",
  );
  assert.equal(at(results, 0, "relatedLocations", 0, "physicalLocation", "region", "startLine"), 1);
  assert.equal(at(results, 1, "suppressions", 0, "status"), "accepted");
});
