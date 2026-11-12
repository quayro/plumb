import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { loadAdapterRegistry } from "../../../src/adapter-registry.ts";
import { respond } from "../../sdk/adapter.ts";
import { definition, tokenize } from "../adapter.ts";

const script = fileURLToPath(new URL("../adapter.ts", import.meta.url));

const FORBIDDEN = {
  forbiddenImports: [{ path: "std::process", reason: "Use the reviewed runner" }],
};

function folder(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function check(t: TestContext, files: Record<string, string>, options: unknown = FORBIDDEN) {
  const root = folder(t, "plumb-rust-");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const response = respond(definition, {
    schemaVersion: 1,
    action: "check",
    adapter: "rust",
    version: definition.version,
    root,
    project: { root: ".", profile: "rust", options },
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

// one file per source, so every source is judged on its own
function judge(t: TestContext, sources: string[], options: unknown = FORBIDDEN) {
  return sources.map((source) => check(t, { "a.rs": source }, options).found);
}

await test("comments, literals and lifetimes are whole tokens", () => {
  const kinds = (source: string) => tokenize(source).map((token) => [token.kind, token.text]);
  assert.deepEqual(kinds('a // b\n"c"'), [
    ["word", "a"],
    ["comment", "// b"],
    ["literal", '"c"'],
  ]);
  assert.deepEqual(kinds("/* a /* b */ c */ x"), [
    ["comment", "/* a /* b */ c */"],
    ["word", "x"],
  ]);
  assert.deepEqual(kinds('r#"a"b"# br##"x"#"## c"d" b\'e\' \'\\\'\' \'f\''), [
    ["literal", 'r#"a"b"#'],
    ["literal", 'br##"x"#"##'],
    ["literal", 'c"d"'],
    ["literal", "b'e'"],
    ["literal", "'\\''"],
    ["literal", "'f'"],
  ]);
  assert.deepEqual(kinds("&'static str 'outer: loop {} r#type"), [
    ["mark", "&"],
    ["lifetime", "'static"],
    ["word", "str"],
    ["lifetime", "'outer"],
    ["mark", ":"],
    ["word", "loop"],
    ["mark", "{"],
    ["mark", "}"],
    ["word", "r#type"],
  ]);
  assert.deepEqual(
    tokenize('a // b\n"c"').map((token) => [token.line, token.column]),
    [
      [1, 1],
      [1, 3],
      [2, 1],
    ],
  );
});

await test("an unterminated literal or comment throws, so it is never read as code", () => {
  for (const source of ['"open', "/* /* nested */", 'r##"x"#', "'", "b'\\"]) {
    assert.throws(() => tokenize(source), Error, source);
  }
  assert.deepEqual(
    tokenize("#!/usr/bin/env run\n#![allow(x)]").map((token) => token.kind),
    ["comment", "mark", "mark", "mark", "word", "mark", "word", "mark", "mark"],
  );
});

await test("every way of writing a suppression attribute is refused", (t) => {
  const sources = [
    "#[allow(dead_code)]\nfn a() {}\n",
    "#![allow(unused)]\n",
    "#[expect(dead_code)]\nfn a() {}\n",
    "#[rustfmt::skip]\nfn a() {}\n",
    "#[rustfmt::skip::custom]\nfn a() {}\n",
    "#[cfg_attr(test, allow(dead_code))]\nfn a() {}\n",
    "#[cfg_attr(all(unix, not(test)), expect(unused))]\nfn a() {}\n",
    "#[cfg_attr(debug_assertions, rustfmt::skip)]\nfn a() {}\n",
    "#[cfg_attr(a, cfg_attr(b, allow(x)))]\nfn a() {}\n",
    "#![cfg_attr(test, allow(unused))]\n",
    "#[allow(clippy::too_many_arguments)]\nfn a() {}\n",
    // the equivalent rewrites: spacing, comments and line breaks between tokens
    "# [ allow ( dead_code ) ]\nfn a() {}\n",
    "#/* hidden */[allow(dead_code)]\nfn a() {}\n",
    "#[ /* c */ allow // c\n (dead_code)]\nfn a() {}\n",
    "#![\n  expect(\n    unused\n  )\n]\n",
  ];
  assert.deepEqual(
    judge(t, sources),
    sources.map(() => [["a.rs", "rust/directive", "violation"]]),
  );
});

await test("ordinary attributes and suppression text in strings or comments pass", (t) => {
  const { response } = check(t, {
    "a.rs":
      "#[derive(Debug)]\n#[cfg(test)]\n#[must_use]\n#[cfg_attr(test, derive(Debug))]\n#[warn(dead_code)]\nstruct A;\n" +
      'let s = "#[allow(dead_code)]";\n// #[allow(dead_code)]\n/* #[allow(x)] /* nested #[expect(y)] */ */\n' +
      'let r = r#"#[rustfmt::skip]"#;\nlet b = b"#[allow(a)]";\n',
  });
  assert.deepEqual(response.diagnostics, []);
  assert.equal(response.status, "pass");
});

await test("an attribute a macro expands into, or an unclosed one, is incomplete", (t) => {
  const { found } = check(t, {
    "macro.rs": "macro_rules! m { ($a:meta) => { #[$a] fn f() {} } }\n",
    "matcher.rs": "macro_rules! m { ($(#[$a:meta])*) => {} }\n",
  });
  assert.deepEqual(found, [
    ["macro.rs", "rust/directive", "incomplete"],
    ["macro.rs", "rust/skip", "incomplete"],
  ]);
  const { response } = check(t, {
    "open.rs": "#[allow(dead_code)\nfn a() {}\n",
  });
  assert.equal(response.status, "incomplete");
  assert.deepEqual(
    response.diagnostics.map((item) => [item.rule, item.status]),
    [["rust/input", "incomplete"]],
  );
});

await test("ignored tests and always-false cfg gates are refused in any file", (t) => {
  const sources = [
    "#[ignore]\n#[test]\nfn a() {}\n",
    '#[ignore = "slow"]\n#[test]\nfn a() {}\n',
    '#[cfg_attr(feature = "x", ignore)]\n#[test]\nfn a() {}\n',
    '#[cfg_attr(all(), ignore = "slow")]\nfn a() {}\n',
    "#[cfg(any())]\nfn a() {}\n",
    "#[cfg(not(all()))]\nfn a() {}\n",
    "#[cfg(false)]\nfn a() {}\n",
    "#[cfg(all(false, test))]\nfn a() {}\n",
    "#![cfg(any())]\n",
    // the rewrites: spacing and comments inside the attribute
    "# [ ignore ]\n#[test]\nfn a() {}\n",
    "#[ignore/* why */]\n#[test]\nfn a() {}\n",
  ];
  assert.deepEqual(
    judge(t, sources),
    sources.map(() => [["a.rs", "rust/skip", "violation"]]),
  );
});

await test("gates that tokens do not decide, and ignored text, do not fire", (t) => {
  const { response } = check(t, {
    "a.rs":
      "#[cfg(all())]\nfn a() {}\n#[cfg(any(test))]\nfn b() {}\n#[cfg(test)]\nfn c() {}\n" +
      "#[cfg(not(any()))]\nfn d() {}\n#[cfg_attr(test, cfg(any()))]\nfn e() {}\n" +
      'let s = "#[ignore]";\n// #[cfg(any())]\n/* #[ignore] */\nlet r = r#"#[ignore]"#;\n',
  });
  assert.deepEqual(response.diagnostics, []);
  assert.equal(response.status, "pass");
});

await test("every way of writing an import of the forbidden path reaches the boundary", (t) => {
  const sources: Record<string, string> = {
    "single.rs": "use std::process;\n",
    "leaf.rs": "use std::process::Command;\n",
    "tree.rs": "use std::{fs, process::{self, Command}};\n",
    "glob.rs": "use std::process::*;\n",
    "rename.rs": "use std::process as p;\n",
    "pub.rs": "pub use std::process::Command;\n",
    "leading.rs": "use ::std::process::Command;\n",
    "renamed-leaf.rs": "use std::process::Command as Cmd;\nfn f() { Cmd::new(); }\n",
    "extern.rs": "extern crate std as s;\nuse s::process::Command;\n",
    "core.rs": "use core::process;\n",
    "raw.rs": "use std::{r#process};\n",
  };
  const { found } = check(t, sources);
  // diagnostics follow the order the files were requested in
  assert.deepEqual(found, [
    ["single.rs", "rust/import", "violation"],
    ["leaf.rs", "rust/import", "violation"],
    ["tree.rs", "rust/import", "violation"],
    ["tree.rs", "rust/import", "violation"],
    ["glob.rs", "rust/import", "violation"],
    ["rename.rs", "rust/import", "violation"],
    ["pub.rs", "rust/import", "violation"],
    ["leading.rs", "rust/import", "violation"],
    ["renamed-leaf.rs", "rust/import", "violation"],
    ["renamed-leaf.rs", "rust/import", "violation"],
    ["extern.rs", "rust/import", "violation"],
    ["core.rs", "rust/import", "violation"],
    ["raw.rs", "rust/import", "violation"],
  ]);
  const { response } = check(t, {
    "line.rs": "fn f() {}\nuse std::process::Command;\n",
  });
  assert.deepEqual([response.diagnostics[0]?.line, response.diagnostics[0]?.column], [2, 19]);
});

await test("every inline path to the forbidden path is refused, however it is written", (t) => {
  const sources = [
    'fn f() { std::process::Command::new("x"); }\n',
    'fn f() { ::std::process::Command::new("x"); }\n',
    "fn f(o: std::process::Output) {}\n",
    "fn f() { std /* c */ :: process :: id(); }\n",
    "fn f() { r#std::process::id(); }\n",
    "fn f() { let x = 0..std::process::id(); }\n",
    "use std as s;\nfn f() { s::process::id(); }\n",
    "use std::process as p;\nfn f() { p::id(); }\n",
    'use std::process::Command;\nfn f() { Command::new("x"); }\n',
  ];
  assert.deepEqual(
    judge(t, sources).map((found) => found.map((item) => item[1])),
    [
      ["rust/import"],
      ["rust/import"],
      ["rust/import"],
      ["rust/import"],
      ["rust/import"],
      ["rust/import"],
      ["rust/import"],
      ["rust/import", "rust/import"],
      ["rust/import", "rust/import"],
    ],
  );
});

await test("paths that only share a name with the forbidden path are not refused", (t) => {
  const { response } = check(t, {
    "a.rs":
      "use std::fs;\nuse std::io::{self, Write};\nuse std::collections::*;\n" +
      'mod process { pub fn run() {} }\nfn f() { process::run(); std::fs::read("x"); }\n' +
      "fn g(process: u8) -> u8 { self::process + crate::process }\nstruct process_list { x: u8 }\n",
  });
  assert.deepEqual(response.diagnostics, []);
  assert.equal(response.status, "pass");
});

await test("text inside strings, comments and raw strings is never an import", (t) => {
  const { response } = check(t, {
    "a.rs":
      'let s = "use std::process::Command; std::process::Command::new()";\n' +
      "// use std::process;\n/* use std::process; /* nested */ std::process::id() */\n" +
      'let r = r#"use std::process::Command; std::process::id()"#;\n' +
      'let b = br##"std::process"##; let c = c"std::process"; let e = b"\\"std::process\\"";\n' +
      "let q = '\"'; let t: &'static str = \"x\"; fn f<'a>(x: &'a u8) {}\n",
  });
  assert.deepEqual(response.diagnostics, []);
  assert.equal(response.status, "pass");
});

await test("a glob or a macro that a check cannot resolve is incomplete, never a pass", (t) => {
  const sources = [
    "use std::*;\n",
    "use super::*;\n",
    "use crate::prelude::*;\n",
    "macro_rules! m { ($p:path) => { $p::new() } }\n",
    "paste! { fn [<run_ x>]() {} }\n",
    'include!("generated.rs");\n',
  ];
  assert.deepEqual(
    judge(t, sources).map((found) => found.map((item) => [item[1], item[2]])),
    [
      [["rust/import", "incomplete"]],
      [["rust/import", "incomplete"]],
      [["rust/import", "incomplete"]],
      [["rust/import", "incomplete"]],
      [["rust/import", "incomplete"]],
      [["rust/import", "incomplete"]],
    ],
  );
  // a use tree the reader cannot parse, such as one built from a macro variable, is unreadable input
  const { response } = check(t, {
    "a.rs": "macro_rules! m { ($p:path) => { use $p; } }\n",
  });
  assert.equal(response.status, "incomplete");
  assert.deepEqual(
    response.diagnostics.map((item) => [item.rule, item.status]),
    [["rust/input", "incomplete"]],
  );
});

await test("a glob of a path with no forbidden item passes and no options means no import check", (t) => {
  assert.deepEqual(judge(t, ["use std::collections::*;\nuse std::io::*;\n"]).flat(), []);
  assert.deepEqual(judge(t, ["use std::process;\nuse super::*;\n"], {}).flat(), []);
});

await test("the printed manifest loads as a registry and declares every rule", (t) => {
  // the registry must sit outside the checkout it is loaded for
  const root = folder(t, "plumb-rust-root-"),
    tools = folder(t, "plumb-rust-tools-"),
    registry = join(tools, "registry.json");
  const printed = spawnSync(process.execPath, [script, "--manifest"], {
    encoding: "utf8",
  });
  assert.equal(printed.status, 0, printed.stderr);
  writeFileSync(registry, printed.stdout);
  const loaded = loadAdapterRegistry(registry, root);
  assert.deepEqual(
    loaded?.adapters.map((adapter) => [
      adapter.id,
      adapter.files,
      adapter.capabilities,
      adapter.rules.map((rule) => rule.id),
    ]),
    [
      [
        "rust",
        ["**/*.rs"],
        ["policy"],
        ["rust/input", "rust/protocol", "rust/directive", "rust/import", "rust/skip"],
      ],
    ],
  );
});
