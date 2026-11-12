import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { at, isArray } from "../../../src/schema.ts";
import { fixture, manifest } from "./adapter-support.ts";

// one source per file, lines joined the way the adapter reads them
const source = (...lines: string[]): string => `${lines.join("\n")}\n`;

// the test names a file's python/assertion findings report, in source order
const reported = (files: Record<string, string>, t: TestContext) =>
  fixture(t, files)
    .direct()
    .diagnostics.filter((item) => item.rule === "python/assertion")
    .map((item) => [item.path, item.message.split(" ")[1], item.line]);

await test("the assertion rule is declared in the manifest as a non-suppressible policy rule", () => {
  const rules = at(manifest, "adapters", 0, "rules");
  const rule = isArray(rules)
    ? rules.find((item) => at(item, "id") === "python/assertion")
    : undefined;
  assert.deepEqual(
    { capability: at(rule, "capability"), suppressible: at(rule, "suppressible") },
    { capability: "policy", suppressible: false },
  );
});

await test("each accepted assertion form satisfies a test, including class-based and async tests", (t) => {
  const { direct } = fixture(t, {
    "test_assert.py": source("def test_a():", "    value = 1", "    assert value == 1"),
    "test_name.py": source("def test_b(tmp):", "    assert tmp"),
    "test_raises.py": source(
      "import pytest",
      "def test_c():",
      "    with pytest.raises(ValueError):",
      "        int('x')",
    ),
    "test_alias.py": source(
      "import pytest as pt",
      "def test_d():",
      "    with pt.warns(UserWarning):",
      "        pass",
    ),
    "test_from.py": source(
      "from pytest import raises",
      "def test_e():",
      "    with raises(ValueError):",
      "        int('x')",
    ),
    "test_fail.py": source(
      "from pytest import fail",
      "def test_f(value):",
      "    if value:",
      "        fail('boom')",
    ),
    "test_mock.py": source(
      "def test_g(mock):",
      "    mock.assert_called_once_with(1)",
      "    mock.assert_not_called()",
      "    mock.assert_any_call(2)",
      "    mock.assert_has_calls([])",
    ),
    "test_unittest.py": source(
      "import unittest",
      "class T(unittest.TestCase):",
      "    def test_a(self):",
      "        self.assertEqual(self.value(), 1)",
      "    def test_b(self):",
      "        with self.assertRaises(ValueError):",
      "            int('x')",
      "    def test_c(self):",
      "        self.fail('boom')",
      "    def value(self):",
      "        return 1",
    ),
    "test_class.py": source(
      "class TestApi:",
      "    def test_a(self, run):",
      "        assert run() == 1",
    ),
    "test_async.py": source("async def test_a(run):", "    assert await run() == 1"),
  });
  const output = direct();
  assert.equal(output.status, "pass", JSON.stringify(output.diagnostics));
});

await test("tests that assert nothing are reported at their def line, including methods and async tests", (t) => {
  assert.deepEqual(
    reported(
      {
        "test_empty.py": source("def test_a():", "    pass"),
        "test_decorated.py": source(
          "import pytest",
          "@pytest.mark.parametrize('x', [1])",
          "def test_b(x):",
          "    pass",
        ),
        "test_class.py": source(
          "class TestApi:",
          "    def test_a(self):",
          "        self.run()",
          "    async def test_b(self):",
          "        pass",
        ),
        "test_unittest.py": source(
          "import unittest",
          "class T(unittest.TestCase):",
          "    def test_a(self):",
          "        self.value()",
        ),
        "test_branch.py": source("if True:", "    def test_a():", "        pass"),
      },
      t,
    ),
    [
      ["test_branch.py", "test_a", 2],
      ["test_class.py", "test_a", 2],
      ["test_class.py", "test_b", 4],
      ["test_decorated.py", "test_b", 3],
      ["test_empty.py", "test_a", 1],
      ["test_unittest.py", "test_a", 3],
    ],
  );
});

await test("constant and trivially truthy assertions do not count", (t) => {
  assert.deepEqual(
    reported(
      {
        "test_constants.py": source(
          "def test_true():",
          "    assert True",
          "def test_one():",
          "    assert 1",
          "def test_text():",
          "    assert 'text'",
          "def test_tuple(value):",
          "    assert (value, 'message')",
          "def test_or(value):",
          "    assert value or True",
          "def test_constant_compare():",
          "    assert 1 == 1",
          "def test_not():",
          "    assert not 0",
          "def test_list(value):",
          "    assert [value]",
          "def test_dict(value):",
          "    assert {'a': value}",
          "def test_if_both_constant(value):",
          "    assert 1 if value else 2",
          "def test_non_constant_or(value):",
          "    assert value or False",
        ),
      },
      t,
    ).map((item) => item[1]),
    [
      "test_true",
      "test_one",
      "test_text",
      "test_tuple",
      "test_or",
      "test_constant_compare",
      "test_not",
      "test_list",
      "test_dict",
      "test_if_both_constant",
    ],
  );
});

