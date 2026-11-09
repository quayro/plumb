import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { publishedSchema } from "../scripts/schema.ts";

await test("the published schema is regenerated from the policy schema", async () => {
  assert.equal(
    readFileSync(new URL("../plumb.schema.json", import.meta.url), "utf8"),
    await publishedSchema(),
    "Run node scripts/schema.ts and commit plumb.schema.json.",
  );
});
