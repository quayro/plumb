import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { build, type BuildRun, BUN_VERSION, prepareBuild } from "../scripts/build.ts";
import { smoke } from "../scripts/smoke.ts";

function fixture(verify: (root: string) => void): void {
  const temporary = process.env.PLUMB_TEST_TMP ?? tmpdir();
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, "plumb-build-test-"));
  try {
    verify(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await test("Node staging smoke verifies isolated CLI and embedded assets, without compiling Bun", () => {
  fixture((root: string) => {
    const staged = prepareBuild(join(root, "stage"));
    assert.equal(existsSync(join(root, "stage/src/assets")), false);
    assert.equal(existsSync(join(root, "stage/node_modules")), false);
    assert.equal(
      smoke([process.execPath, staged.entry], {
        temporaryRoot: root,
        expectedIdentity: staged.identity,
      }).status,
      "pass",
    );
  });
});

await test("staging refuses to overwrite existing files", () => {
  fixture((root: string) => {
    writeFileSync(join(root, "keep.txt"), "existing\n");
    assert.throws(() => prepareBuild(root), /must be empty/);
    assert.deepEqual(readdirSync(root), ["keep.txt"]);
    assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "existing\n");
  });
});

await test("simulated compiler dispatch publishes target names only after success and cleans staging", () => {
  fixture((root: string) => {
    for (const [target, name] of [
      ["bun-linux-x64", "plumb-linux-x64"],
      ["bun-windows-x64", "plumb-windows-x64.exe"],
    ]) {
      const outputDirectory = join(root, target);
      const run: BuildRun = (command, args, options) => {
        assert.equal(command, "bun");
        if (args[0] === "--version") {
          return { status: 0, stdout: `${BUN_VERSION}\n` };
        }
        assert.deepEqual(args.slice(0, 7), [
          "build",
          "--compile",
          `--target=${target}`,
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "entry.mjs",
          "--outfile",
        ]);
        assert.equal(args[7].endsWith(".exe"), target.includes("windows"));
        assert.equal(existsSync(join(options.cwd ?? "", "entry.mjs")), true);
        assert.equal(existsSync(join(outputDirectory, name)), false);
        writeFileSync(args[7], "simulated executable\n");
        return { status: 0 };
      };
      assert.equal(
        build(target, { run, outputDirectory: relative(process.cwd(), outputDirectory) }),
        join(outputDirectory, name),
      );
      assert.deepEqual(readdirSync(outputDirectory), [name]);
      assert.equal(readFileSync(join(outputDirectory, name), "utf8"), "simulated executable\n");
    }
  });
});

await test("unsupported targets and absent or wrong Bun versions refuse before staging", () => {
  fixture((root: string) => {
    const outputDirectory = join(root, "dist");
    assert.throws(
      () =>
        build("bun-unknown", {
          outputDirectory,
          run: () => assert.fail("must not start compiler"),
        }),
      /Target must be/,
    );
    for (const version of [
      { error: new Error("missing") },
      { status: 1, stdout: BUN_VERSION },
      { status: 0, stdout: "0.0.0\n" },
    ]) {
      assert.throws(
        () => build("bun-linux-x64", { outputDirectory, run: () => version }),
        /require Bun/,
      );
    }
    assert.equal(existsSync(outputDirectory), false);
  });
});

await test("failed simulated compilation keeps the prior artifact and removes partial output", () => {
  fixture((root: string) => {
    const output = join(root, "plumb-linux-x64");
    writeFileSync(output, "prior build\n");
    for (const failure of [
      { status: 1 },
      { error: new Error("compiler unavailable") },
      { status: 0 },
    ]) {
      const run: BuildRun = (_, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: BUN_VERSION };
        }
        if (failure.status !== 0) {
          writeFileSync(args[7], "partial output\n");
        }
        return failure;
      };
      assert.throws(() => build("bun-linux-x64", { run, outputDirectory: root }));
      assert.deepEqual(readdirSync(root), ["plumb-linux-x64"]);
      assert.equal(readFileSync(output, "utf8"), "prior build\n");
    }
  });
});
