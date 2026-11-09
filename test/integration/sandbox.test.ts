import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../../src/process.ts";
import { sandboxed } from "../../src/sandbox.ts";

// this suite never skips: the platform's sandbox tool must be installed, as the native tools are
await test("the real sandbox lets a command read a checkout and refuses writes and the network", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plumb-sandbox-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.txt"), "checked\n");
  const server = createServer((socket) => socket.end("reached"));
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  t.after(() => server.close());
  const address = server.address(),
    port = typeof address === "object" && address ? address.port : 0;
  const script = `
    const fs = require("node:fs"), net = require("node:net");
    const result = { read: fs.readFileSync("source.txt", "utf8"), wrote: true, connected: false };
    try { fs.writeFileSync("written.txt", "x"); } catch { result.wrote = false; }
    const socket = net.connect(${port}, "127.0.0.1");
    const finish = () => { console.log(JSON.stringify(result)); process.exit(0); };
    socket.on("data", () => { result.connected = true; finish(); });
    socket.on("error", finish);
    setTimeout(finish, 3000);`;
  const direct = await run([process.execPath, "-e", script], { cwd: root });
  // without the sandbox the same command writes and connects, so the test proves the difference
  assert.deepEqual(JSON.parse(direct.stdout), { read: "checked\n", wrote: true, connected: true });
  rmSync(join(root, "written.txt"));
  const confined = await run(sandboxed([process.execPath, "-e", script]), { cwd: root });
  assert.equal(confined.code, 0, confined.stderr);
  assert.deepEqual(JSON.parse(confined.stdout), {
    read: "checked\n",
    wrote: false,
    connected: false,
  });
  assert.equal(existsSync(join(root, "written.txt")), false);
});
