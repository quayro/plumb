import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { contractAssert, folder } from "../../packages/sdk/test/support.ts";

const sdk = fileURLToPath(new URL("../../packages/sdk/adapter.rs", import.meta.url));

const TOY = `#[path = ${JSON.stringify(sdk)}]
mod adapter;

use adapter::{Adapter, Finding, Json, Rule};

fn check(_path: &str, text: &str, _options: &Json) -> Result<Vec<Finding>, String> {
    if text.contains("crash") {
        return Err("parser gave up".into());
    }
    let rule = if text.contains("stray") {
        "undeclared"
    } else if text.contains("bad") {
        "word"
    } else {
        return Ok(Vec::new());
    };
    Ok(vec![Finding { rule, message: "bad word".into(), line: Some(1), column: Some(1), ..Finding::default() }])
}

fn main() -> std::process::ExitCode {
    adapter::serve(&Adapter {
        id: "toy",
        version: "2.0.0",
        files: &["**/*.toy"],
        capabilities: &["policy"],
        rules: &[Rule { id: "word", description: "No bad words.", remedy: "Remove the word.", ..Rule::default() }],
        options_schema: None,
        check,
    })
}
`;

// this suite never skips: the Rust SDK is proved by compiling an adapter on it
await test("the Rust SDK keeps the adapter contract from request to registry", async (t) => {
  const tools = realpathSync(folder(t, "plumb-sdk-rust-")),
    binary = join(tools, "toy");
  writeFileSync(join(tools, "main.rs"), TOY);
  const built = spawnSync(
    "rustc",
    ["--edition", "2021", "-D", "warnings", "-o", binary, join(tools, "main.rs")],
    { encoding: "utf8" },
  );
  assert.equal(
    built.error,
    undefined,
    `Native integration prerequisites unavailable: ${built.error?.message}. Install a Rust toolchain. This suite never skips missing tools.`,
  );
  assert.equal(built.status, 0, built.stderr);
  await contractAssert(t, [binary]);
});
