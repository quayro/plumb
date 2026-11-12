import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { nativeRun } from "../src/adapter-native.ts";
import { definePlumb } from "../src/config.ts";
import { safePath } from "../src/files.ts";
import { NATIVE, nativeSource, nativeSteps } from "../src/native.ts";
import type { Execute, RunResult } from "../src/process.ts";

function fixture(
  contents: Record<string, string>,
  verify: (root: string, files: string[]) => void,
): void {
  const root = mkdtempSync(join(process.cwd(), ".plumb-native-test-"));
  try {
    for (const [path, content] of Object.entries(contents)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    verify(root, Object.keys(contents));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// a context as the engine builds it for one native project, without the engine
async function nativeProject(
  profile: "python" | "rust",
  contents: Record<string, string>,
  verify: (
    ctx: Parameters<typeof nativeRun>[0],
    project: Parameters<typeof nativeRun>[1],
    root: string,
  ) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(process.cwd(), ".plumb-native-test-"));
  try {
    for (const [path, content] of Object.entries(contents)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const config = definePlumb({
      schemaVersion: 1,
      preset: "portable",
      projects: [{ root: ".", profile }],
    });
    const files = Object.keys(contents);
    const ctx = {
      root,
      files,
      config,
      safePath: (path: unknown) => safePath(root, path),
    };
    await verify(ctx, config.projects[0], root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const result = (code: number, stdout = "", stderr = ""): RunResult => ({ code, stdout, stderr });

const version = "--version";

const lines = (...messages: unknown[]): string =>
  messages.map((message) => `${JSON.stringify(message)}\n`).join("");

await test("NATIVE covers exactly the python and rust profiles and their sources", () => {
  assert.deepEqual(NATIVE, ["python", "rust"]);
  assert.equal(nativeSource("python", "pkg/a.py"), true);
  assert.equal(nativeSource("python", "stubs/a.pyi"), true);
  assert.equal(nativeSource("python", "notes.pyc"), false);
  assert.equal(nativeSource("python", "a.rs"), false);
  assert.equal(nativeSource("rust", "src/lib.rs"), true);
  assert.equal(nativeSource("rust", "src/lib.rs.bak"), false);
  assert.equal(nativeSource("rust", "lib.py"), false);
  assert.equal(nativeSource("typescript", "src/main.ts"), false);
  // removed languages are not governed by the core, so no profile or source is checked
  assert.equal(nativeSource("ruby", "lib/tool.rb"), false);
  assert.equal(nativeSource("cpp", "src/main.cpp"), false);
});

await test("python check mode runs ruff format, ruff lint and mypy on the selected files", () => {
  fixture({ "main.py": "x = 1\n", "stub.pyi": "", "readme.txt": "" }, (root, files) => {
    const steps = nativeSteps({
      root,
      files,
      config: { projects: [{ root: ".", profile: "python" }] },
    });
    assert.deepEqual(
      steps.map(({ rule }) => rule),
      ["python.format", "python.lint", "python.types"],
    );
    assert.deepEqual(
      steps.map(({ tool }) => tool),
      ["ruff", "ruff", "mypy"],
    );
    const [format, lint, types] = steps;
    assert.deepEqual(format.command, [
      "ruff",
      "format",
      "--check",
      "--config",
      join(root, "ruff.toml"),
      "--no-cache",
      "--",
      "./main.py",
      "./stub.pyi",
    ]);
    assert.deepEqual(format.versionCommand, ["ruff", "--version"]);
    assert.deepEqual(lint.command, [
      "ruff",
      "check",
      "--no-fix",
      "--ignore-noqa",
      "--output-format",
      "concise",
      "--config",
      join(root, "ruff.toml"),
      "--no-cache",
      "--",
      "./main.py",
      "./stub.pyi",
    ]);
    assert.deepEqual(types.command, [
      "mypy",
      "--config-file",
      join(root, "mypy.ini"),
      "--cache-dir",
      devNull,
      "--no-error-summary",
      "--",
      "./main.py",
      "./stub.pyi",
    ]);
    assert.deepEqual(format.files, ["main.py", "stub.pyi"]);
    assert.equal(format.fix, false);
    assert.equal(format.cwd, root);
  });
});

await test("python fix mode writes formatting only, with no check, lint or type step", () => {
  fixture({ "main.py": "x = 1\n" }, (root, files) => {
    const steps = nativeSteps(
      { root, files, config: { projects: [{ root: ".", profile: "python" }] } },
      "fix",
    );
    assert.equal(steps.length, 1);
    assert.equal(steps[0].rule, "python.format");
    assert.deepEqual(steps[0].command, [
      "ruff",
      "format",
      "--config",
      join(root, "ruff.toml"),
      "--no-cache",
      "--",
      "./main.py",
    ]);
    assert.equal(steps[0].fix, true);
  });
});

await test("python runs in its project root and takes only its own sources", () => {
  fixture({ "app/main.py": "", "app/lib/util.py": "", "other/file.py": "" }, (root, files) => {
    const [step] = nativeSteps(
      { root, files, config: { projects: [{ root: "app", profile: "python" }] } },
      "fix",
    );
    assert.equal(step.cwd, join(root, "app"));
    assert.deepEqual(step.files, ["app/lib/util.py", "app/main.py"]);
    assert.ok(step.command.includes("./lib/util.py"));
    assert.ok(!step.command.some((argument) => argument.includes("other")));
  });
});

await test("python without source files is a scope error, never an empty pass", () => {
  fixture({ "readme.txt": "", "lib.rs": "" }, (root, files) => {
    assert.throws(
      () => nativeSteps({ root, files, config: { projects: [{ root: ".", profile: "python" }] } }),
      /no python source files/,
    );
  });
});

await test("nested python projects own their source exactly once, including one-letter roots", () => {
  fixture({ "main.py": "", "a/lib.py": "", "a/deep/inner.py": "" }, (root, files) => {
    const config = {
      projects: [
        { root: ".", profile: "python" },
        { root: "./a/", profile: "python" },
        { root: "a/deep", profile: "python" },
      ],
    };
    const formats = nativeSteps({ root, files, config }, "fix");
    assert.deepEqual(
      formats.map(({ path }) => path),
      [".", "a", "a/deep"],
    );
    assert.deepEqual(
      formats.map(({ command }) => command.slice(command.indexOf("--") + 1)),
      [["./main.py"], ["./lib.py"], ["./inner.py"]],
    );
  });
});

await test("rust check mode runs rustfmt with a named-file report and clippy for the whole package", () => {
  fixture({ "Cargo.toml": "", "src/main.rs": "fn main() {}\n" }, (root, files) => {
    const steps = nativeSteps({
      root,
      files,
      config: { projects: [{ root: ".", profile: "rust" }] },
    });
    assert.deepEqual(
      steps.map(({ rule }) => rule),
      ["rust.format", "rust.lint"],
    );
    assert.deepEqual(
      steps.map(({ tool }) => tool),
      ["rustfmt", "clippy"],
    );
    const [format, lint] = steps;
    assert.deepEqual(format.command, [
      "cargo",
      "fmt",
      "--check",
      "--",
      "--config-path",
      join(root, "rustfmt.toml"),
      "--color",
      "never",
      "--verbose",
    ]);
    assert.deepEqual(format.versionCommand, ["cargo", "fmt", "--version"]);
    assert.deepEqual(format.files, ["src/main.rs"]);
    const target = join(
      tmpdir(),
      "plumb-cargo",
      createHash("sha256").update(root).digest("hex").slice(0, 16),
    );
    assert.deepEqual(lint.command, [
      "cargo",
      "clippy",
      "--frozen",
      "--all-targets",
      "--all-features",
      "--target-dir",
      target,
      "--message-format=json",
      "--",
      "-D",
      "warnings",
    ]);
    assert.deepEqual(lint.versionCommand, ["cargo", "clippy", "--version"]);
    assert.deepEqual(lint.files, []);
  });
});

await test("rust fix mode writes formatting only, with no check and no verbose report", () => {
  fixture({ "Cargo.toml": "", "src/main.rs": "" }, (root, files) => {
    const steps = nativeSteps(
      { root, files, config: { projects: [{ root: ".", profile: "rust" }] } },
      "fix",
    );
    assert.equal(steps.length, 1);
    assert.deepEqual(steps[0].command, [
      "cargo",
      "fmt",
      "--",
      "--config-path",
      join(root, "rustfmt.toml"),
      "--color",
      "never",
    ]);
  });
});

await test("a rust project without a Cargo.toml is a scope error", () => {
  fixture({ "src/main.rs": "" }, (root, files) => {
    assert.throws(
      () => nativeSteps({ root, files, config: { projects: [{ root: ".", profile: "rust" }] } }),
      /Cargo\.toml is missing/,
    );
  });
  fixture({ "Cargo.toml": "", "readme.txt": "" }, (root, files) => {
    assert.throws(
      () => nativeSteps({ root, files, config: { projects: [{ root: ".", profile: "rust" }] } }),
      /no rust source files/,
    );
  });
});

await test("a lints table or rustflags that loosen clippy are a scope error in every spelling", () => {
  const steps = (contents: Record<string, string>, root = "."): void => {
    fixture({ "src/main.rs": "", "member/src/lib.rs": "", ...contents }, (folder, files) => {
      nativeSteps({ root: folder, files, config: { projects: [{ root, profile: "rust" }] } });
    });
  };
  for (const manifest of [
    '[lints.clippy]\nall = "allow"\n',
    "[lints.rust]\nunused = { level = 'allow', priority = 1 }\n",
    'lints = { clippy = { all = "allow" } }\n',
    'workspace = { members = ["#"], lints = { clippy = { all = "allow" } } }\n',
    '# [lints]\n# all = "allow"\n',
  ]) {
    assert.throws(() => steps({ "Cargo.toml": manifest }), /Cargo\.toml: a lints table/, manifest);
    // a workspace member's manifest counts as much as the root's
    assert.throws(
      () => steps({ "Cargo.toml": "", "member/Cargo.toml": manifest }),
      /member\/Cargo\.toml: a lints table/,
    );
  }
  for (const flags of [
    '["-A", "warnings"]',
    '["-Aclippy::all"]',
    '["--cap-lints=warn"]',
    '["--allow", "x"]',
  ]) {
    const config = `[build]\nrustflags = ${flags}\n`;
    for (const name of [".cargo/config.toml", ".cargo/config"]) {
      assert.throws(
        () => steps({ "Cargo.toml": "", [name]: config }),
        /rustflags that allow or cap/,
        flags,
      );
    }
    // cargo also reads the configuration of every folder above the project
    assert.throws(
      () => steps({ "member/Cargo.toml": "", ".cargo/config.toml": config }, "member"),
      /^Error: \.cargo\/config\.toml: rustflags/,
    );
  }
  steps({
    // a warn level is still denied by -D warnings, so it loosens nothing
    "Cargo.toml": '[lints.clippy]\npedantic = "warn"\nall = "deny"\n[features]\nallow = []\n',
    ".cargo/config.toml": '[build]\nrustflags = ["-C", "link-arg=-Wl,-dead_strip", "-W", "x"]\n',
  });
});

await test("removed profiles produce no native steps", () => {
  fixture({ "lib/tool.rb": "", "src/main.cpp": "" }, (root, files) => {
    assert.deepEqual(
      nativeSteps({ root, files, config: { projects: [{ root: ".", profile: "ruby" }] } }),
      [],
    );
  });
});

await test("a missing Cargo.toml reaches the report as native.scope and runs no tool", async () => {
  await nativeProject("rust", { "src/main.rs": "" }, async (ctx, project) => {
    let calls = 0;
    const execute: Execute = async () => {
      calls++;
      return result(0);
    };
    const run = await nativeRun(ctx, project, execute, false);
    assert.equal(calls, 0);
    assert.equal(run.diagnostics[0].rule, "native.scope");
    assert.equal(run.diagnostics[0].status, "incomplete");
  });
});

await test("rustfmt that never names a selected file leaves that file out of coverage", async () => {
  await nativeProject(
    "rust",
    { "Cargo.toml": "", "src/main.rs": "", "src/orphan.rs": "" },
    async (ctx, project, root) => {
      const execute: Execute = async (command) => {
        if (command.at(-1) === version) {
          return result(0, "1.0.0");
        }
        if (command.includes("fmt")) {
          return result(0, `Formatting ${join(root, "src/main.rs")}\n`);
        }
        return result(0, lines({ reason: "build-finished", success: true }));
      };
      const run = await nativeRun(ctx, project, execute, false);
      const scope = run.diagnostics.find((item) => item.rule === "native.scope");
      assert.equal(scope?.status, "incomplete");
      assert.match(scope?.message ?? "", /src\/orphan\.rs/);
      const format = run.coverage.find((item) => item.id === "rust.format:.");
      assert.deepEqual(format?.checkedFiles, ["src/main.rs"]);
      assert.equal(format?.status, "incomplete");
    },
  );
});

await test("clippy's denied lint is a violation with its path, line and column, once per finding", async () => {
  await nativeProject(
    "rust",
    { "Cargo.toml": "", "src/main.rs": "fn main() {}\n" },
    async (ctx, project, root) => {
      const finding = {
        reason: "compiler-message",
        message: {
          level: "error",
          message: "unneeded `return` statement",
          code: { code: "clippy::needless_return" },
          spans: [
            { is_primary: false, file_name: "src/other.rs", line_start: 1, column_start: 1 },
            { is_primary: true, file_name: "src/main.rs", line_start: 3, column_start: 5 },
          ],
        },
      };
      const execute: Execute = async (command) => {
        if (command.at(-1) === version) {
          return result(0, "1.0.0");
        }
        if (command.includes("fmt")) {
          return result(0, `Formatting ${join(root, "src/main.rs")}\n`);
        }
        // the same finding arrives once per compiled target
        return result(101, lines(finding, finding, { reason: "build-finished", success: false }));
      };
      const run = await nativeRun(ctx, project, execute, false);
      const found = run.diagnostics.filter((item) => item.rule === "rust.lint");
      assert.equal(found.length, 1);
      assert.equal(found[0].path, "src/main.rs");
      assert.equal(found[0].line, 3);
      assert.equal(found[0].column, 5);
      assert.equal(found[0].message, "clippy::needless_return: unneeded `return` statement");
      assert.equal(run.coverage.find((item) => item.id === "rust.lint:.")?.status, "violation");
      assert.equal(
        run.diagnostics.some((item) => item.status === "incomplete"),
        false,
      );
    },
  );
});

await test("clippy output without build-finished, or with a contradicting status, is incomplete", async () => {
  const finding = {
    reason: "compiler-message",
    message: {
      level: "error",
      message: "boom",
      code: null,
      spans: [{ is_primary: true, file_name: "src/main.rs", line_start: 1, column_start: 1 }],
    },
  };
  for (const [code, stdout] of [
    [101, lines(finding)],
    [0, lines(finding, { reason: "build-finished", success: true })],
  ] as const) {
    await nativeProject(
      "rust",
      { "Cargo.toml": "", "src/main.rs": "" },
      async (ctx, project, root) => {
        const execute: Execute = async (command) => {
          if (command.at(-1) === version) {
            return result(0, "1.0.0");
          }
          if (command.includes("fmt")) {
            return result(0, `Formatting ${join(root, "src/main.rs")}\n`);
          }
          return result(code, stdout);
        };
        const run = await nativeRun(ctx, project, execute, false);
        assert.ok(
          run.diagnostics.some(
            (item) => item.rule === "adapters.protocol" && item.status === "incomplete",
          ),
          `exit ${code}`,
        );
        assert.equal(
          run.coverage.some((item) => item.id === "rust.lint:." && item.status === "pass"),
          false,
        );
      },
    );
  }
});

const rustSteps = (files: string[], root: string): void => {
  nativeSteps({ root, files, config: { projects: [{ root: ".", profile: "rust" }] } });
};

await test("a compiler wrapper or rustc override in a cargo config or manifest is a scope error", () => {
  for (const config of [
    '[build]\nrustc-wrapper = "sccache"\n',
    '[build]\nrustc-workspace-wrapper = "x"\n',
    '[build]\nrustc = "x"\n',
    '[env]\nRUSTC_WRAPPER = "x"\n',
  ]) {
    for (const name of [".cargo/config.toml", ".cargo/config"]) {
      fixture({ "Cargo.toml": "", "src/main.rs": "", [name]: config }, (root, files) => {
        assert.throws(() => rustSteps(files, root), /compiler wrapper/, config);
      });
    }
  }
  fixture({ "Cargo.toml": '[build]\nrustc-wrapper = "x"\n', "src/main.rs": "" }, (root, files) => {
    assert.throws(() => rustSteps(files, root), /Cargo\.toml: a compiler wrapper/);
  });
});

await test("--force-warn in a cargo config's rustflags is a scope error", () => {
  for (const flags of ['["--force-warn", "clippy::all"]', '["--force-warn=clippy::all"]']) {
    fixture(
      {
        "Cargo.toml": "",
        "src/main.rs": "",
        ".cargo/config.toml": `[build]\nrustflags = ${flags}\n`,
      },
      (root, files) => {
        assert.throws(() => rustSteps(files, root), /rustflags that allow or cap/, flags);
      },
    );
  }
});

await test("a TOML escape in a manifest or cargo config is a scope error, never read as a level", () => {
  fixture(
    { "Cargo.toml": '[lints.clippy]\nlen_zero = "\\u0061llow"\n', "src/main.rs": "" },
    (root, files) => {
      assert.throws(() => rustSteps(files, root), /Cargo\.toml: .*escape/);
    },
  );
  fixture(
    {
      "Cargo.toml": "",
      "src/main.rs": "",
      ".cargo/config.toml": '[build]\nrustflags = ["-\\u0041warnings"]\n',
    },
    (root, files) => {
      assert.throws(() => rustSteps(files, root), /\.cargo\/config\.toml: .*escape/);
    },
  );
});

await test("a member of an ancestor workspace is a scope error that names the workspace root", () => {
  fixture(
    {
      "Cargo.toml": '[workspace]\nmembers = ["member"]\n',
      "member/Cargo.toml": "",
      "member/src/lib.rs": "",
    },
    (root, files) => {
      assert.throws(
        () =>
          nativeSteps({ root, files, config: { projects: [{ root: "member", profile: "rust" }] } }),
        /configure the workspace root/,
      );
    },
  );
});

await test("a root package that is also a workspace passes --workspace to clippy and --all to rustfmt", () => {
  fixture(
    {
      "Cargo.toml": '[package]\nname = "root"\n\n[workspace]\nmembers = ["crates/a"]\n',
      "src/main.rs": "",
      "crates/a/Cargo.toml": "",
      "crates/a/src/lib.rs": "",
    },
    (root, files) => {
      const [format, lint] = nativeSteps({
        root,
        files,
        config: { projects: [{ root: ".", profile: "rust" }] },
      });
      assert.deepEqual(format.command.slice(0, 3), ["cargo", "fmt", "--all"]);
      assert.ok(lint.command.includes("--workspace"));
      assert.ok(format.files?.includes("crates/a/src/lib.rs"));
    },
  );
});

await test("a warning-level compiler message is a finding, and exit 0 with one is incomplete", async () => {
  const warning = {
    reason: "compiler-message",
    message: {
      level: "warning",
      message: "unneeded `return` statement",
      code: { code: "clippy::needless_return" },
      spans: [{ is_primary: true, file_name: "src/main.rs", line_start: 2, column_start: 5 }],
    },
  };
  await nativeProject(
    "rust",
    { "Cargo.toml": "", "src/main.rs": "fn main() {}\n" },
    async (ctx, project, root) => {
      const run = (code: number, stdout: string) =>
        nativeRun(
          ctx,
          project,
          async (command) => {
            if (command.at(-1) === version) {
              return result(0, "1.0.0");
            }
            if (command.includes("fmt")) {
              return result(0, `Formatting ${join(root, "src/main.rs")}\n`);
            }
            return result(code, stdout);
          },
          false,
        );
      const found = await run(101, lines(warning, { reason: "build-finished", success: false }));
      assert.equal(found.diagnostics.filter((item) => item.rule === "rust.lint").length, 1);
      assert.equal(found.coverage.find((item) => item.id === "rust.lint:.")?.status, "violation");
      const exited = await run(0, lines(warning, { reason: "build-finished", success: true }));
      assert.ok(
        exited.diagnostics.some(
          (item) => item.rule === "adapters.protocol" && item.status === "incomplete",
        ),
      );
    },
  );
});
