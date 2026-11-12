import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { PlannedCheck } from "../src/adapter-plan.ts";
import { loadAdapterRegistry, registryIdentity } from "../src/adapter-registry.ts";
import { planAdapters, projectFiles, runAdapters, validateCoverage } from "../src/adapters.ts";
import { definePlumb } from "../src/config.ts";
import { digest } from "../src/files.ts";
import { at } from "../src/schema.ts";
import { fixture, nodeExecutable, nodeHash } from "./adapters-support.ts";

await test("coverage plans preserve nested ownership and reasoned exclusions", (t) => {
  const { ctx } = fixture(
    t,
    { "root.ts": "", "a/main.tsx": "", "vendor/skip.ts": "", "README.md": "" },
    {
      projects: [
        { root: ".", profile: "typescript" },
        { root: "a", profile: "react" },
      ],
      exclude: [{ files: ["vendor/**"], reason: "checked upstream" }],
    },
  );
  const plan = planAdapters(ctx);
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(projectFiles(ctx, ctx.config.projects[0]), ["root.ts"]);
  assert.deepEqual(plan.checks.find((check) => check.id === "javascript.lint:a")?.files, [
    "a/main.tsx",
  ]);
  assert.deepEqual(plan.files.find((file) => file.path === "a/main.tsx")?.owners, [
    { root: "a", profile: "react" },
  ]);
  assert.deepEqual(plan.files.find((file) => file.path === "vendor/skip.ts")?.reasons, [
    "checked upstream",
  ]);
  assert.equal(plan.files.find((file) => file.path === "vendor/skip.ts")?.excluded, true);
});

await test("unapproved profiles and unowned registered source cannot silently disappear", (t) => {
  const { ctx, registry } = fixture(t);
  assert.ok(planAdapters(ctx).diagnostics.some((item) => item.rule === "adapters.registry"));
  const approved = registry();
  const unowned = {
    ...ctx,
    config: definePlumb({ schemaVersion: 1, preset: "ozmikhail", projects: [] }),
  };
  assert.ok(
    planAdapters(unowned, { registry: approved }).diagnostics.some(
      (item) => item.rule === "projects.uncovered" && item.path === "main.lua",
    ),
  );
});

await test("registry checks code boundaries, hashes, executable pins and option schemas", (t) => {
  const { root, registry, registryFile, script } = fixture(t);
  const approved = registry();
  assert.equal(approved?.adapters[0]?.id, "lua");
  writeFileSync(join(root, "registry.json"), readFileSync(registryFile));
  assert.throws(
    () => loadAdapterRegistry(join(root, "registry.json"), root),
    /outside the candidate/,
  );
  assert.throws(
    () => registry("", { integrity: [{ path: nodeExecutable, sha256: nodeHash }] }),
    /must be pinned/,
  );
  assert.throws(
    () =>
      registry("", {
        integrity: [
          { path: nodeExecutable, sha256: "0".repeat(64) },
          { path: script, sha256: "0".repeat(64) },
        ],
      }),
    /integrity mismatch/,
  );
  assert.throws(
    () =>
      registry("", {
        optionsSchema: { type: "object", properties: {}, additionalProperties: true },
      }),
    /constrain additionalProperties/,
  );
  writeFileSync(join(root, "adapter.mjs"), "throw new Error('candidate code');\n");
  assert.throws(
    () => registry("", { command: [nodeExecutable, "adapter.mjs"] }),
    /relative command file/,
  );
  assert.throws(
    () => registry("", { command: [nodeExecutable, "--import=adapter.mjs", script] }),
    /absolute pinned files/,
  );
  assert.throws(
    () => registry("", { command: [nodeExecutable, "-m", "candidate"] }),
    /module-name resolution/,
  );
  const strict = registry("", {
    optionsSchema: {
      type: "object",
      properties: { level: { enum: ["strict"] } },
      required: ["level"],
      additionalProperties: false,
    },
  });
  assert.ok(
    planAdapters({ ...fixture(t).ctx }, { registry: strict }).diagnostics.some((item) =>
      /missing level/.test(item.message),
    ),
  );
});

await test("an actual external process returns file coverage, source hashes and precise findings", async (t) => {
  const { ctx, registry } = fixture(t, {
    "main.lua": "print('ok')\n",
    "nested/bad.lua": "ERROR\n",
  });
  const approved = registry(),
    planned = planAdapters(ctx, { registry: approved });
  const result = await runAdapters(ctx, planned, { registry: approved });
  assert.deepEqual(
    result.diagnostics.map(({ rule, path }) => [rule, path]),
    [["lua/syntax", "nested/bad.lua"]],
  );
  assert.equal(result.coverage[0].completed, true);
  assert.equal(result.coverage[0].status, "violation");
  assert.equal(result.coverage[0].evidence, "adapter-reported");
  assert.deepEqual(result.coverage[0].checkedFiles, ["main.lua", "nested/bad.lua"]);
  assert.equal(result.versions.node, process.versions.node);
});

