import assert from "node:assert/strict";
import test from "node:test";

import { checkComments, commentsFind, commentsLanguageOf } from "../src/comments.ts";
import { policy } from "./support.ts";

const problems = (path: string, source: string): ReturnType<typeof commentsFind> =>
  commentsFind(source, commentsLanguageOf(path) ?? "");

await test("non-script comment wording, code, separators and tool directives retain policy", () => {
  const failures = [
    ["schema.prisma", "// field String\n"],
    ["schema.sql", "-- SELECT * FROM records;\n"],
    ["config.jsonc", '// "disabled": true,\n'],
    ["compose.yml", "# ======\n"],
    [".env.example", "#\n"],
    ["Dockerfile", "# ---- build ----\n"],
    ["theme.css", "/* color: blue; */\n"],
    ["thing.py", "# Keep it short\n"],
    ["thing.rs", "// let total = 1;\n"],
  ];
  for (const [path, text] of failures) {
    assert.equal(problems(path, text).length, 1, path);
  }
  assert.deepEqual(problems("thing.rs", "// Example: let x = 1;\n// TOTP stays verified\n"), []);
  assert.deepEqual(problems("thing.py", "# -*- coding: utf-8 -*-\n"), []);
});

await test("removed languages have no comment scanner, so their files are never governed", () => {
  for (const path of ["app.rb", "Gemfile", "main.cpp", "main.h", ".clang-format"]) {
    assert.equal(commentsLanguageOf(path), undefined, path);
  }
  assert.deepEqual(
    checkComments({
      root: ".",
      files: ["app.rb", "main.cpp"],
      config: policy({ preset: "portable" }),
      read: () => "# NOLINT\n// TODO: later\n",
    }),
    [],
  );
});

await test("CSS single-quoted strings and URLs contain data rather than comments", () => {
  assert.deepEqual(
    problems(
      "theme.css",
      "a { content: '/* Capital */'; background: url(https://example.test/a/*b); }\n/* keep the tokens together */\n",
    ),
    [],
  );
  assert.deepEqual(
    problems("theme.css", "a { content: '/* Capital */'; }\n/* Capital */\n").map(
      ({ line, code }) => [line, code],
    ),
    [[2, "capital"]],
  );
});

await test("Python strings, bytes, and docstrings hide comment markers; real comments are found", () => {
  assert.deepEqual(
    problems("tool.py", "# Capital\nx = 1  #Comment\n").map(({ line, code }) => [line, code]),
    [
      [1, "capital"],
      [2, "spacing"],
      [2, "capital"],
    ],
  );
  assert.deepEqual(
    problems("tool.py", "#!/usr/bin/env python3\n# Capital\n").map(({ line }) => line),
    [2],
  );
  for (const source of [
    "x = '# Capital'\ny = \"# Capital\"\n",
    'def f():\n    """# Capital in a docstring"""\n    return 1\n',
    "s = '''\n# Capital\n'''\n",
    'value = """line one\n# Capital\nline three"""\n',
    'a = r"# Capital"; b = b\'# Capital\'; c = rb"""# Capital"""\n',
    'd = Rb"# Capital"; e = fR"# Capital"; f = u"# Capital"; g = t"# Capital"\n',
    's = "a \\" # Capital"\n',
    'r = r"\\" # Capital"\n',
    "value = 'it\\'s # not a comment'\n",
  ]) {
    assert.deepEqual(problems("tool.py", source), [], source);
  }
  assert.deepEqual(
    problems("tool.py", "x = 1\n# keep the remainder\n").map(({ code }) => code),
    [],
  );
});

await test("Python f-strings: literal # and nested fields are data; a # in a field expression is incomplete", () => {
  const fstrings = [
    'a = f"{x} # Capital"',
    'b = f"{x:#x}"',
    "c = f\"{d['#']}\"",
    'd = f"{{# Capital}}"',
    "e = f\"{f'#{x}'}\"",
    'g = f"{x!r:>{width}}"',
    's = f"\\N{DASH} # Capital"',
  ].join("\n");
  assert.deepEqual(problems("tool.py", `${fstrings}\n`), []);
  for (const source of ['f"{x # c}"\n', 'f"{x"\n']) {
    assert.ok(
      problems("tool.py", source).some(({ status }) => status === "incomplete"),
      source,
    );
  }
  assert.deepEqual(
    problems("tool.py", 'x = f"""\n{y}\n"""  # Capital\n').map(({ line, code }) => [line, code]),
    [[3, "capital"]],
  );
});

