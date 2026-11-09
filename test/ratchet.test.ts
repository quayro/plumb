import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRepository } from "../src/engine.ts";
import {
  changesOf,
  classes,
  cli,
  E,
  json,
  pin,
  raw,
  rawPolicy,
  repository,
  write,
} from "./ratchet-support.ts";
import { parseReport } from "./support.ts";

await test("exception budgets, scopes, ids and expiry weaken unless they shrink", () => {
  assert.deepEqual(classes({ exceptions: [E] }, { exceptions: [{ ...E, max: 3 }] }), [
    "weaken /exceptions/legacy/max",
  ]);
  assert.deepEqual(classes({ exceptions: [E] }, { exceptions: [{ ...E, max: 1 }] }), [
    "tighten /exceptions/legacy/max",
  ]);
  assert.deepEqual(classes({ exceptions: [E] }, { exceptions: [{ ...E, files: ["src/**"] }] }), [
    "tighten /exceptions/legacy/files",
    "weaken /exceptions/legacy/files",
  ]);
  assert.deepEqual(
    classes({ exceptions: [E] }, { exceptions: [{ ...E, files: ["src/a/*", "src/b/*"] }] }),
    ["weaken /exceptions/legacy/files"],
  );
  assert.deepEqual(
    classes(
      { exceptions: [E] },
      { exceptions: [{ ...E, rules: ["files.names", "files.forbidden"] }] },
    ),
    ["weaken /exceptions/legacy/rules"],
  );
  assert.deepEqual(
    raw({ exceptions: [{ ...E, rules: ["files.names", "files.forbidden"] }] }, { exceptions: [E] }),
    ["tighten /exceptions/legacy/rules"],
  );
  assert.deepEqual(classes({ exceptions: [E] }, { exceptions: [{ ...E, id: "renamed" }] }), [
    "tighten /exceptions/legacy",
    "weaken /exceptions/renamed",
  ]);
  assert.deepEqual(
    classes({ exceptions: [E] }, { exceptions: [{ ...E, id: "moved", files: ["src/a/*"] }] }),
    ["tighten /exceptions/legacy", "weaken /exceptions/moved"],
  );
  assert.deepEqual(
    classes(
      { exceptions: [E] },
      {
        exceptions: [
          { ...E, id: "split-a", max: 1 },
          { ...E, id: "split-b", max: 1 },
        ],
      },
    ),
    ["tighten /exceptions/legacy", "weaken /exceptions/split-a", "weaken /exceptions/split-b"],
  );
  assert.deepEqual(
    classes({ exceptions: [{ ...E, expires: "2030-01-01" }] }, { exceptions: [E] }),
    ["weaken /exceptions/legacy/expires"],
  );
  assert.deepEqual(
    classes({ exceptions: [E] }, { exceptions: [{ ...E, expires: "2030-01-01" }] }),
    ["tighten /exceptions/legacy/expires"],
  );
  assert.deepEqual(
    classes(
      { exceptions: [{ ...E, expires: "2030-01-01" }] },
      { exceptions: [{ ...E, expires: "2031-01-01" }] },
    ),
    ["weaken /exceptions/legacy/expires"],
  );
  assert.deepEqual(
    classes(
      { exceptions: [{ ...E, expires: "2030-01-01" }] },
      { exceptions: [{ ...E, expires: "2029-01-01" }] },
    ),
    ["tighten /exceptions/legacy/expires"],
  );
  assert.deepEqual(classes({ exceptions: [E] }, { exceptions: [] }), [
    "tighten /exceptions/legacy",
  ]);
  assert.deepEqual(
    classes({ exceptions: [E] }, { exceptions: [{ ...E, reason: "moved to the new owner" }] }),
    ["weaken /exceptions/legacy"],
  );
});

