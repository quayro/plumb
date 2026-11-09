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
    ["thing.rb", "# Keep it short\n"],
  ];
  for (const [path, text] of failures) {
    assert.equal(problems(path, text).length, 1, path);
  }
  assert.deepEqual(
    problems("thing.cpp", "// clang-format on\n// Example: auto x = 1;\n// TOTP stays verified\n"),
    [],
  );
  assert.deepEqual(problems("thing.rb", "# frozen_string_literal: true\n"), []);
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

await test("C++ raw strings, digit separators, and spliced lines preserve real comment positions", () => {
  const clean =
    "auto a = R\"tag(\n// Capital\n/* Capital */\n)tag\";\nlong n = 1'000;\nchar c = '/';\n";
  assert.deepEqual(problems("main.cpp", clean), []);
  assert.deepEqual(
    problems("main.cpp", clean + "// Capital\n").map(({ line, code }) => [line, code]),
    [[7, "capital"]],
  );
  assert.deepEqual(
    problems("main.cpp", "int n = 0xAB'CD; // Capital\n").map(({ code }) => code),
    ["capital"],
  );
  assert.deepEqual(
    problems("main.cpp", "/\\\n/ Capital\n").map(({ line, code }) => [line, code]),
    [[1, "capital"]],
  );
});

await test("Ruby multiline strings and inline hash comments are distinct", () => {
  assert.deepEqual(problems("main.rb", 'value = "line one\n# Capital\nline three"\n'), []);
  assert.deepEqual(
    problems("main.rb", "n = 1#Comment\n").map(({ code }) => code),
    ["spacing", "capital"],
  );
  assert.deepEqual(
    problems("main.rb", "value = 'it\\'s # not a comment'\n# Capital\n").map(({ line, code }) => [
      line,
      code,
    ]),
    [[2, "capital"]],
  );
  assert.deepEqual(problems("main.rb", 'puts "#{1} # not a comment"\n'), []);
  assert.deepEqual(problems("main.rb", "value = %q{# Capital { data }}\npattern = /[/#]*/\n"), []);
  assert.deepEqual(problems("main.rb", "value %= 2\n# keep the remainder\n"), []);
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
    ["a.cpp", 'auto text = R"tag(no end'],
    ["a.rb", 'puts "#{\n# hidden\n1}"'],
    ["a.sh", 'echo "$(echo $(pwd))"'],
    ["a.sh", "cat <<EOF\nmissing\n"],
  ]) {
    assert.ok(
      problems(path, source).some(({ status }) => status === "incomplete"),
      path,
    );
  }
});

await test("character literals and embedded heredoc code cannot hide source suppressions", () => {
  for (const [path, source] of [
    ["a.rb", 'quote = ?"\n# rubocop:disable all\nother = ?"\n'],
    ["a.rb", "value = <<~TEXT\n#{\n# rubocop:disable all\n1}\nTEXT\n"],
    ["a.rb", 'value = <<"TEXT"\n#{\n# rubocop:disable all\n1}\nTEXT\n'],
    ["a.sh", "cat <<EOF\n$(\n# shellcheck disable=SC2000\necho value)\nEOF\n"],
    ["a.sh", "cat <<EOF\n`echo value`\nEOF\n"],
  ]) {
    assert.ok(
      problems(path, source).some(({ status }) => status === "incomplete"),
      source,
    );
  }
  assert.deepEqual(
    problems("a.rb", "value = <<~'TEXT'\n=begin\n#{\n# rubocop:disable all\n}\nTEXT\n"),
    [],
  );
  assert.deepEqual(problems("a.rb", "value = <<~TEXT\n#{value}\n\\#{literal}\nTEXT\n"), []);
  assert.deepEqual(problems("a.sh", "cat <<'EOF'\n$(\n# shellcheck disable=SC2000\n)\nEOF\n"), []);
  assert.deepEqual(problems("a.sh", "cat <<EOF\n$(pwd)\nEOF\n"), []);
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

await test("native suppression controls cannot be disguised as benign tool directives", () => {
  for (const [path, source] of [
    ["a.cpp", "// explanation NOLINT(check-name)\n"],
    ["a.cpp", "// NOLINTNEXTLINE\n"],
    ["a.cpp", "/* NOLINTBEGIN */\n"],
    ["a.cpp", "// clang-format off\n"],
    ["a.rb", "# rubocop:disable all\n"],
    ["a.rb", "# rubocop:todo Style/StringLiterals\n"],
    ["a.rb", "# rubocop:push -Style/GuardClause\n"],
    ["a.rb", "# rubocop:push +Style/For -Style/GuardClause\n"],
    ["a.rb", "# rubocop:disable-next Metrics/MethodLength\n"],
    ["a.sh", "# shellcheck disable=SC2000\n"],
    ["a.sh", "# shfmt: off\n"],
    ["a.css", "/* prettier-ignore */\n"],
  ]) {
    const [problem] = problems(path, source);
    assert.equal(problem.code, "directive", source);
    assert.equal(problem.suppressible, false, source);
  }
  assert.deepEqual(problems("a.cpp", 'const char* text = "NOLINT";\n'), []);
  assert.deepEqual(problems("a.rb", "# frozen_string_literal: true\n# rubocop:enable all\n"), []);
  assert.deepEqual(problems("a.rb", "# rubocop:push +Style/For\n# rubocop:pop\n"), []);
  assert.deepEqual(problems("a.sh", "#!/bin/sh\n# shellcheck shell=bash\n"), []);
  const context = {
    root: ".",
    files: ["src/a.cpp"],
    config: policy({
      preset: "portable",
      projects: [{ root: ".", profile: "cpp", compileCommands: "build" }],
    }),
  };
  assert.deepEqual(
    checkComments({ ...context, read: () => "// Capital is permitted by portable\n" }),
    [],
  );
  assert.equal(
    checkComments({ ...context, read: () => "// NOLINT\n" })[0]?.rule,
    "comments.directive",
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
    problems("src/a.cpp", "//nolint:errcheck\n").map(({ code }) => code),
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
      files: ["app/a.rb"],
      config: policy({
        preset: "portable",
        projects: [{ root: ".", profile: "ruby" }],
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
