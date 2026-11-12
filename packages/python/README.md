# Optional Python adapter

This adapter adds Python syntax and structural policy checks without adding a dependency to Plumb's Node core. It requires Python 3.10 or newer and uses only the Python standard library. No pip install is needed.

It checks selected `.py` and `.pyi` files with `tokenize`, `ast.parse`, and compilation of the resulting AST. It never executes the resulting code or imports candidate modules. Syntax follows the exact interpreter recorded in the adapter registry. This is syntax and source policy validation. Formatting, linting and type checking are the core's `python` profile, which runs ruff and mypy; a project with that profile runs this adapter beside them when the registry lists it. It does not verify runtime behavior, resolve imports or execute tests.

## Installation

Place the adapter and its generated registry **outside the candidate repository**. For example, run these commands from an approved Plumb checkout:

```sh
mkdir -p "$HOME/.local/share/plumb-python"
cp packages/python/adapter.py "$HOME/.local/share/plumb-python/adapter.py"
python3 -I -S "$HOME/.local/share/plumb-python/adapter.py" --manifest > "$HOME/.local/share/plumb-python/registry.json"
```

The manifest records absolute interpreter and script paths, their raw SHA-256 hashes, the exact Python version, rule metadata, and a strict options schema. Review it before use. Generate and review new pins when deliberately upgrading the adapter or interpreter. Pins identify the launcher and adapter file; they do not attest the interpreter's entire standard-library installation.

Plumb checks itself with this adapter through `node scripts/plumb.ts`. That wrapper never runs the working-tree copy: it reads `packages/python/adapter.py` from the git revision in `PLUMB_ADAPTER_REF` (default `HEAD`), so an uncommitted or unreviewed edit cannot judge itself. CI sets `PLUMB_ADAPTER_REF` to `origin/<base>` on pull requests and leaves it at `HEAD` on pushes. If the revision or file cannot be read, the wrapper stops with exit `2` and no fallback.

Add a Python project to the candidate's policy:

```json
{
  "schemaVersion": 1,
  "preset": "portable",
  "projects": [
    {
      "root": "src",
      "profile": "python",
      "options": {
        "forbiddenImports": [
          { "module": "subprocess", "reason": "Process execution belongs in the reviewed runner" },
          { "module": "app.internal", "reason": "Use the public application interface" }
        ]
      }
    }
  ]
}
```

Use `"root": "."` when Python sources live directly under the repository root. `options` is optional. Each forbidden module needs a unique dotted identifier and a nonempty reason; unknown options are rejected.

```sh
plumb doctor --root /path/to/project --adapters "$HOME/.local/share/plumb-python/registry.json"
plumb check --root /path/to/project --adapters "$HOME/.local/share/plumb-python/registry.json"
```

The generated command always uses `-I -S`. These flags prevent Python's usual user/site configuration and candidate import-path injection; they do not constitute an operating-system sandbox. The adapter does not read candidate configuration files or inherit ambient environment variables. Generic `project.prepare` command arrays are accepted and validated as metadata. Run them separately with `plumb prepare`; neither `check` nor `doctor` executes preparation commands. Unsupported project fields are rejected.

## Checks and limits

