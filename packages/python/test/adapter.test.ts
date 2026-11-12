import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { doctorAdapters } from "../../../src/adapters.ts";
import { digest } from "../../../src/files.ts";
import { at } from "../../../src/schema.ts";
import { lengthOf } from "../../../test/support.ts";
import { execute, fixture, manifest, script } from "./adapter-support.ts";

await test("manifest pins the actual interpreter and adapter with a ready strict registry", (t) => {
  const { registry } = fixture(t),
    entry = registry?.adapters[0];
  assert.ok(entry);
  assert.equal(entry.id, "python");
  assert.deepEqual(entry.command.slice(1, 3), ["-I", "-S"]);
  assert.equal(entry.command[3], realpathSync(script));
  assert.equal(entry.integrity.length, 2);
  for (const pin of entry.integrity) {
    assert.ok(isAbsolute(pin.path));
    assert.equal(pin.sha256, digest(readFileSync(pin.path)));
  }
  assert.match(entry.tools?.python ?? "", /^\d+\.\d+\.\d+$/);
  assert.deepEqual(entry.environment, []);
  assert.equal(entry.optionsSchema.additionalProperties, false);
  assert.deepEqual(
    new Set(entry.rules.map((rule) => rule.capability)),
    new Set(["syntax", "policy"]),
  );
});

await test("real checks cover .py and .pyi sources without running candidate code or local modules", async (t) => {
  const candidate =
    "from pathlib import Path\nPath('executed').write_text('bad')\nraise RuntimeError('must not execute')\n";
  const { run, root, direct } = fixture(t, {
    "main.py": candidate,
    "ast.py": candidate,
    "sitecustomize.py": candidate,
    "api.pyi": "def run(value: int) -> str: ...\n",
  });
  const result = await run();
  assert.deepEqual(result.diagnostics, []);
  // the python profile also runs ruff and mypy rows; only the adapter's own rows are asserted here
  const rows = result.coverage.filter(
    (row) => row.capability === "syntax" || row.capability === "policy",
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, "pass");
    assert.equal(row.completed, true);
    assert.deepEqual(row.checkedFiles, ["api.pyi", "ast.py", "main.py", "sitecustomize.py"]);
  }
  assert.equal(direct().status, "pass");
  assert.equal(existsSync(join(root, "executed")), false);
  assert.equal(existsSync(join(root, "__pycache__")), false);
});

await test("source evidence hashes raw bytes including encoding cookies and UTF-8 BOMs", async (t) => {
  const raw = Buffer.from("# coding: latin-1\nlabel = 'caf\u00e9'\n", "latin1");
  const { run, direct } = fixture(t, {
    "latin.py": raw,
    "bom.py": Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("value = 1\n")]),
  });
  const output = direct();
  assert.equal(output.status, "pass");
  assert.equal(output.inputs.find((entry) => entry.path === "latin.py")?.sha256, digest(raw));
  const result = await run();
  assert.deepEqual(result.diagnostics, []);
  assert.equal(
    result.coverage.every((row) => row.status === "pass"),
    true,
  );
});

await test("forbidden imports enforce module prefixes, imported names and project-relative imports", async (t) => {
  const source =
    "label = '\u00e9'; import subprocess\nfrom pkg import private\nfrom . import hidden\n";
  const options = {
    forbiddenImports: ["subprocess", "pkg.private", "app.hidden"].map((module) => ({
      module,
      reason: "Use the reviewed boundary",
    })),
  };
  const { run, direct } = fixture(
    t,
    {
      "src/app/main.py": source,
      "src/app/allowed.py": "import subprocess_helper\nfrom pkg import public\n",
    },
    options,
    "src",
  );
  const output = direct();
  assert.equal(output.status, "violation");
  assert.equal(output.diagnostics.length, 3);
  assert.ok(
    output.diagnostics.every(
      (item) => item.rule === "python/import" && item.path === "src/app/main.py",
    ),
  );
  assert.equal(output.diagnostics[0].column, source.indexOf("import") + 1);
  const result = await run();
  assert.equal(result.coverage.find((row) => row.capability === "policy")?.status, "violation");
  assert.equal(result.coverage.find((row) => row.capability === "syntax")?.status, "pass");
  assert.equal(
    result.diagnostics.every((item) => item.suppressible),
    true,
  );
});

await test("unresolvable relative and overlapping wildcard imports are incomplete", (t) => {
  const { direct } = fixture(
    t,
    { "main.py": "from ..pkg import item\nfrom pkg import *\n" },
    { forbiddenImports: [{ module: "pkg.private", reason: "Private boundary" }] },
  );
  const output = direct();
  assert.equal(output.status, "incomplete");
  assert.equal(output.diagnostics.length, 2);
  assert.ok(
    output.diagnostics.every(
      (item) => item.rule === "python/import" && item.status === "incomplete",
    ),
  );
});

