import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fileHash } from "../src/adapter-registry.ts";
import { run } from "../src/process.ts";
import { sandboxed } from "../src/sandbox.ts";
import { at } from "../src/schema.ts";
import { cli, roots, temporary } from "./ratchet-support.ts";
import { mapped, parseReport } from "./support.ts";

const go = fileURLToPath(new URL("../packages/go/adapter.ts", import.meta.url));

function tools(): string {
  const folder = mkdtempSync(join(temporary, "plumb-conformance-tools-"));
  roots.push(folder);
  return folder;
}

// an adapter that trusts every request: it passes whatever it is sent and leaves a file behind
const LAX = `const fs = require("node:fs");
let request = {};
try { request = JSON.parse(fs.readFileSync(0, "utf8")); } catch {}
try { fs.writeFileSync("left-behind", "x"); } catch {}
const files = (request.files ?? []).map((file) => file.path);
process.stdout.write(JSON.stringify({ schemaVersion: 1, adapter: "lax", version: "1.0.0",
  status: "pass", diagnostics: [], coverage: [{ capability: "policy", files }],
  inputs: request.files ?? [] }));
`;

function lax(sandbox: boolean): string {
  const folder = tools(),
    script = join(realpathSync(folder), "lax.cjs"),
    node = realpathSync(process.execPath),
    registry = join(folder, "registry.json");
  writeFileSync(script, LAX);
  writeFileSync(
    registry,
    JSON.stringify({
      schemaVersion: 1,
      adapters: [
        {
          id: "lax",
          version: "1.0.0",
          files: ["**/*.lax"],
          capabilities: ["policy"],
          command: [node, script],
          integrity: [node, script].map((path) => ({ path, sha256: fileHash(path) })),
          rules: [{ id: "lax/any", description: "Anything.", remedy: "Nothing." }],
          sandbox,
        },
      ],
    }),
  );
  return registry;
}

const failed = (text: string): unknown[] =>
  mapped(at(parseReport(text).adapters, 0, "probes"), (probe) =>
    at(probe, "passed") === false ? at(probe, "name") : undefined,
  ).filter(Boolean);

await test("a conforming adapter passes every probe", async () => {
  const registry = join(tools(), "registry.json");
  writeFileSync(registry, spawnSync(process.execPath, [go, "--manifest"]).stdout);
  const { code, text } = await cli(["conformance", "--adapters", registry]);
  assert.equal(code, 0, text);
  assert.deepEqual(
    mapped(at(parseReport(text).adapters, 0, "probes"), (probe) => [
      at(probe, "name"),
      at(probe, "passed"),
    ]),
    ["doctor", "check", "stale-hash", "foreign-version", "malformed", "read-only"].map((name) => [
      name,
      true,
    ]),
  );
});

await test("an adapter that trusts its request fails the probes it should refuse", async () => {
  const { code, text } = await cli(["conformance", "--adapters", lax(false)]);
  assert.equal(code, 1);
  assert.deepEqual(failed(text), [
    "doctor",
    "stale-hash",
    "foreign-version",
    "malformed",
    "read-only",
  ]);
  assert.ok(parseReport(text).diagnostics.every((item) => item.rule === "adapters.conformance"));
  // a registry is required, and one that cannot be read is incomplete
  assert.equal((await cli(["conformance"])).code, 2);
  assert.equal((await cli(["conformance", "--adapters", join(tools(), "none.json")])).code, 2);
});

await test("the sandbox wraps a command for each platform and refuses where it cannot", () => {
  const command = ["/bin/tool", "--flag"];
  assert.deepEqual(sandboxed(command, "darwin", () => true).slice(0, 2), [
    "/usr/bin/sandbox-exec",
    "-p",
  ]);
  const linux = sandboxed(command, "linux", (path) => path === "/bin/bwrap");
  assert.equal(linux[0], "/bin/bwrap");
  assert.ok(linux.includes("--unshare-net") && linux.includes("--ro-bind"));
  assert.deepEqual(linux.slice(-2), command);
  for (const [platform, exists] of [
    ["win32", true],
    ["linux", false],
    ["darwin", false],
  ] as const) {
    assert.throws(() => sandboxed(command, platform, () => exists), /No sandbox is available/);
  }
});

await test("a sandboxed adapter can read the checkout but cannot write to it", async () => {
  // only macOS ships its sandbox tool everywhere; elsewhere the wrapper is covered above
  if (process.platform !== "darwin") {
    assert.throws(() => sandboxed(["x"], "win32"), /No sandbox/);
    return;
  }
  const folder = realpathSync(tools()),
    target = join(folder, "written"),
    script = `const fs = require("node:fs"); let wrote = true;
      try { fs.writeFileSync(${JSON.stringify(target)}, "x"); } catch { wrote = false; }
      console.log(JSON.stringify({ wrote, read: fs.readFileSync(${JSON.stringify(go)}).length > 0 }));`;
  const result = await run(sandboxed([process.execPath, "-e", script]), { cwd: folder });
  assert.deepEqual(JSON.parse(result.stdout), { wrote: false, read: true });
  assert.equal(existsSync(target), false);
  // the same lax adapter, sandboxed by its registry entry, can no longer leave a file behind
  const { text } = await cli(["conformance", "--adapters", lax(true)]);
  assert.deepEqual(failed(text), ["doctor", "stale-hash", "foreign-version", "malformed"]);
});