await test("Python task markers and suppressions: markers inside strings are data, odd-spaced directives still fire", () => {
  assert.deepEqual(
    problems("a.py", "# TODO: fix\n").map(({ code }) => code),
    ["task"],
  );
  for (const source of [
    'x = "TODO: later"\n',
    'x = "TO" "DO: later"\n',
    '"""TODO: docstring"""\n',
    "x = '# type: ignore'\n",
  ]) {
    assert.deepEqual(problems("a.py", source), [], source);
  }
  for (const source of [
    "x = 1  # type: ignore\n",
    "x = 1  #type:ignore\n",
    "x = 1  # TYPE :  IGNORE[attr-defined]\n",
    "x = 1  # Type:Ignore\n",
    "x = 1  # noqa: E501\n",
    "x = 1  # NOQA\n",
    "# ruff: noqa\n",
    "# fmt: off\n",
    "# fmt:skip\n",
    "# yapf: disable\n",
    "# isort: skip_file\n",
    "# autopep8: off\n",
    "# black: skip\n",
    "# pylint: disable=C0114\n",
    "# pylint: skip-file\n",
    "# pyright: ignore\n",
    "# mypy: ignore-errors\n",
    "# pragma: no cover\n",
    "# nosec\n",
  ]) {
    const [problem] = problems("a.py", source);
    assert.equal(problem?.code, "directive", source);
    assert.equal(problem?.suppressible, false, source);
  }
  assert.ok(
    !problems("a.py", "# the noqa comment is documented here\n").some(
      ({ code }) => code === "directive",
    ),
  );
});

await test("Python unterminated strings, brackets, prefixes and nested fields cannot produce a pass", () => {
  for (const [path, source] of [
    ["a.py", 's = "abc\n'],
    ["a.py", "s = '''open\n# Capital\n"],
    ["a.py", "x = (1,\n"],
    ["a.py", "print(1))\n"],
    ["a.py", 's = ub"x"\n'],
    ["a.rs", 'let s = "abc\n'],
  ]) {
    assert.ok(
      problems(path, source).some(({ status }) => status === "incomplete"),
      source,
    );
  }
});

await test("a Python keyword directly before a string is code, while an unknown word before one stays incomplete", () => {
  assert.deepEqual(problems("a.py", 'def f():\n    return"abc"\n'), []);
  assert.deepEqual(problems("a.py", 'if x in"abc":\n    pass\n'), []);
  assert.deepEqual(
    problems("a.py", 'if x in"abc": # Capital\n    pass\n').map(({ code }) => code),
    ["capital"],
  );
  assert.ok(problems("a.py", 'y = xor"abc"\n').some(({ status }) => status === "incomplete"));
});

await test("a backslash continuation inside a string in a CRLF file is one line break", () => {
  assert.deepEqual(problems("a.py", 's = "abc\\\r\ndef"\n'), []);
  assert.deepEqual(
    problems("a.py", 's = "abc\\\r\ndef"\n# Capital\n').map(({ code }) => code),
    ["capital"],
  );
  // a bare CRLF without the backslash still ends the single-quoted string
  assert.ok(problems("a.py", 's = "abc\r\ndef"\n').some(({ status }) => status === "incomplete"));
});

await test("Rust literals hide comment markers, and raw strings close only on their own hash count", () => {
  for (const source of [
    'let s = "// Capital";\n',
    'let s = "/* Capital */";\n',
    'let s = "a \\" // Capital";\n',
    'let s = r#"// "Capital" "#;\n',
    'let s = r##"a "# // Capital"##;\n',
    'let s = br"// Capital"; let t = cr#"/* Capital */"#;\n',
    'let b = b"// Capital"; let c = c"// Capital";\n',
  ]) {
    assert.deepEqual(problems("lib.rs", source), [], source);
  }
  assert.deepEqual(
    problems("lib.rs", "let r#type = 1; // Capital\n").map(({ code }) => code),
    ["capital"],
  );
});

