import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2] ?? "all";

if (!["all", "core", "javascript", "unit", "native", "python", "adapters"].includes(mode)) {
  throw new Error("Test suite is all, core, javascript, unit, native, python, or adapters");
}

// all runs every suite that needs no native toolchain; native runs in its own CI job
if (mode === "all") {
  for (const suite of ["core", "javascript", "python", "adapters"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), suite], {
      stdio: "inherit",
    });
    if (child.status !== 0) {
      process.exitCode = child.status ?? 2;
      break;
    }
  }
} else {
  const folders =
    mode === "core"
      ? ["test"]
      : mode === "native"
        ? ["test/integration"]
        : mode === "python"
          ? ["packages/python/test"]
          : mode === "adapters"
            ? ["packages/sdk/test", "packages/rust/test"]
            : ["packages/javascript/test"];
  const files = folders.flatMap((folder) =>
    readdirSync(join(root, folder))
      .filter(
        (file) => file.endsWith(".test.ts") && (mode !== "unit" || file === "lint-unit.test.ts"),
      )
      .map((file) => join(root, folder, file)),
  );
  const temporary = process.env.PLUMB_TEST_TMP ?? resolve(root, "../.plumb-tests");
  mkdirSync(temporary, { recursive: true });
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: root,
    env: { ...process.env, PLUMB_TEST_TMP: temporary },
    stdio: "inherit",
  });
  process.exitCode = result.error ? 2 : (result.status ?? 2);
}
