import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { publishedProtocol, publishedSchema } from "../scripts/schema.ts";
import { at } from "../src/schema.ts";
import { parseJson } from "./support.ts";

await test("the published schema is regenerated from the policy schema", async () => {
  assert.equal(
    readFileSync(new URL("../plumb.schema.json", import.meta.url), "utf8"),
    await publishedSchema(),
    "Run node scripts/schema.ts and commit plumb.schema.json.",
  );
});

await test("the adapter protocol is published as a versioned schema and regenerated from the code", async () => {
  const published = readFileSync(
    new URL("../adapter-protocol.schema.json", import.meta.url),
    "utf8",
  );
  assert.equal(
    published,
    await publishedProtocol(),
    "Run node scripts/schema.ts and commit adapter-protocol.schema.json.",
  );
  const protocol = parseJson(published);
  assert.equal(at(protocol, "$id"), "urn:plumb:adapter-protocol:v1");
  // version 1 promises these fields; removing one is a new protocol version, not an edit
  assert.deepEqual(at(protocol, "$defs", "request", "required"), [
    "schemaVersion",
    "action",
    "adapter",
    "version",
    "root",
    "project",
    "files",
    "inputs",
    "capabilities",
  ]);
  assert.deepEqual(at(protocol, "$defs", "response", "required"), [
    "schemaVersion",
    "adapter",
    "version",
    "status",
    "diagnostics",
    "coverage",
    "inputs",
  ]);
  assert.deepEqual(at(protocol, "$defs", "response", "properties", "status", "enum"), [
    "pass",
    "violation",
    "incomplete",
  ]);
});
