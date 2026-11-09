import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../../../src/cli.ts";
import { parseReport } from "../../../test/support.ts";
import { respond } from "../../sdk/adapter.ts";
import { definition, tokenize } from "../adapter.ts";

const script = fileURLToPath(new URL("../adapter.ts", import.meta.url));

const FORBIDDEN = { forbiddenImports: [{ path: "os/exec", reason: "Use the reviewed runner" }] };

function folder(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function check(t: TestContext, files: Record<string, string>, options: unknown = FORBIDDEN) {
  const root = folder(t, "plumb-go-");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const response = respond(definition, {
    schemaVersion: 1,
    action: "check",
    adapter: "go",
    version: definition.version,
    root,
    project: { root: ".", profile: "go", options },
    files: Object.entries(files).map(([path, content]) => ({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  });
  return {
    root,
    response,
    found: response.diagnostics.map((item) => [item.path, item.rule, item.status ?? "violation"]),
  };
}

await test("every way of writing an import declaration reaches the boundary", (t) => {
  const sources: Record<string, string> = {
    "single.go": 'package a\nimport "os/exec"\n',
    "alias.go": 'package a\nimport run "os/exec"\n',
    "dot.go": 'package a\nimport . "os/exec"\n',
    "blank.go": 'package a\nimport _ "os/exec"\n',
    "group.go": 'package a\nimport (\n\t"fmt"\n\trun "os/exec"\n)\n',
    "raw.go": "package a\nimport `os/exec`\n",
    "child.go": 'package a\nimport "os/exec/internal/fdtest"\n',
    "oneline.go": 'package a; import ("fmt"; "os/exec")\n',
    "commented.go": 'package a\nimport /* why */ "os/exec" // note\n',
  };
  const { found, response } = check(t, sources);
  assert.deepEqual(
    found,
    Object.keys(sources).map((path) => [path, "go/import", "violation"]),
  );
  assert.deepEqual([response.diagnostics[0]?.line, response.diagnostics[0]?.column], [2, 8]);
});

await test("a path hidden behind escapes or an unreadable source is incomplete", (t) => {
  for (const source of [
    'package a\nimport "os/\\x65xec"\n',
    'package a\nvar s = "unterminated\n',
    "package a\n/* never closed\n",
  ]) {
    const { response } = check(t, { "a.go": source });
    assert.equal(response.status, "incomplete", source);
  }
});

await test("text inside strings and comments is not code, and siblings are not descendants", (t) => {
  const { response } = check(t, {
    "a.go":
      'package a\nimport "os/execx"\nimport "fmt"\n// import "os/exec"\nvar a = "import \\"os/exec\\""\nvar b = `\nimport "os/exec"\n//nolint\n`\nvar c = \'"\'\nfunc f(t T) { fmt.Println(a, b, c); t.Skip() }\n',
  });
  assert.deepEqual(response.diagnostics, []);
  assert.equal(response.status, "pass");
  assert.deepEqual(
    tokenize('a // b\n"c"').map((token) => [token.kind, token.line, token.column]),
    [
      ["word", 1, 1],
      ["comment", 1, 3],
      ["string", 2, 1],
    ],
  );
});

await test("suppression directives and skipped tests are refused", (t) => {
  const { found } = check(
    t,
    {
      "a.go": "package a\nvar x = 1 //nolint:errcheck\n// #nosec G204\n//lint:ignore U1000 later\n",
      "a_test.go":
        'package a\nfunc TestA(t *testing.T) {\n\tt.Skip("later")\n\ttb.Skipf("x")\n\tt.SkipNow()\n}\n',
    },
    {},
  );
  assert.deepEqual(found, [
    ["a.go", "go/directive", "violation"],
    ["a.go", "go/directive", "violation"],
    ["a.go", "go/directive", "violation"],
    ["a_test.go", "go/skip", "violation"],
    ["a_test.go", "go/skip", "violation"],
    ["a_test.go", "go/skip", "violation"],
  ]);
});

await test("the adapter runs through the core from its own manifest", async (t) => {
  const root = folder(t, "plumb-go-e2e-"),
    tools = folder(t, "plumb-go-tools-"),
    registry = join(tools, "registry.json");
  const printed = spawnSync(process.execPath, [script, "--manifest"], { encoding: "utf8" });
  assert.equal(printed.status, 0, printed.stderr);
  writeFileSync(registry, printed.stdout);
  writeFileSync(
    join(root, "plumb.json"),
    JSON.stringify({
      schemaVersion: 1,
      preset: "portable",
      projects: [{ root: ".", profile: "go", options: FORBIDDEN }],
    }),
  );
  writeFileSync(join(root, "main.go"), 'package main\nimport "os/exec"\nvar _ = exec.Command\n');
  let text = "";
  const code = await main(
    ["check", "--root", root, "--adapters", registry, "--format", "json"],
    (chunk) => (text += chunk),
  );
  assert.equal(code, 1, text);
  assert.deepEqual(
    parseReport(text).diagnostics.map((item) => [item.rule, item.path, item.line]),
    [["go/import", "main.go", 2]],
  );
  writeFileSync(join(root, "main.go"), "package main\n");
  text = "";
  assert.equal(
    await main(["check", "--root", root, "--adapters", registry], (chunk) => (text += chunk)),
    0,
    text,
  );
});
