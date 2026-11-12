import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { at, isArray } from "../src/schema.ts";

// run the same CLI contract against an unpacked Node entry or an isolated binary.
interface SmokeOptions {
  temporaryRoot?: string;
  copyExecutable?: boolean;
  expectedIdentity?: string;
}

export function smoke(
  entry: readonly string[],
  {
    temporaryRoot = process.env.PLUMB_TEST_TMP ?? tmpdir(),
    copyExecutable = false,
    expectedIdentity,
  }: SmokeOptions = {},
): { status: string; checker: unknown } {
  let command = [...entry];
  mkdirSync(temporaryRoot, { recursive: true });
  const temporary = mkdtempSync(join(temporaryRoot, "plumb-smoke-"));
  try {
    if (copyExecutable) {
      const [binary = ""] = command;
      const executable = join(temporary, basename(binary));
      copyFileSync(binary, executable);
      chmodSync(executable, 0o755);
      command = [executable, ...command.slice(1)];
    }
    const root = join(temporary, "project");
    mkdirSync(root);
    const dotenvKey = `PLUMB_SMOKE_${randomUUID().replaceAll("-", "_")}`;
    writeFileSync(join(temporary, ".env"), `${dotenvKey}=unexpected\n`);
    writeFileSync(join(temporary, "bunfig.toml"), 'preload = ["./preload.mjs"]\n');
    writeFileSync(
      join(temporary, "preload.mjs"),
      'process.stderr.write("Unexpected bunfig preload\\n"); process.exit(83);\n',
    );
    const invoke = (args: readonly string[], code: number): string => {
      const result = spawnSync(command[0] ?? "", [...command.slice(1), ...args], {
        cwd: temporary,
        encoding: "utf8",
      });
      assert.ifError(result.error);
      assert.equal(result.status, code, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const run = (args: readonly string[], code = 0): unknown => {
      const value: unknown = JSON.parse(
        invoke([...args, "--root", root, "--format", "json"], code),
      );
      return value;
    };
    const policyPath = join(root, "plumb.json");
    const setPolicy = (value: Record<string, unknown>): void =>
      writeFileSync(
        policyPath,
        `${JSON.stringify({ schemaVersion: 1, preset: "portable", projects: [], ...value })}\n`,
      );
    assert.equal(at(run(["init", "--preset", "portable"]), "status"), "pass");
    assert.equal(existsSync(join(root, "package.json")), false);
    const checked = run(["check"]);
    assert.equal(at(checked, "status"), "pass");
    assert.match(String(at(checked, "identity", "checker", "sha256")), /^[a-f0-9]{64}$/);
    if (expectedIdentity) {
      assert.equal(at(checked, "identity", "checker", "sha256"), expectedIdentity);
    }
    setPolicy({
      projects: [
        {
          root: ".",
          profile: "python",
          prepare: [
            [
              process.execPath,
              "-e",
              "process.exit(Object.hasOwn(process.env, process.argv[1]) ? 83 : 0)",
              dotenvKey,
            ],
          ],
        },
      ],
    });
    assert.equal(at(run(["prepare"]), "status"), "pass");
    setPolicy({ files: { required: ["required.txt"] } });
    assert.equal(at(run(["check"], 1), "status"), "violation");
    writeFileSync(join(root, "required.txt"), "present\n");
    assert.equal(at(run(["check"]), "status"), "pass");
    setPolicy({ unknownOption: true });
    assert.equal(at(run(["check"], 2), "status"), "incomplete");
    for (const name of ["py", "crate"]) {
      mkdirSync(join(root, name));
    }
    setPolicy({
      projects: [
        { root: "py", profile: "python" },
        { root: "crate", profile: "rust" },
      ],
    });
    assert.equal(at(run(["sync"]), "status"), "pass");
    assert.match(readFileSync(join(root, "py/ruff.toml"), "utf8"), /select = \["ALL"\]/);
    assert.match(readFileSync(join(root, "py/mypy.ini"), "utf8"), /strict = True/);
    assert.match(readFileSync(join(root, "crate/rustfmt.toml"), "utf8"), /max_width = 100/);
    assert.deepEqual(at(run(["sync"]), "written"), []);
    setPolicy({ projects: [{ root: ".", profile: "typescript" }] });
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
    assert.equal(at(run(["sync"]), "status"), "pass");
    const missingPack = run(["check"], 2);
    assert.equal(at(missingPack, "status"), "incomplete");
    const reported = at(missingPack, "diagnostics");
    assert.ok(
      isArray(reported) &&
        reported.some((item) => /@quayro\/plumb-javascript/.test(String(at(item, "message")))),
    );
    return { status: "pass", checker: at(checked, "identity", "checker") };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("Usage: node scripts/smoke.ts PATH_TO_STANDALONE_BINARY");
    }
    process.stdout.write(
      `${JSON.stringify(smoke([resolve(process.argv[2] ?? "")], { copyExecutable: true }))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
