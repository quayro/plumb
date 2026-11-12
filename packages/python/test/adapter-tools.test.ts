import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadAdapterRegistry } from "../../../src/adapter-registry.ts";
import { planAdapters, runAdapters } from "../../../src/adapters.ts";
import { at } from "../../../src/schema.ts";
import { parseJson, setAt } from "../../../test/support.ts";
import { fixture, manifest, python, script } from "./adapter-support.ts";

await test("malformed, unknown and contradictory protocol inputs are rejected", (t) => {
  const { direct, request } = fixture(t);
  const patches = [
    { schemaVersion: 2 },
    { schemaVersion: true },
    { adapter: "other" },
    { version: "2.0.0" },
    { action: "fix" },
    { unknown: true },
    { capabilities: ["syntax"] },
    { capabilities: ["syntax", "syntax", "policy"] },
    { capabilities: [null, "policy"] },
    { files: [] },
    { inputs: [] },
    { files: [{ path: "main.py", sha256: "bad" }] },
    { project: { root: ".", profile: "python", options: { skipSyntax: true } } },
    ...[[], [[]], ["python build.py"], [[false]], [[""]]].map((prepare) => ({
      project: { root: ".", profile: "python", prepare },
    })),
    {
      project: {
        root: ".",
        profile: "python",
        options: { forbiddenImports: [{ module: "os", reason: "" }] },
      },
    },
    {
      project: {
        root: ".",
        profile: "python",
        options: {
          forbiddenImports: [
            { module: "os", reason: "one" },
            { module: "os", reason: "two" },
          ],
        },
      },
    },
  ];
  for (const patch of patches) {
    const result = direct({ ...request(), ...patch });
    assert.equal(result.status, "incomplete", JSON.stringify(patch));
    assert.equal(result.diagnostics[0].rule, "python/protocol");
    assert.deepEqual(result.coverage, []);
  }
  for (const raw of [
    "{",
    "null",
    '{"schemaVersion":1,"schemaVersion":1}',
    '{"value":NaN}',
    JSON.stringify(request()) + "\n{}",
  ]) {
    assert.equal(direct(raw).status, "incomplete");
  }
});

await test("direct protocol guards source traversal, symlinks, unsupported files and project scope", (t) => {
  const { root, tools, direct, request } = fixture(t, { "src/main.py": "pass\n" }, {}, "src");
  const original = request();
  for (const path of [
    "../outside.py",
    "/outside.py",
    "src/../main.py",
    "src//main.py",
    "src\\main.py",
    "other.py",
    "src/.git/main.py",
    "src/main.js",
  ]) {
    const input = [{ path, sha256: "0".repeat(64) }];
    assert.equal(direct({ ...original, files: input, inputs: input }).status, "incomplete", path);
  }
  const outside = join(tools, "outside.py");
  writeFileSync(outside, "secret = 1\n");
  rmSync(join(root, "src/main.py"));
  symlinkSync(outside, join(root, "src/main.py"));
  const linked = direct(original);
  assert.equal(linked.status, "incomplete");
  assert.match(linked.diagnostics[0].message, /Symbolic links/);
  assert.equal(linked.inputs[0].sha256, null);
});

await test("code-pin drift and declared runtime mismatch cannot produce green checks", async (t) => {
  const { root, registryFile, registry, ctx } = fixture(t);
  const changed = structuredClone(manifest);
  setAt(changed, ["adapters", 0, "integrity", 1, "sha256"], "0".repeat(64));
  writeFileSync(registryFile, JSON.stringify(changed));
  assert.throws(() => loadAdapterRegistry(registryFile, root), /integrity mismatch/);
  const version = structuredClone(manifest);
  setAt(version, ["adapters", 0, "tools", "python"], "0.0.0");
  writeFileSync(registryFile, JSON.stringify(version));
  const wrongVersion = loadAdapterRegistry(registryFile, root);
  const result = await runAdapters(ctx, planAdapters(ctx, { registry: wrongVersion }), {
    registry: wrongVersion,
  });
  assert.ok(
    result.diagnostics.some(
      (item) => item.rule === "adapters.protocol" && /requires 0.0.0/.test(item.message),
    ),
  );
  assert.ok(result.coverage.every((row) => row.status === "incomplete"));
  assert.notEqual(registry?.sha256, wrongVersion?.sha256);
});