await test("external input evidence hashes original bytes through both context read APIs", async (t) => {
  const bytes = Buffer.from("# coding: latin-1\nname = 'caf\xe9'\n", "latin1");
  assert.notEqual(digest(bytes), digest(bytes.toString("utf8")));
  for (const rawReader of [false, true]) {
    const { ctx, registry } = fixture(t, { "main.lua": bytes });
    let reads = 0;
    if (rawReader) {
      ctx.readBytes = (path) => {
        reads++;
        return readFileSync(ctx.safePath(path));
      };
      ctx.read = () => {
        throw new Error("Raw-byte evidence must not decode the input");
      };
    }
    const approved = registry();
    const result = await runAdapters(ctx, planAdapters(ctx, { registry: approved }), {
      registry: approved,
    });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.coverage[0].status, "pass");
    if (rawReader) {
      assert.ok(reads >= 2);
    }
  }
});

await test("successful external checks receive only declared environment inputs", async (t) => {
  const { ctx, registry } = fixture(t);
  const previous = process.env.PLUMB_ADAPTER_UNDECLARED;
  process.env.PLUMB_ADAPTER_UNDECLARED = "must not reach adapter";
  try {
    const approved = registry();
    const result = await runAdapters(ctx, planAdapters(ctx, { registry: approved }), {
      registry: approved,
    });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.coverage[0].status, "pass");
    assert.deepEqual(at(registryIdentity(approved), "adapters", 0, "environment", "names"), []);
  } finally {
    if (previous === undefined) {
      delete process.env.PLUMB_ADAPTER_UNDECLARED;
    } else {
      process.env.PLUMB_ADAPTER_UNDECLARED = previous;
    }
  }
});

await test("empty, unexpected and duplicate coverage cannot claim successful completion", () => {
  const planned: PlannedCheck[] = [
    {
      id: "syntax:.",
      adapter: "lua",
      capability: "syntax",
      root: ".",
      files: ["a.lua"],
      evidence: "adapter-reported",
    },
  ];
  for (const returned of [
    [],
    [{ id: "syntax:.", checkedFiles: [], status: "pass" }],
    [{ id: "syntax:.", checkedFiles: ["other.lua"], status: "pass" }],
    [{ id: "syntax:.", checkedFiles: ["a.lua", "a.lua"], status: "pass" }],
    [
      {
        id: "syntax:.",
        checkedFiles: [],
        notApplicable: [{ path: "a.lua", reason: "ignored" }],
        status: "not-applicable",
      },
    ],
  ]) {
    assert.ok(validateCoverage(planned, returned).diagnostics.length);
  }
  const [first] = planned;
  assert.ok(first);
  const format: PlannedCheck[] = [{ ...first, allowNotApplicable: true }];
  assert.equal(
    validateCoverage(format, [
      {
        id: "syntax:.",
        checkedFiles: [],
        notApplicable: [{ path: "a.lua", reason: "No supported parser" }],
        status: "not-applicable",
      },
    ]).coverage[0].status,
    "not-applicable",
  );
  assert.ok(
    validateCoverage(format, [
      {
        id: "syntax:.",
        checkedFiles: [],
        notApplicable: [{ path: "a.lua", reason: "No supported parser" }],
        status: "pass",
      },
    ]).diagnostics.length,
  );
});

await test("external protocol rejects missing hashes, out-of-scope claims and contradictory statuses", async (t) => {
  const edits = [
    "response.inputs = [];",
    "response.inputs[0].sha256 = '0'.repeat(64);",
    "response.coverage[0].files = [];",
    "response.coverage.push(response.coverage[0]);",
    "response.diagnostics = [{rule:'lua/unknown',path:'main.lua',message:'unknown'}]; response.status='violation';",
    "response.diagnostics = [{rule:'lua/syntax',path:'../outside.lua',message:'outside'}]; response.status='violation';",
    "response.versions.node = '0.0.0';",
  ];
  for (const edit of edits) {
    const { ctx, registry } = fixture(t);
    const approved = registry(edit);
    const result = await runAdapters(ctx, planAdapters(ctx, { registry: approved }), {
      registry: approved,
    });
    assert.ok(
      result.diagnostics.some((item) => item.status === "incomplete"),
      edit,
    );
  }
});

await test("changed adapter code is refused before it can execute", async (t) => {
  const { ctx, registry, script } = fixture(t),
    approved = registry();
  writeFileSync(script, "throw new Error('tampered');\n");
  let calls = 0;
  const result = await runAdapters(ctx, planAdapters(ctx, { registry: approved }), {
    registry: approved,
    execute: async () => {
      calls++;
      return { code: 0, stdout: "{}", stderr: "" };
    },
  });
  assert.equal(calls, 0);
  assert.ok(result.diagnostics.some((item) => /integrity mismatch/.test(item.message)));
});