await test("Rust char literals are not strings, and lifetimes are code", () => {
  const codes = (source: string): string[] => problems("lib.rs", source).map(({ code }) => code);
  assert.deepEqual(codes("let q = '\"'; // Capital\n"), ["capital"]);
  assert.deepEqual(codes("let q = '\\''; let s = '\\\\'; // Capital\n"), ["capital"]);
  assert.deepEqual(codes("let u = '\\u{1F600}'; let e = 'é'; // Capital\n"), ["capital"]);
  assert.deepEqual(
    problems("lib.rs", "fn f<'a>(x: &'a str) -> &'a str { // Capital\n    x\n}\n").map(
      ({ line, code }) => [line, code],
    ),
    [[1, "capital"]],
  );
  assert.deepEqual(codes("'outer: loop { break 'outer; } // Capital\n"), ["capital"]);
});

await test("Rust nested block comments end at the outer close and doc comments keep their text", () => {
  assert.deepEqual(
    problems("lib.rs", "/* a /* b */ TODO: still inside */\n").map(({ code }) => code),
    ["block", "task"],
  );
  assert.deepEqual(
    problems("lib.rs", '/* outer /* inner */ let x = "/* Capital */"; */\n// Capital\n').map(
      ({ line, code }) => [line, code],
    ),
    [
      [1, "block"],
      [2, "capital"],
    ],
  );
  assert.deepEqual(
    problems("lib.rs", "/// Capital\n//! Capital\n").map(({ line, code }) => [line, code]),
    [
      [1, "capital"],
      [2, "capital"],
    ],
  );
  assert.deepEqual(
    problems("lib.rs", "/** Doc */\n/*! Inner */\n").map(({ code }) => code),
    ["block", "block"],
  );
  assert.deepEqual(problems("lib.rs", "// rustfmt::skip\n"), []);
});

await test("unclosed Rust literals and comments are incomplete", () => {
  for (const source of [
    'let s = "abc\n',
    "/* open /* nested */\n",
    'let r = r#"open"\n',
    "let c = '\\n;\n",
  ]) {
    assert.ok(
      problems("lib.rs", source).some(({ status }) => status === "incomplete"),
      source,
    );
  }
});

await test("shell escaped quotes do not hide a later real comment", () => {
  assert.deepEqual(
    problems("script.sh", 'echo \\" # Capital\n').map(({ code }) => code),
    ["capital"],
  );
  assert.deepEqual(
    problems("script.sh", "#!/bin/sh\nprintf '%s' '# Capital'\ncat <<'EOF'\n# Capital\nEOF\n"),
    [],
  );
  assert.deepEqual(
    problems("script.sh", "echo x;#Capital\n").map(({ code }) => code),
    ["spacing", "capital"],
  );
  assert.deepEqual(problems("script.sh", 'cd "$(dirname "$0")"\n'), []);
});

await test("SQL dollar quotes and nested block comments are scanned consistently", () => {
  assert.deepEqual(
    problems(
      "main.sql",
      "SELECT '-- Capital';\nSELECT 'it''s -- text';\nSELECT $body$\n-- Capital\n$body$;\n/* keep /* nested */ notes */\n",
    ),
    [],
  );
  assert.deepEqual(
    problems("main.sql", "SELECT E'it\\'s -- data';\n-- Capital\n").map(({ line, code }) => [
      line,
      code,
    ]),
    [[2, "capital"]],
  );
});

await test("YAML block scalars and plain apostrophes do not hide following comments", () => {
  assert.deepEqual(
    problems(
      "config.yml",
      "title: John's service\nquoted: 'it''s # text'\nrun: |-\n  # Capital\n# Capital\n",
    ).map(({ line, code }) => [line, code]),
    [[5, "capital"]],
  );
});

await test("unclosed literals and unsupported interpolation cannot produce a pass", () => {
  for (const [path, source] of [
    ["a.rs", 'let text = r#"no end'],
    ["a.py", 'x = """no end'],
    ["a.sh", 'echo "$(echo $(pwd))"'],
    ["a.sh", "cat <<EOF\nmissing\n"],
  ]) {
    assert.ok(
      problems(path, source).some(({ status }) => status === "incomplete"),
      path,
    );
  }
});

