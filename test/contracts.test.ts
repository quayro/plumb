import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkFiles } from "../src/contracts.ts";
import { policy } from "./support.ts";

type Check = (config: Record<string, unknown>) => ReturnType<typeof checkFiles>;

function fixture(contents: Record<string, string>, verify: (check: Check) => void): void {
  const root = mkdtempSync(join(process.cwd(), ".plumb-contract-test-"));
  try {
    for (const [path, content] of Object.entries(contents)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    verify((config) =>
      checkFiles({
        root,
        files: Object.keys(contents),
        config: policy(config),
        read: (path) => readFileSync(join(root, path), "utf8"),
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await test("portable file contracts pass on any language without a package manifest", () => {
  fixture(
    { "src/main.py": "print(1)\n", LICENSE: "license\n", "logo.png": "\0\n\n\n" },
    (check) => {
      assert.deepEqual(
        check({
          preset: "portable",
          files: {
            required: ["LICENSE"],
            forbidden: ["**/*.secret"],
            names: [
              {
                files: ["src/*.py"],
                pattern: "^[a-z]+\\.py$",
                reason: "consistent Python filenames",
              },
            ],
            maxLines: 1,
          },
        }),
        [],
      );
    },
  );
});

await test("required, forbidden, naming, and line budget failures are distinct", () => {
  fixture({ "src/Bad.py": "one\ntwo\n", "token.secret": "secret" }, (check) => {
    const problems = check({
      preset: "portable",
      files: {
        required: ["LICENSE"],
        forbidden: ["**/*.secret"],
        names: [{ files: ["src/*.py"], pattern: "^[a-z]+\\.py$", reason: "consistent filenames" }],
        maxLines: 1,
      },
    });
    assert.deepEqual(problems.map(({ rule }) => rule).sort(), [
      "files.forbidden",
      "files.max-lines",
      "files.names",
      "files.required",
    ]);
    assert.ok(problems.every(({ remedy }) => typeof remedy === "string" && remedy.length));
  });
});

await test("declared naming scopes cannot silently match nothing", () => {
  fixture({ "src/a.py": "pass\n" }, (check) => {
    const [problem] = check({
      preset: "portable",
      files: { names: [{ files: ["typo/*.py"], pattern: ".*", reason: "name Python files" }] },
    });
    assert.equal(problem.rule, "files.scope");
    assert.equal(problem.status, "incomplete");
    assert.equal(problem.suppressible, false);
  });
});

await test("ozmikhail preserves language-specific file and folder conventions", () => {
  fixture(
    {
      "AGENTS.md": "# Agents\n",
      "src/session.integration.test.ts": "",
      "lib/user_store.py": "",
      "src/net/tcp_socket.rs": "",
      ".github/scripts/release-notes.ts": "",
      "ui/button.module.css": "",
    },
    (check) => assert.deepEqual(check({ preset: "ozmikhail" }), []),
  );
  fixture(
    {
      "AGENTS.md": "# Agents\n",
      "src/BadFile.tsx": "",
      "lib/user-store.py": "",
      "net-io/socket.rs": "",
    },
    (check) => {
      assert.equal(
        check({ preset: "ozmikhail" }).filter(({ rule }) => rule === "files.names").length,
        3,
      );
    },
  );
});
