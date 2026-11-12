import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { Report } from "../../src/diagnostics.ts";
import { at } from "../../src/schema.ts";
import { mapped, parseReport } from "../support.ts";

const cli = fileURLToPath(new URL("../../bin/plumb.ts", import.meta.url));
const node = isAbsolute(process.execPath)
  ? process.execPath
  : ((process.env.PATH ?? "")
      .split(delimiter)
      .map((folder) => join(folder, process.execPath))
      .find(existsSync) ?? process.execPath);
const temporary =
  process.env.PLUMB_TEST_TMP ?? fileURLToPath(new URL("../../../.plumb-tests/", import.meta.url));
const pythonPass =
  '"""Greet the caller."""\n\n\ndef greet(name: str) -> str:\n    """Return a greeting for the given name."""\n    return f"hello {name}"\n';
const rustPass = 'fn main() {\n    println!("hello");\n}\n';
const CARGO = '[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n';
const LOCK = 'version = 4\n\n[[package]]\nname = "probe"\nversion = "0.1.0"\n';
const PYTHON_TOOLS = [
  ["ruff", "--version"],
  ["mypy", "--version"],
];
const RUST_TOOLS = [
  ["cargo", "--version"],
  ["cargo", "fmt", "--version"],
  ["cargo", "clippy", "--version"],
];

function execute(
  command: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): SpawnSyncReturns<string> {
  return spawnSync(command[0] ?? "", command.slice(1), {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function requireTools(commands: readonly (readonly string[])[]): string[] {
  const probes = commands.map((command) => ({ command, result: execute(command) }));
  const failures = probes.filter(({ result }) => result.error || result.status !== 0);
  assert.equal(
    failures.length,
    0,
    `Native integration prerequisites unavailable:\n${failures.map(({ command, result }) => `${command.join(" ")}: ${result.error?.message ?? result.stderr ?? result.stdout}`).join("\n")}\nInstall ruff, mypy and a Rust toolchain with cargo, rustfmt and clippy. This suite never skips missing tools.`,
  );
  return probes.map(({ result }) => `${result.stdout}\n${result.stderr}`.trim());
}

function fixture(
  t: TestContext,
  projects: unknown[],
  contents: Record<string, string>,
): { root: string; write: (path: string, text: string) => void } {
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, "native-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  // the preset selects unrelated repository contracts; native profiles retain their full strict assets.
  write("plumb.json", `${JSON.stringify({ schemaVersion: 1, preset: "portable", projects })}\n`);
  for (const [path, text] of Object.entries(contents)) {
    write(path, text);
  }
  return { root, write };
}

function contents(root: string, prefix = ""): [string, string][] {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry): [string, string][] => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory()
        ? contents(root, path)
        : [[path, readFileSync(join(root, path)).toString("base64")]];
    });
}

function invoke(
  root: string,
  command: string,
  expectedCode: number,
  env: NodeJS.ProcessEnv = process.env,
  extra: string[] = [],
): Report {
  const before = command === "check" ? contents(root) : undefined;
  const result = execute([node, cli, command, "--root", root, "--format", "json", ...extra], {
    cwd: root,
    env,
  });
  assert.ifError(result.error);
  assert.equal(result.status, expectedCode, `plumb ${command}\n${result.stdout}\n${result.stderr}`);
  const body = parseReport(result.stdout);
  assert.equal(
    body.status,
    ["pass", "violation", "incomplete"][expectedCode],
    JSON.stringify(body, null, 2),
  );
  if (before) {
    assert.deepEqual(
      contents(root),
      before,
      "check must preserve the source, policy, and native assets",
    );
  }
  return body;
}

function covered(body: Report, id: string, status: string, files: string[]): void {
  const row = mapped(body.coverage, (item) => item).find((item) => at(item, "id") === id);
  assert.ok(row, `Missing native coverage record ${id}: ${JSON.stringify(body, null, 2)}`);
  assert.equal(at(row, "status"), status, JSON.stringify(body, null, 2));
  assert.equal(at(row, "completed"), status !== "incomplete");
  assert.deepEqual(at(row, "checkedFiles"), files);
}

const findings = (body: Report, rule: string): Report["diagnostics"] =>
  body.diagnostics.filter((item) => item.rule === rule);

function rustFixture(
  t: TestContext,
  files: Record<string, string> = {},
): ReturnType<typeof fixture> {
  const project = fixture(t, [{ root: ".", profile: "rust" }], {
    "Cargo.toml": CARGO,
    "Cargo.lock": LOCK,
    "src/main.rs": rustPass,
    ...files,
  });
  invoke(project.root, "sync", 0);
  assert.match(readFileSync(join(project.root, "rustfmt.toml"), "utf8"), /max_width = 100/);
  return project;
}