await test("trivial unittest assertions do not count, but assertions over real values do", (t) => {
  assert.deepEqual(
    reported(
      {
        "test_trivial.py": source(
          "import unittest",
          "class T(unittest.TestCase):",
          "    def test_true(self):",
          "        self.assertTrue(True)",
          "    def test_equal(self):",
          "        self.assertEqual(1, 1)",
          "    def test_argless_fail_counts(self):",
          "        self.assertTrue()",
          "    def test_real(self, run):",
          "        self.assertEqual(run(), 1)",
        ),
      },
      t,
    ).map((item) => item[1]),
    ["test_true", "test_equal"],
  );
});

await test("assertions inside nested functions, classes and lambdas do not count for the enclosing test", (t) => {
  assert.deepEqual(
    reported(
      {
        "test_nested.py": source(
          "import pytest",
          "def test_function(value):",
          "    def check():",
          "        assert value",
          "    return check",
          "def test_lambda():",
          "    run = lambda: pytest.raises(ValueError)",
          "    run()",
          "def test_class(value):",
          "    class Check:",
          "        def run(self):",
          "            assert value",
          "    Check()",
          "def test_nested_test(value):",
          "    def test_inner():",
          "        assert value",
          "    test_inner()",
        ),
      },
      t,
    ).map((item) => item[1]),
    ["test_function", "test_lambda", "test_class", "test_nested_test"],
  );
});

await test("assertions after an unconditional top-level return or raise are dead and do not count", (t) => {
  assert.deepEqual(
    reported(
      {
        "test_dead.py": source(
          "import pytest",
          "def test_return(value):",
          "    return value",
          "    assert value == 1",
          "def test_raise(value):",
          "    raise RuntimeError(value)",
          "    pytest.fail('dead')",
          "def test_fail_before_return(value):",
          "    assert value == 1",
          "    return value",
          "def test_conditional_return(value):",
          "    if value:",
          "        return value",
          "    assert value == 1",
        ),
      },
      t,
    ).map((item) => item[1]),
    ["test_return", "test_raise"],
  );
});

await test("pytest and mock names must be called, and only the test's own self counts for unittest", (t) => {
  assert.deepEqual(
    reported(
      {
        "test_reference.py": source("import pytest", "def test_a():", "    check = pytest.raises"),
        "test_other_receiver.py": source(
          "import unittest",
          "class T(unittest.TestCase):",
          "    def test_a(self):",
          "        other = self.make()",
          "        other.assertEqual(self.run(), 1)",
          "    def make(self):",
          "        return self",
        ),
        "test_mock_reference.py": source(
          "def test_a(mock):",
          "    check = mock.assert_called_once",
        ),
      },
      t,
    ).map((item) => item[0]),
    ["test_mock_reference.py", "test_other_receiver.py", "test_reference.py"],
  );
});

await test("a test that asserts through its own helper is reported: helper bodies are not followed", (t) => {
  assert.deepEqual(
    reported(
      {
        "test_helper.py": source(
          "def check(value):",
          "    assert value == 1",
          "def test_a():",
          "    check(1)",
        ),
      },
      t,
    ).map((item) => item[1]),
    ["test_a"],
  );
});

await test("only test_ functions in test files are checked; helpers and other files are not", (t) => {
  assert.deepEqual(
    reported(
      {
        "helpers.py": source("def test_a():", "    pass"),
        "conftest.py": source("def test_a():", "    pass"),
        "api.py": source("def test_a():", "    pass"),
        "test_helpers.py": source(
          "def helper():",
          "    pass",
          "def check_value():",
          "    pass",
          "def _test_a():",
          "    pass",
          "class Helper:",
          "    def helper(self):",
          "        pass",
        ),
        "test_trivial.py": source("def test_a():", "    assert 1 == 2 or True or 'x'"),
      },
      t,
    ).map((item) => item[0]),
    ["test_trivial.py"],
  );
});

await test("a real assertion beside a trivial one still passes", (t) => {
  const { direct } = fixture(t, {
    "test_mixed.py": source("def test_a(value):", "    assert True", "    assert value == 1"),
  });
  assert.equal(direct().status, "pass");
});