await test("excludes, format ignores, protected lists and projects classify by direction", () => {
  assert.deepEqual(
    classes(
      { exclude: [{ files: ["gen/**"], reason: "generated" }] },
      { exclude: [{ files: ["gen/**", "tmp/**"], reason: "generated" }] },
    ),
    ["weaken /exclude/0"],
  );
  assert.deepEqual(
    classes(
      { exclude: [{ files: ["gen/**", "tmp/**"], reason: "generated" }] },
      { exclude: [{ files: ["gen/**"], reason: "generated" }] },
    ),
    ["tighten /exclude/0"],
  );
  assert.ok(
    classes(
      { exclude: [{ files: ["gen/a/*"], reason: "generated" }] },
      { exclude: [{ files: ["gen/**"], reason: "generated" }] },
    ).includes("weaken /exclude/0"),
  );
  assert.deepEqual(
    classes(
      {
        exclude: [
          { files: ["gen/**"], reason: "a" },
          { files: ["tmp/**"], reason: "b" },
        ],
      },
      {
        exclude: [
          { files: ["tmp/**"], reason: "b" },
          { files: ["gen/**"], reason: "a" },
        ],
      },
    ),
    [],
  );
  assert.deepEqual(
    classes(
      { format: { ignore: [{ path: "a.md", reason: "r" }] } },
      {
        format: {
          ignore: [
            { path: "a.md", reason: "r" },
            { path: "b.md", reason: "r" },
          ],
        },
      },
    ),
    ["weaken /format/ignore/1"],
  );
  assert.deepEqual(
    classes(
      {
        format: {
          ignore: [
            { path: "a.md", reason: "r" },
            { path: "b.md", reason: "r" },
          ],
        },
      },
      { format: { ignore: [{ path: "a.md", reason: "r" }] } },
    ),
    ["tighten /format/ignore/1"],
  );
  assert.deepEqual(
    classes(
      { files: { required: ["AGENTS.md", "README.md"] } },
      { files: { required: ["AGENTS.md"] } },
    ),
    ["weaken /files/required/1"],
  );
  assert.deepEqual(
    classes(
      { files: { required: ["AGENTS.md"] } },
      { files: { required: ["AGENTS.md", "README.md"] } },
    ),
    ["tighten /files/required/1"],
  );
  assert.deepEqual(
    classes({ files: { forbidden: ["**/*.ts", "x/**"] } }, { files: { forbidden: ["**/*.ts"] } }),
    ["weaken /files/forbidden/1"],
  );
  assert.deepEqual(
    classes(
      { files: { names: [{ files: ["src/**"], pattern: "^a$", reason: "r" }] } },
      { files: {} },
    ),
    ["weaken /files/names/0"],
  );
  assert.deepEqual(
    classes({ policy: { protected: ["src/**", "x/**"] } }, { policy: { protected: ["src/**"] } }),
    ["weaken /policy/protected/1"],
  );
  assert.deepEqual(
    classes({ policy: { protected: ["src/**"] } }, { policy: { protected: ["src/**", "x/**"] } }),
    ["tighten /policy/protected/1"],
  );
  assert.deepEqual(
    classes({ projects: [{ root: "packages/a", profile: "ruby" }] }, { projects: [] }),
    ["weaken /projects/0"],
  );
  assert.deepEqual(
    classes({ projects: [] }, { projects: [{ root: "packages/a", profile: "ruby" }] }),
    ["tighten /projects/0"],
  );
  assert.ok(
    classes(
      { projects: [{ root: "packages/a", profile: "ruby" }] },
      { projects: [{ root: "packages/b", profile: "ruby" }] },
    ).includes("weaken /projects/0"),
  );
  assert.deepEqual(classes({ preset: "portable" }, { preset: "ozmikhail" }), ["tighten /preset"]);
  assert.deepEqual(classes({ preset: "ozmikhail" }, { preset: "portable" }), ["weaken /preset"]);
});