await test("real ruff and mypy accept strict Python and refuse format, lint and type findings", (t) => {
  requireTools(PYTHON_TOOLS).forEach((version) => {
    t.diagnostic(version);
  });
  const { root, write } = fixture(t, [{ root: ".", profile: "python" }], { "app.py": pythonPass });
  invoke(root, "sync", 0);
  assert.match(readFileSync(join(root, "ruff.toml"), "utf8"), /select = \["ALL"\]/);
  assert.match(readFileSync(join(root, "mypy.ini"), "utf8"), /strict = True/);
  const passed = invoke(root, "check", 0);
  for (const id of ["python.format:.", "python.lint:.", "python.types:."]) {
    covered(passed, id, "pass", ["app.py"]);
  }

  write("app.py", pythonPass.replace("(name: str)", "( name:str )"));
  const unformatted = invoke(root, "check", 1);
  covered(unformatted, "python.format:.", "violation", ["app.py"]);
  invoke(root, "fix", 0);
  assert.equal(readFileSync(join(root, "app.py"), "utf8"), pythonPass);

  // source no tool can parse was not formatted or typed: incomplete, with nothing covered
  write("app.py", pythonPass.replace("    return", "  return"));
  const unparsed = invoke(root, "check", 2);
  covered(unparsed, "python.format:.", "incomplete", []);
  covered(unparsed, "python.types:.", "incomplete", []);

  // a noqa comment suppresses nothing: the unused import is still reported
  write("app.py", pythonPass.replace("\n\n\ndef", "\n\nimport os  # noqa: F401\n\n\ndef"));
  const unused = invoke(root, "check", 1);
  covered(unused, "python.lint:.", "violation", ["app.py"]);
  assert.match(findings(unused, "python.lint")[0]?.message ?? "", /F401/);

  write("app.py", pythonPass.replace('return f"hello {name}"', "return len(name)"));
  const mistyped = invoke(root, "check", 1);
  covered(mistyped, "python.format:.", "pass", ["app.py"]);
  covered(mistyped, "python.types:.", "violation", ["app.py"]);
  assert.match(findings(mistyped, "python.types")[0]?.message ?? "", /return-value/);
});

await test("real rustfmt and clippy accept strict Rust and refuse format, lint and compile findings", (t) => {
  requireTools(RUST_TOOLS).forEach((version) => {
    t.diagnostic(version);
  });
  const { root, write } = rustFixture(t);
  const passed = invoke(root, "check", 0);
  covered(passed, "rust.format:.", "pass", ["src/main.rs"]);
  covered(passed, "rust.lint:.", "pass", []);

  write("src/main.rs", 'fn main(){println!("hello");}\n');
  const unformatted = invoke(root, "check", 1);
  covered(unformatted, "rust.format:.", "violation", ["src/main.rs"]);
  covered(unformatted, "rust.lint:.", "pass", []);
  invoke(root, "fix", 0);
  assert.equal(readFileSync(join(root, "src/main.rs"), "utf8"), rustPass);

  write(
    "src/main.rs",
    "fn one() -> i32 {\n    return 1;\n}\n\nfn main() {\n    let _ = one();\n}\n",
  );
  const linted = invoke(root, "check", 1);
  covered(linted, "rust.format:.", "pass", ["src/main.rs"]);
  covered(linted, "rust.lint:.", "violation", []);
  assert.deepEqual(
    findings(linted, "rust.lint").map((item) => [item.path, item.line, item.column]),
    [["src/main.rs", 2, 5]],
  );
  assert.match(findings(linted, "rust.lint")[0]?.message ?? "", /^clippy::needless_return: /);

  write("src/main.rs", 'fn main() {\n    let value: i32 = "text";\n}\n');
  const broken = invoke(root, "check", 1);
  assert.ok(findings(broken, "rust.lint").some((item) => /^E0308: /.test(item.message)));
});

await test("a Rust file no package target declares is incomplete, never a formatted pass", (t) => {
  requireTools(RUST_TOOLS);
  const { root } = rustFixture(t, { "src/orphan.rs": "pub fn orphan() {}\n" });
  const result = invoke(root, "check", 2);
  covered(result, "rust.format:.", "incomplete", []);
  assert.ok(
    result.diagnostics.some(
      (item) => item.rule === "native.scope" && /did not reach src\/orphan\.rs/.test(item.message),
    ),
  );
});

await test("a manifest or cargo config that switches a lint off is incomplete, never a pass", (t) => {
  requireTools(RUST_TOOLS);
  const linted = "fn one() -> i32 {\n    return 1;\n}\n\nfn main() {\n    let _ = one();\n}\n";
  for (const [path, text] of [
    ["Cargo.toml", `${CARGO}\n[lints.clippy]\nneedless_return = "allow"\n`],
    ["Cargo.toml", `${CARGO}\n[lints.clippy]\nneedless_return = { level = 'allow' }\n`],
    [".cargo/config.toml", '[build]\nrustflags = ["-Aclippy::needless_return"]\n'],
    [".cargo/config.toml", '[build]\nrustflags = ["--cap-lints", "warn"]\n'],
  ] as const) {
    const { root, write } = rustFixture(t, { "src/main.rs": linted });
    covered(invoke(root, "check", 1), "rust.lint:.", "violation", []);
    write(path, text);
    const result = invoke(root, "check", 2);
    assert.ok(
      findings(result, "native.scope").some((item) => item.message.startsWith(`${path}: `)),
      JSON.stringify(result.diagnostics),
    );
    assert.equal(findings(result, "rust.lint").length, 0);
  }
  // a warn level is still denied, so it is accepted and the finding stands
  const warned = rustFixture(t, {
    "src/main.rs": linted,
    "Cargo.toml": `${CARGO}\n[lints.clippy]\nneedless_return = "warn"\n`,
    ".cargo/config.toml": '[build]\nrustflags = ["-W", "clippy::needless_return"]\n',
  });
  covered(invoke(warned.root, "check", 1), "rust.lint:.", "violation", []);
});