await test("heredoc and substitution code cannot hide shell suppressions, and Python strings cannot hide Python ones", () => {
  for (const [path, source] of [
    ["a.sh", "cat <<EOF\n$(\n# shellcheck disable=SC2000\necho value)\nEOF\n"],
    ["a.sh", "cat <<EOF\n`echo value`\nEOF\n"],
    ["a.py", 'x = f"{\n# type: ignore\n}"\n'],
  ]) {
    assert.ok(
      problems(path, source).some(({ status }) => status === "incomplete"),
      source,
    );
  }
  assert.deepEqual(problems("a.sh", "cat <<'EOF'\n$(\n# shellcheck disable=SC2000\n)\nEOF\n"), []);
  assert.deepEqual(problems("a.sh", "cat <<EOF\n$(pwd)\nEOF\n"), []);
  assert.deepEqual(problems("a.py", 'x = """\n# type: ignore\n"""\n'), []);
});

await test("portable projects do not inherit ozmikhail comment wording; script ASTs stay in the pack", () => {
  assert.equal(commentsLanguageOf("app.ts"), undefined);
  assert.deepEqual(
    checkComments({
      root: ".",
      files: ["config.yml"],
      config: policy({ preset: "portable" }),
      read: () => "# Capital\n",
    }),
    [],
  );
  const [problem] = checkComments({
    root: ".",
    files: ["config.yml"],
    config: policy({ preset: "ozmikhail" }),
    read: () => "# Capital\n",
  });
  assert.equal(problem.rule, "comments.capital");
});

await test("suppression comments are refused in Python, Rust and the other kept languages; attributes and prose are not", () => {
  for (const [path, source] of [
    ["a.py", "# type: ignore\n"],
    ["a.py", "# noqa\n"],
    ["a.py", "# pragma: no cover\n"],
    ["a.rs", "// nosec\n"],
    ["a.rs", "/// pragma: no cover\n"],
    ["a.rs", "// eslint-disable-next-line\n"],
    ["a.sh", "# shellcheck disable=SC2000\n"],
    ["a.sh", "# shfmt: off\n"],
    ["a.css", "/* prettier-ignore */\n"],
  ]) {
    const [problem] = problems(path, source);
    assert.equal(problem.code, "directive", source);
    assert.equal(problem.suppressible, false, source);
  }
  assert.deepEqual(problems("a.py", 'x = "# type: ignore"\n'), []);
  assert.deepEqual(problems("a.rs", 'let s = "// nosec";\n'), []);
  assert.deepEqual(problems("a.sh", "#!/bin/sh\n# shellcheck shell=bash\n"), []);
  const context = {
    root: ".",
    files: ["src/a.rs"],
    config: policy({
      preset: "portable",
      projects: [{ root: ".", profile: "rust" }],
    }),
  };
  assert.deepEqual(
    checkComments({ ...context, read: () => "// Capital is permitted by portable\n" }),
    [],
  );
  assert.equal(
    checkComments({ ...context, read: () => "// nosec\n" })[0]?.rule,
    "comments.directive",
  );
  assert.equal(
    checkComments({ ...context, read: () => 'let s = "abc\n' })[0]?.rule,
    "comments.syntax",
  );
});

await test("tool suppressions in every supported comment syntax are refused, while prose mentions are not", () => {
  const refused = [
    ["ui/card.tsx", "// biome-ignore lint/suspicious: reason\n"],
    ["site.css", "/* stylelint-disable-next-line */\n"],
    ["compose.yml", "# hadolint ignore=DL3006\n"],
    ["lint.yaml", "# yamllint disable rule:line-length\n"],
    ["query.sql", "-- sqlfluff:noqa\n"],
    ["lint.yml", "# eslint-disable-next-line\n"],
    ["build.sh", "# pragma: no cover\n"],
    ["Dockerfile", "# nosec\n"],
    ["ci.yml", "# pylint: disable=C0114\n"],
    ["ci.yml", "# pyright: ignore\n"],
    ["ci.yml", "# istanbul ignore next\n"],
    ["ci.yml", "# c8 ignore next\n"],
    ["ci.yml", "# v8 ignore next\n"],
    ["ci.yml", "# @formatter:off\n"],
    ["ci.yml", "# editorconfig-checker-disable\n"],
    ["main.tf.yml", "# checkov:skip=CKV_1\n"],
    ["ci.yml", "# tflint-ignore: aws_instance\n"],
    ["ci.yml", "# gitleaks:allow\n"],
    ["ci.yml", "# cspell:disable\n"],
    ["ci.yml", "# nolint\n"],
  ];
  for (const [path, source] of refused) {
    assert.deepEqual(
      problems(path, source).map(({ code }) => code),
      ["directive"],
      `${path}: ${source}`,
    );
  }
  assert.ok(
    !problems("ci.yml", "# The linter needs nosec removed from this prose\n").some(
      ({ code }) => code === "directive",
    ),
  );
  assert.deepEqual(
    problems("src/a.ts", "//nolint:errcheck\n").map(({ code }) => code),
    ["directive"],
  );
  assert.deepEqual(
    problems("ci.yml", "# documented elsewhere: the linter is not a directive here\n").map(
      ({ code }) => code,
    ),
    [],
  );
});