await test("the adapter refuses a launch without isolated and no-site interpreter flags", (t) => {
  const { root, request } = fixture(t);
  const result = spawnSync(python, ["-I", script], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(request()),
    timeout: 30000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  const output = parseJson(result.stdout);
  assert.equal(at(output, "status"), "incomplete");
  assert.match(String(at(output, "diagnostics", 0, "message")), /-I -S/);
});

await test("dynamic imports resolve aliases and refuse targets that cannot be checked", (t) => {
  const options = {
    forbiddenImports: [{ module: "subprocess", reason: "Use the reviewed boundary" }],
  };
  const bypasses = [
    "import importlib\nimportlib.import_module('subprocess')\n",
    "import importlib as il\nil.import_module('subprocess.run')\n",
    "from importlib import import_module as load\nload('subprocess')\n",
    "__import__('subprocess')\n",
    "import builtins as b\nb.__import__(name='subprocess')\n",
  ];
  for (const [index, source] of bypasses.entries()) {
    const output = fixture(t, { [`bypass${index}.py`]: source }, options).direct();
    assert.equal(output.status, "violation", source);
    assert.equal(output.diagnostics[0].rule, "python/import");
  }
  const allowed = fixture(
    t,
    { "allowed.py": "import importlib\nimportlib.import_module('json')\n" },
    options,
  ).direct();
  assert.equal(allowed.status, "pass");
  const dynamic = [
    "import importlib\nname = 'x'\nimportlib.import_module(name)\n",
    "__import__(f'sub{1}')\n",
    "from importlib import import_module\nimport_module('.x', 'pkg')\n",
    "from importlib import import_module\nloader = import_module\nloader('subprocess')\n",
  ];
  for (const [index, source] of dynamic.entries()) {
    const output = fixture(t, { [`dynamic${index}.py`]: source }, options).direct();
    assert.equal(output.status, "incomplete", source);
    assert.equal(output.diagnostics[0].rule, "python/import");
  }
  const unscoped = fixture(t, { "main.py": "name = 'x'\n__import__(name)\n" }).direct();
  assert.equal(unscoped.status, "pass");
});

await test("silent exception handlers and bare excepts are violations while handled errors pass", (t) => {
  const { direct } = fixture(t, {
    "bare.py": "try:\n    run()\nexcept:\n    raise\n",
    "passes.py": "try:\n    run()\nexcept Exception:\n    pass\n",
    "ellipsis.py": "try:\n    run()\nexcept (ValueError, KeyError):\n    ...\n",
    "aliased.py":
      "from builtins import BaseException as Broad\ntry:\n    run()\nexcept Broad as error:\n    pass\n",
    "handled.py":
      "try:\n    run()\nexcept ValueError as error:\n    raise RuntimeError('x') from error\n",
  });
  const output = direct();
  assert.equal(output.status, "violation");
  assert.deepEqual(
    output.diagnostics.map((item) => item.path),
    ["aliased.py", "bare.py", "ellipsis.py", "passes.py"],
  );
  assert.ok(
    output.diagnostics.every(
      (item) => item.rule === "python/except" && (item.line ?? 0) > 0 && (item.column ?? 0) > 0,
    ),
  );
});

await test("except-star handlers are checked where the interpreter parses them and refused as syntax before 3.11", (t) => {
  const [major, minor] = String(at(manifest, "adapters", 0, "tools", "python"))
    .split(".")
    .map(Number);
  const output = fixture(t, {
    "group.py": "try:\n    run()\nexcept* ValueError:\n    pass\n",
  }).direct();
  assert.equal(output.status, "violation");
  assert.equal(
    output.diagnostics[0].rule,
    major > 3 || minor >= 11 ? "python/except" : "python/syntax",
  );
});

await test("test files refuse skip, xfail and skip-call bypasses through aliases while helpers stay unaffected", (t) => {
  const { direct } = fixture(t, {
    "test_plain.py": "import pytest\n@pytest.mark.skip\ndef test_a():\n    pass\n",
    "test_alias.py": "import pytest as p\n@p.mark.xfail(reason='x')\ndef test_b():\n    pass\n",
    "api_test.py":
      "from pytest import mark\n@mark.skipif(True, reason='x')\ndef test_c():\n    pass\n",
    "test_call.py": "import pytest\ndef test_d():\n    pytest.skip('later')\n",
    "test_unittest.py":
      "import unittest as u\nclass T(u.TestCase):\n    @u.skipIf(True, 'x')\n    def test_e(self):\n        self.skipTest('no')\n",
    "test_marks.py": "import pytest\nparam = pytest.param(1, marks=pytest.mark.skip)\n",
    "test_clean.py":
      "import pytest\ndef test_ok():\n    with pytest.raises(ValueError):\n        int('x')\n",
    "helper.py": "import pytest\npytest.skip('helpers are not tests')\n",
  });
  const output = direct();
  assert.equal(output.status, "violation");
  // these fixtures have empty bodies on purpose; python/assertion has its own tests in
  // adapter-assertion.test.ts
  const skips = output.diagnostics.filter((item) => item.rule === "python/skip");
  assert.deepEqual(
    skips.map((item) => item.path),
    [
      "api_test.py",
      "test_alias.py",
      "test_call.py",
      "test_marks.py",
      "test_plain.py",
      "test_unittest.py",
      "test_unittest.py",
    ],
  );
});