await test("removed keys, unlisted changes and limits default to weaken", () => {
  assert.deepEqual(raw({ javascript: { strict: true } }, { javascript: {} }), [
    "weaken /javascript/strict",
  ]);
  assert.deepEqual(
    raw(
      { contracts: { boundaries: [{ from: ["a/**"], deny: ["b/**"], reason: "r" }] } },
      { contracts: {} },
    ),
    ["weaken /contracts/boundaries"],
  );
  assert.deepEqual(raw({ javascript: { words: ["x"] } }, { javascript: {} }), [
    "weaken /javascript/words",
  ]);
  assert.deepEqual(raw({ docs: { index: "README.md" } }, { docs: {} }), ["weaken /docs/index"]);
  assert.deepEqual(classes({ files: { maxLines: 100 } }, { files: { maxLines: 200 } }), [
    "weaken /files/maxLines",
  ]);
  assert.deepEqual(classes({ files: { maxLines: 100 } }, { files: { maxLines: 50 } }), [
    "tighten /files/maxLines",
  ]);
  assert.deepEqual(
    raw(
      { commits: { types: ["feat"], scopes: ["ui"], maxLength: 72 } },
      { commits: { types: ["feat", "fix"], scopes: ["ui", "api"], maxLength: 100 } },
    ),
    ["weaken /commits/maxLength", "weaken /commits/scopes/1", "weaken /commits/types/1"],
  );
  assert.deepEqual(raw({ commits: { types: ["feat", "fix"] } }, { commits: { types: ["feat"] } }), [
    "tighten /commits/types/1",
  ]);
});

await test("tools, generated content and reordering are neutral or unchanged", () => {
  assert.deepEqual(
    classes(
      { tools: { timeout: 1000, versions: { node: "22.18.0" } } },
      { tools: { timeout: 2000, versions: { node: "22.19.0" } } },
    ),
    ["neutral /tools/timeout", "neutral /tools/versions"],
  );
  assert.deepEqual(
    classes(
      { generated: [{ path: "x.txt", content: "a" }] },
      { generated: [{ path: "x.txt", content: "b" }] },
    ),
    ["neutral /generated"],
  );
});

await test("--base reports weakening in the failure and classifies tightening without it", async () => {
  const root = repository({ "plumb.json": json(rawPolicy({ exceptions: [{ ...E, max: 2 }] })) });
  write(root, { "plumb.json": json(rawPolicy({ exceptions: [{ ...E, max: 3 }] })) });
  const weak = parseReport((await cli(["check", "--root", root, "--base", "HEAD"])).text);
  const weakened = weak.diagnostics.filter((item) => item.rule === "policy.weakened");
  assert.equal(weakened.length, 1);
  assert.equal(weakened[0].path, "plumb.json");
  assert.equal(weakened[0].suppressible, false);
  assert.match(weakened[0].message, /^\/exceptions\/legacy\/max changed from 2 to 3/);
  assert.deepEqual(changesOf(weak.policyChanges), ["weaken /exceptions/legacy/max"]);
  write(root, {
    "plumb.json": json(rawPolicy({ exceptions: [{ ...E, max: 1 }], tools: { timeout: 5000 } })),
  });
  const tight = parseReport((await cli(["check", "--root", root, "--base", "HEAD"])).text);
  assert.equal(
    tight.diagnostics.some((item) => item.rule === "policy.weakened"),
    false,
  );
  assert.deepEqual(changesOf(tight.policyChanges).sort(), [
    "neutral /tools/timeout",
    "tighten /exceptions/legacy/max",
  ]);
});

await test("the base policy follows its pinned bundles through git", async () => {
  const base = json(rawPolicy({ exceptions: [{ ...E, max: 2 }] })),
    weak = json(rawPolicy({ exceptions: [{ ...E, max: 3 }] }));
  const root = repository({
    "policy/base.json": base,
    "policy/weak.json": weak,
    "plumb.json": json({
      schemaVersion: 1,
      bundles: [{ path: "policy/base.json", sha256: pin(base) }],
    }),
  });
  write(root, {
    "plumb.json": json({
      schemaVersion: 1,
      bundles: [{ path: "policy/weak.json", sha256: pin(weak) }],
    }),
  });
  const result = await checkRepository({ root, base: "HEAD" });
  assert.deepEqual(changesOf(result.policyChanges), ["weaken /exceptions/legacy/max"]);
  assert.equal(
    result.diagnostics.some((item) => item.rule === "policy.base"),
    false,
  );
});