await test("real comment directives are protected while strings and docstrings are harmless", async (t) => {
  const controls = [
    "noqa: F401",
    "ruff: noqa",
    "flake8: noqa",
    "type: ignore[arg-type]",
    "fmt: off",
    "fmt: skip",
    "yapf: disable",
    "isort: skip_file",
    "autopep8: off",
    "pylint: disable=all",
    "pyright: ignore",
    "mypy: ignore-errors",
    "pragma: no cover",
    "nosec",
    "nosec: B101",
  ];
  const files = Object.fromEntries(
    controls.map((control, index) => [
      `deny${String(index).padStart(2, "0")}.py`,
      `value = 1  # ${control}\n`,
    ]),
  );
  files["allow.py"] =
    `text = '# noqa'\nraw = r'# fmt: off'\nplain = '# pragma: no cover'\n"""# type: ignore\n# ruff: noqa\n"""\n# Explain why noqa is not used here.\n# fmt: on\n`;
  const { run, direct } = fixture(t, files);
  const output = direct();
  assert.equal(output.status, "violation");
  assert.equal(output.diagnostics.length, controls.length);
  assert.ok(
    output.diagnostics.every(
      (item) => item.rule === "python/directive" && item.line === 1 && item.column === 12,
    ),
  );
  const result = await run();
  assert.equal(result.diagnostics.length, controls.length);
  assert.ok(result.diagnostics.every((item) => item.suppressible === false));
});

await test("syntax errors, invalid encodings and context-invalid ASTs never claim policy completion", async (t) => {
  const { direct, run } = fixture(t, {
    "invalid.py": "def broken(:\n",
    "return.py": "return 1\n",
    "encoding.py": Buffer.from([255, 10]),
    "good.py": "pass\n",
  });
  const output = direct();
  assert.equal(output.status, "incomplete");
  assert.equal(output.diagnostics.length, 3);
  assert.ok(
    output.diagnostics.every(
      (item) => item.rule === "python/syntax" && item.status === "incomplete",
    ),
  );
  assert.deepEqual(
    at(
      output.coverage.find((row) => at(row, "capability") === "policy"),
      "files",
    ),
    ["good.py"],
  );
  const result = await run();
  assert.ok(result.diagnostics.some((item) => item.rule === "adapters.coverage"));
  // the ruff and mypy rows are not the adapter's; the adapter's rows must never claim completion
  const rows = result.coverage.filter(
    (row) => row.capability === "syntax" || row.capability === "policy",
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === "incomplete" && !row.completed));
});

await test("doctor validates prerequisites and options without reading or claiming source coverage", async (t) => {
  const { direct, request, ctx, registry } = fixture(t, { "main.py": "def broken(:\n" });
  const output = direct({ ...request(), action: "doctor" });
  assert.equal(output.status, "pass");
  assert.deepEqual(output.coverage, []);
  assert.deepEqual(output.inputs, []);
  const result = await doctorAdapters(ctx, { registry, execute });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.checks[0].status, "ready");
  assert.equal(result.checks[0].evidence, "prerequisites-only");
});

await test("generic prepare metadata is accepted without running its commands during check or doctor", async (t) => {
  const prepare = [
    [
      at(manifest, "adapters", 0, "command", 0),
      "-I",
      "-S",
      "-c",
      "from pathlib import Path; Path('prepared').write_text('must not run')",
    ],
  ];
  const { run, direct, root, ctx, registry } = fixture(t, undefined, {}, ".", { prepare });
  assert.equal(direct().status, "pass");
  const result = await run();
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.coverage.every((row) => row.status === "pass"));
  const doctor = await doctorAdapters(ctx, { registry, execute });
  assert.deepEqual(doctor.diagnostics, []);
  assert.equal(doctor.checks[0].status, "ready");
  assert.equal(existsSync(join(root, "prepared")), false);
});

await test("missing source and wrong expected hashes are incomplete with explicit input evidence", async (t) => {
  const { root, direct, request, run } = fixture(t);
  const changed = request();
  changed.files = changed.files.map((item) => ({ ...item, sha256: "0".repeat(64) }));
  changed.inputs = changed.files;
  const mismatch = direct(changed);
  assert.equal(mismatch.status, "incomplete");
  assert.match(mismatch.diagnostics[0].message, /hash differs/);
  assert.equal(mismatch.inputs[0].sha256, digest("value = 1\n"));
  assert.ok(mismatch.coverage.every((row) => lengthOf(at(row, "files")) === 0));
  rmSync(join(root, "main.py"));
  const absent = direct();
  assert.equal(absent.status, "incomplete");
  assert.deepEqual(absent.inputs, [{ path: "main.py", sha256: null }]);
  const result = await run();
  assert.ok(result.diagnostics.some((item) => item.rule === "python/input"));
  assert.ok(result.coverage.every((row) => row.status === "incomplete"));
});

const FORBID_SUBPROCESS = {
  forbiddenImports: [{ module: "subprocess", reason: "Use the reviewed runner" }],
};

