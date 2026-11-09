import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { doctorAdapters } from "../../../src/adapters.ts";
import { digest } from "../../../src/files.ts";
import { at } from "../../../src/schema.ts";
import { lengthOf } from "../../../test/support.ts";
import { fixture, manifest, script } from "./adapter-support.ts";

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
  assert.equal(result.coverage.length, 2);
  for (const row of result.coverage) {
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
  assert.ok(result.coverage.every((row) => row.status === "incomplete" && !row.completed));
});

await test("doctor validates prerequisites and options without reading or claiming source coverage", async (t) => {
  const { direct, request, ctx, registry } = fixture(t, { "main.py": "def broken(:\n" });
  const output = direct({ ...request(), action: "doctor" });
  assert.equal(output.status, "pass");
  assert.deepEqual(output.coverage, []);
  assert.deepEqual(output.inputs, []);
  const result = await doctorAdapters(ctx, { registry });
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
  const doctor = await doctorAdapters(ctx, { registry });
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