await test("a Rust project without a lock file or a manifest is incomplete", (t) => {
  requireTools(RUST_TOOLS);
  const unlocked = rustFixture(t);
  rmSync(join(unlocked.root, "Cargo.lock"));
  const frozen = invoke(unlocked.root, "check", 2);
  covered(frozen, "rust.lint:.", "incomplete", []);
  assert.equal(existsSync(join(unlocked.root, "Cargo.lock")), false);
  const bare = fixture(t, [{ root: ".", profile: "rust" }], { "main.rs": rustPass });
  invoke(bare.root, "sync", 0);
  const scope = invoke(bare.root, "check", 2);
  assert.ok(
    findings(scope, "native.scope").some((item) => /Cargo\.toml is missing/.test(item.message)),
  );
});

await test("a source-policy adapter runs beside the tools of the profile that shares its id", (t) => {
  requireTools([...PYTHON_TOOLS, ...RUST_TOOLS, ["python3", "--version"]]);
  const adapters = [
    [
      "python3",
      "-I",
      "-S",
      fileURLToPath(new URL("../../packages/python/adapter.py", import.meta.url)),
    ],
    [node, fileURLToPath(new URL("../../packages/rust/adapter.ts", import.meta.url))],
  ].flatMap((command) => {
    const printed = execute([...command, "--manifest"]);
    assert.equal(printed.status, 0, printed.stderr);
    return mapped(at(JSON.parse(printed.stdout), "adapters"), (entry) => entry);
  });
  mkdirSync(temporary, { recursive: true });
  const tools = mkdtempSync(join(temporary, "native-integration-tools-")),
    registry = join(tools, "registry.json");
  t.after(() => rmSync(tools, { recursive: true, force: true }));
  writeFileSync(registry, JSON.stringify({ schemaVersion: 1, adapters }));
  const { root } = fixture(
    t,
    [
      {
        root: "python",
        profile: "python",
        options: {
          forbiddenImports: [{ module: "subprocess", reason: "Use the reviewed runner" }],
        },
      },
      {
        root: "rust",
        profile: "rust",
        options: {
          forbiddenImports: [{ path: "std::process", reason: "Use the reviewed runner" }],
        },
      },
    ],
    {
      "python/app.py": pythonPass.replace("\n\n\ndef", "\n\nimport subprocess\n\n\ndef"),
      "rust/Cargo.toml": CARGO,
      "rust/Cargo.lock": LOCK,
      "rust/src/main.rs": "fn main() {\n    std::process::exit(0);\n}\n",
    },
  );
  invoke(root, "sync", 0);
  const result = invoke(root, "check", 1, process.env, ["--adapters", registry]);
  covered(result, "rust.format:rust", "pass", ["rust/src/main.rs"]);
  covered(result, "rust.lint:rust", "pass", []);
  covered(result, "rust.policy:rust", "violation", ["rust/src/main.rs"]);
  assert.deepEqual(
    findings(result, "rust/import").map((item) => [item.path, item.line]),
    [["rust/src/main.rs", 2]],
  );
  covered(result, "python.format:python", "pass", ["python/app.py"]);
  covered(result, "python.syntax:python", "pass", ["python/app.py"]);
  covered(result, "python.policy:python", "violation", ["python/app.py"]);
  assert.deepEqual(
    findings(result, "python/import").map((item) => [item.path, item.line]),
    [["python/app.py", 3]],
  );
});

await test("the real CLI reports missing native executables as incomplete with no completed coverage", (t) => {
  const { root } = fixture(
    t,
    [
      { root: "python", profile: "python" },
      { root: "rust", profile: "rust" },
    ],
    {
      "python/app.py": pythonPass,
      "rust/Cargo.toml": CARGO,
      "rust/Cargo.lock": LOCK,
      "rust/src/main.rs": rustPass,
    },
  );
  invoke(root, "sync", 0);
  const emptyPath = join(root, "empty-path");
  mkdirSync(emptyPath);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  env.PATH = emptyPath;
  const result = invoke(root, "check", 2, env);
  for (const id of [
    "python.format:python",
    "python.lint:python",
    "python.types:python",
    "rust.format:rust",
    "rust.lint:rust",
  ]) {
    covered(result, id, "incomplete", []);
    assert.ok(
      result.diagnostics.some(
        (item) =>
          item.check === id &&
          item.status === "incomplete" &&
          /Cannot locate executable/.test(item.message),
      ),
    );
  }
});