| Capability | Behavior                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syntax`   | Tokenizes, parses, and compiles each selected source without executing it. Compilation catches invalid contexts that AST parsing alone accepts, such as a top-level `return`. |
| `policy`   | Inspects real comment tokens for protected directives, AST import statements for configured boundaries, and test functions for real assertions.                               |

Protected directives include `noqa`, `ruff: noqa`, `flake8: noqa`, `type: ignore`, `fmt: off/skip`, `yapf: disable`, `isort: off/skip/skip_file`, `autopep8: off`, `black: skip`, `pylint: disable/disable-next/skip-file`, `pyright: ignore`, `mypy: ignore-errors`, `pragma: no cover`, and `nosec`. Comment-looking text inside strings or docstrings is harmless. Bare `except:` and handlers whose body is only `pass` or `...` are violations. In `test_*.py` and `*_test.py` files, `pytest.mark.skip/skipif/xfail`, `pytest.skip`, `pytest.xfail`, `unittest.skip*` and `self.skipTest` are violations. The `python/assertion` rule applies in the same test files to each `test_*` function, `async def` included, defined at module level or directly in a class body (any class, including `unittest.TestCase`). A test must contain at least one real assertion, and a missing one is reported at the test's `def` line. Accepted assertions are an `assert` statement whose condition is not trivial; a call or `with` use of `pytest.raises`, `pytest.warns` or `pytest.fail`, resolved through imports, so `import pytest as pt` and `from pytest import raises` count; `self.fail()` and `self.assert*` calls on the test's first parameter (`self`); and `assert_called*`, `assert_not_called`, `assert_any_call` or `assert_has_calls` calls on any receiver. Refused as assertions: `assert` conditions that are constant or always truthy, such as `assert True`, `assert 1`, `assert 'text'`, `assert (value, 'message')`, `assert value or True`, `assert 1 == 1` or `assert [value]`; `self.assert*` calls whose arguments are all constant, such as `self.assertTrue(True)`; assertions in nested functions, classes or lambdas, which are not the test body; and assertions after an unconditional `return` or `raise` at the top level of the test. The rule does not follow calls, so an assertion inside a helper does not count and a test that only calls a helper is reported. Assertions inside `if`, loop or `try` blocks count without proving that those blocks run. Names bound to constants are not evaluated, so `flag = True` followed by `assert flag` counts. Assertions on any other receiver, such as `other.assertEqual(...)`, do not count, and the rule does not check that a class derives from `TestCase`. Only the `test_` prefix is checked, not other names pytest may collect through configuration. Dynamic imports through `importlib.import_module` or `__import__` are checked against forbidden imports when their module name is a literal; other targets are incomplete. Directives and incomplete findings cannot be excepted. Forbidden import findings use Plumb's existing, reviewed exception mechanism; the adapter has no separate exemptions.

A forbidden module matches itself and dotted descendants: `subprocess` matches `subprocess` and `subprocess.tools`, but not `subprocess_helper`. `from pkg import internal` also selects the structural name `pkg.internal`. Relative imports are normalized using the file's directory beneath the declared project root, treating that root as the namespace boundary. For example, `src/app/main.py` under root `src` imports `app.internal` with `from . import internal`. When forbidden imports are configured, an import above that boundary, or a wildcard import that could select a forbidden descendant, makes policy inspection incomplete.

Names are resolved in their lexical scope. An import alias, a plain assignment such as `load = importlib.import_module`, a `global` or `nonlocal` declaration, a wildcard `from importlib import *` and a closure over an enclosing scope are all followed, and a binding in one scope never changes what the same name means in another: a nested `from json import load` does not hide a module-level `load` that is `import_module`. A class body's names are invisible to its methods, and decorators and defaults are read in the enclosing scope, as Python does. A name rebound to an unknown value keeps its own meaning, so a parameter called `pytest` is still treated as pytest.

What cannot be followed is incomplete, never a pass: `importlib`, `builtins` or `__builtins__` passed as a value, reached through `getattr` or a dunder attribute, unpacked from a tuple, stored on an attribute or imported inside a class body.

These rules describe lexical import statements, including statements inside functions, conditions, and `TYPE_CHECKING` blocks. They do not follow package exports, `__all__`, `sys.path` or `sys.modules` changes, `importlib.util` loaders, `exec`, `eval`, computed module names, or runtime dispatch. They cannot prove that forbidden code is unreachable at runtime.

Source encoding cookies and UTF-8 BOMs are supported. Evidence hashes cover the original bytes, including the encoding declaration. Paths must be normalized and repository-relative, stay in the selected project, and contain no symlink components or reserved repository directories. Missing, changed, unreadable, malformed, or oversized inputs produce `incomplete`, never success. Syntax failures leave structural policy coverage incomplete. Each request and source is limited to 16 MiB; each input list is limited to 10,000 files.

## Protocol and testing

The adapter implements Plumb external protocol version 1 over stdin/stdout JSON. `check` returns diagnostics, per-capability file coverage, observed input hashes, and the exact Python version. Exit codes are `0` for pass, `1` for violations, and `2` for incomplete checks. `doctor` validates the runtime, protocol, and options, returns no source coverage, and does not parse source files. The core still verifies its declared input and registry integrity around the doctor process.

Run the optional integration suite with a real interpreter:

```sh
npm run test:python
# Equivalent direct runner:
node --test packages/python/test/adapter.test.ts
# Select a particular interpreter:
PLUMB_TEST_PYTHON=/absolute/path/to/python3 npm run test:python
```

The suite has no skips or fake Python parser. Missing Python fails this optional gate; the portable core test suite remains Node-only.

Python references: [isolated mode and `-S`](https://docs.python.org/3/using/cmdline.html), [AST compilation caveats](https://docs.python.org/3/library/ast.html), and [tokenization and source encodings](https://docs.python.org/3/library/tokenize.html).