await test("task markers are violations under ozmikhail unless the policy pattern names them, and lowercase prose is allowed", () => {
  const context = (
    source: string,
    comments?: Record<string, unknown>,
  ): ReturnType<typeof checkComments> =>
    checkComments({
      root: ".",
      files: ["src/a.yml"],
      config: policy({ preset: "ozmikhail", ...(comments ? { comments } : {}) }),
      read: () => source,
    });
  assert.deepEqual(
    context("# TODO: fix\n").map(({ rule }) => rule),
    ["comments.task"],
  );
  assert.deepEqual(
    context("# FIXME later\n").map(({ rule }) => rule),
    ["comments.task"],
  );
  assert.deepEqual(context("# todo: lowercase prose is allowed\n"), []);
  assert.deepEqual(context("# TODO(#12): tracked\n", { tasks: "TODO\\(#\\d+\\)" }), []);
  assert.deepEqual(
    context("# TODO: untracked\n", { tasks: "TODO\\(#\\d+\\)" }).map(({ rule }) => rule),
    ["comments.task"],
  );
  assert.deepEqual(
    context("# TODO(#12) and XXX here\n", { tasks: "TODO\\(#\\d+\\)" }).map(({ rule }) => rule),
    ["comments.task"],
  );
});

await test("Python and Rust task markers are checked the same way as JavaScript ones", () => {
  const check = (path: string, source: string, comments?: Record<string, unknown>) =>
    checkComments({
      root: ".",
      files: [path],
      config: policy({
        preset: "ozmikhail",
        ...(comments ? { comments } : {}),
      }),
      read: () => source,
    }).map(({ rule }) => rule);
  assert.deepEqual(check("src/a.py", "# TODO: fix\n"), ["comments.task"]);
  assert.deepEqual(check("src/a.rs", "/// FIXME later\n"), ["comments.task"]);
  assert.deepEqual(check("src/a.rs", 'let s = "TODO: later";\n'), []);
  assert.deepEqual(check("src/a.py", '"""TODO: docstring"""\n'), []);
  assert.deepEqual(check("src/a.py", "# TODO(#12): tracked\n", { tasks: "TODO\\(#\\d+\\)" }), []);
  assert.deepEqual(check("src/a.rs", "// TODO: untracked\n", { tasks: "TODO\\(#\\d+\\)" }), [
    "comments.task",
  ]);
});

await test("task markers inside string literals are data, not comments", () => {
  const found = checkComments({
    root: ".",
    files: ["src/a.ts"],
    config: policy({ preset: "ozmikhail" }),
    read: () => "const label = 'TODO: later';\n",
  });
  assert.deepEqual(found, []);
  assert.deepEqual(
    problems("src/a.sql", "-- TODO: finish\nSELECT 1;\n").map(({ code }) => code),
    ["task"],
  );
  assert.deepEqual(
    problems("src/a.sql", "SELECT 'TODO: finish';\n").map(({ code }) => code),
    [],
  );
});

await test("without ozmikhail, task markers are checked only when a tasks pattern is configured", () => {
  const portable = (comments?: Record<string, unknown>): ReturnType<typeof checkComments> =>
    checkComments({
      root: ".",
      files: ["app/a.py"],
      config: policy({
        preset: "portable",
        projects: [{ root: ".", profile: "python" }],
        ...(comments ? { comments } : {}),
      }),
      read: () => "# TODO: later\n",
    });
  assert.deepEqual(portable(undefined), []);
  assert.deepEqual(
    portable({ tasks: "TODO\\(#\\d+\\)" }).map(({ rule }) => rule),
    ["comments.task"],
  );
  assert.deepEqual(portable({ tasks: "TODO" }), []);
});