await test("dynamic imports resolve names in their lexical scope, so a decoy binding hides nothing", (t) => {
  const violations: Record<string, string> = {
    "plain.py": 'import importlib\nimportlib.import_module("subprocess")\n',
    // a nested import of the same name belongs to its own scope, not to the module-level call
    "decoy.py":
      'from importlib import import_module as load\ndef _decoy():\n    from json import load\n    return load\nload("subprocess")\n',
    "closure.py":
      'import importlib as il\ndef run():\n    return il.import_module(name="subprocess.tools")\n',
    "star.py": 'from importlib import *\nimport_module("subprocess")\n',
    "global.py":
      'def setup():\n    global il\n    import importlib as il\nil.import_module("subprocess")\n',
    "builtin.py": '__import__("subprocess")\n',
    "builtins.py": '__builtins__.__import__("subprocess")\n',
    // a class body's own names are invisible to its methods
    "method.py":
      'import importlib\nclass Loader:\n    importlib = None\n    def run(self):\n        return importlib.import_module("subprocess")\n',
    "rebound.py":
      'import importlib\nif False:\n    importlib = None\nimportlib.import_module("subprocess")\n',
    "assigned.py":
      'import importlib\nil = importlib\nload = il.import_module\nload("subprocess")\n',
    "walrus.py":
      'import importlib\n(il := importlib).import_module\nil.import_module("subprocess")\n',
  };
  const { direct } = fixture(t, violations, FORBID_SUBPROCESS);
  const found = direct().diagnostics.filter((item) => item.status !== "incomplete");
  assert.deepEqual(
    found.map((item) => [item.path, item.rule]),
    Object.keys(violations)
      .sort()
      .map((path) => [path, "python/import"]),
  );
});

await test("import machinery that escapes analysis is incomplete, never a pass", (t) => {
  const escapes: Record<string, string> = {
    "getattr.py": 'import importlib\ngetattr(importlib, "import_module")("subprocess")\n',
    "internals.py": 'import importlib\nimportlib.__dict__["import_module"]("subprocess")\n',
    "argument.py": "import importlib\ndef run(module):\n    return module\nrun(importlib)\n",
    "tuple.py": 'import importlib\nil, other = importlib, 1\nil.import_module("subprocess")\n',
    "attribute.py":
      'import importlib\nclass Box:\n    pass\nBox.il = importlib\nBox.il.import_module("subprocess")\n',
    "class_body.py":
      'class Box:\n    import importlib\nBox.importlib.import_module("subprocess")\n',
    "computed.py": 'import importlib\nname = "sub" + "process"\nimportlib.import_module(name)\n',
    "reference.py": "import functools\nload = functools.partial(__import__)\n",
  };
  for (const [path, source] of Object.entries(escapes)) {
    const output = fixture(t, { [path]: source }, FORBID_SUBPROCESS).direct();
    assert.equal(output.status, "incomplete", path);
    assert.ok(
      output.diagnostics.every((item) => item.rule === "python/import"),
      path,
    );
  }
});

await test("names that only look like import machinery are not reported", (t) => {
  const { direct } = fixture(
    t,
    {
      "local.py": 'def import_module(name):\n    return name\nimport_module("subprocess")\n',
      "nested.py":
        'def read(handle):\n    from json import load\n    return load(handle)\nimport importlib\nimportlib.import_module("json")\n',
      "tools.py":
        'import importlib\nimport importlib.util\nimportlib.reload\nimportlib.util.find_spec("json")\n',
      "text.py": "label = \"importlib.import_module('subprocess')\"\n",
    },
    FORBID_SUBPROCESS,
  );
  const output = direct();
  assert.deepEqual(output.diagnostics, []);
  assert.equal(output.status, "pass");
});

await test("test skips are found through aliases, assignments and decoy scopes", (t) => {
  const skipped: Record<string, string> = {
    "test_alias.py": "import pytest as checks\n@checks.mark.skip\ndef test_a():\n    pass\n",
    "test_assigned.py": "import pytest\nmark = pytest.mark\n@mark.xfail\ndef test_a():\n    pass\n",
    // the decorator is evaluated outside the function, whatever the body rebinds
    "test_decoy.py":
      "import pytest\ndef _decoy():\n    import json as pytest\n    return pytest\n@pytest.mark.skip\ndef test_a():\n    pytest = None\n    return pytest\n",
    "test_parameter.py": "def test_a(pytest):\n    pytest.skip()\n",
    "test_unittest.py":
      "from unittest import skip as later\n@later('soon')\ndef test_a():\n    return 1\n",
  };
  const { direct } = fixture(t, {
    ...skipped,
    "test_clean.py": "import json as pytest\ndef test_a():\n    assert pytest.dumps(1) == '1'\n",
  });
  assert.deepEqual(
    [
      ...new Set(
        direct()
          .diagnostics.filter((item) => item.rule === "python/skip")
          .map((item) => `${item.path} ${item.rule}`),
      ),
    ],
    Object.keys(skipped)
      .sort()
      .map((path) => `${path} python/skip`),
  );
});
