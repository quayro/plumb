"""Plumb's optional, dependency-free Python syntax and structural policy adapter."""

from __future__ import annotations

import ast
import hashlib
import io
import json
import keyword
import os
import re
import stat
import sys
import tokenize
import warnings
from pathlib import Path
from typing import TYPE_CHECKING, NoReturn, TypedDict

if TYPE_CHECKING:
    from collections.abc import Sequence

VERSION = "1.0.0"
PYTHON = ".".join(map(str, sys.version_info[:3]))
CAPABILITIES = ["syntax", "policy"]
LIMIT = 16 * 1024 * 1024
MAX_INPUTS = 10000
EXIT_CODES = {"pass": 0, "violation": 1, "incomplete": 2}
MODULE = r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*"
DIRECTIVE = re.compile(
    r"(?:^|#)\s*(?:(?:(?:ruff|flake8)\s*:\s*)?noqa\b|type\s*:\s*ignore\b|"
    r"fmt\s*:\s*(?:off|skip)\b|yapf\s*:\s*disable\b|isort\s*:\s*(?:off|skip(?:_file)?)\b|"
    r"autopep8\s*:\s*off\b|black\s*:\s*skip\b|pylint\s*:\s*(?:disable(?:-next)?|skip-file)\b|"
    r"pyright\s*:\s*ignore\b|mypy\s*:\s*ignore-errors\b|pragma\s*:\s*no\s*cover\b|nosec\b)",
    re.IGNORECASE,
)
RULES: list[tuple[str, str, str, str, bool]] = [
    (
        "syntax",
        "Python source parses and compiles without execution.",
        "Correct the Python syntax, then rerun all checks.",
        "syntax",
        False,
    ),
    (
        "input",
        "Every selected source has the expected bytes and remains readable.",
        "Restore the selected input and rerun the complete check.",
        "syntax",
        False,
    ),
    (
        "protocol",
        "Requests use the supported protocol and explicit options.",
        "Correct the adapter request or installation.",
        "syntax",
        False,
    ),
    (
        "directive",
        "Listed lint, type and formatting suppression directives are prohibited.",
        "Remove the suppression directive and correct the underlying source.",
        "policy",
        False,
    ),
    (
        "import",
        "Import statements respect declared module boundaries.",
        "Use an allowed import or review a scoped core policy exception.",
        "policy",
        True,
    ),
    (
        "except",
        "Exception handlers must not silently discard errors.",
        "Handle the specific exception or re-raise it.",
        "policy",
        False,
    ),
    (
        "skip",
        "Test files must not skip, xfail or disable tests.",
        "Fix the test or remove it from the suite.",
        "policy",
        False,
    ),
    (
        "assertion",
        "Test functions must contain a real assertion.",
        "Assert the behaviour the test is about, or remove the test.",
        "policy",
        False,
    ),
]
DYNAMIC = {
    "importlib.import_module",
    "__import__",
    "builtins.__import__",
    "__builtins__.__import__",
}
ESCAPES = {"importlib", "builtins", "__builtins__"}
SKIPS = {
    "pytest.mark.skip",
    "pytest.mark.skipif",
    "pytest.mark.xfail",
    "pytest.skip",
    "pytest.xfail",
    "unittest.skip",
    "unittest.skipIf",
    "unittest.skipUnless",
}
ASSERTS = {"pytest.raises", "pytest.warns", "pytest.fail"}
MOCK_ASSERTS = {"assert_not_called", "assert_any_call", "assert_has_calls"}
UNITTEST_ASSERT = re.compile(r"assert[A-Z][A-Za-z]*")
NESTED: tuple[type[ast.AST], ...] = (
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
    ast.Lambda,
)
TEST_FILE = re.compile(r"(?:^|/)(?:test_[^/]*|[^/]*_test)\.py$")
TRY: tuple[type[ast.Try], ...] = (ast.Try, getattr(ast, "TryStar", ast.Try))
OPTIONS_SCHEMA: dict[str, object] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "forbiddenImports": {
            "type": "array",
            "uniqueItems": True,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["module", "reason"],
                "properties": {
                    "module": {"type": "string", "pattern": "^" + MODULE + "$"},
                    "reason": {"type": "string", "minLength": 1, "pattern": r"\S"},
                },
            },
        }
    },
}
Located = ast.stmt | ast.expr | ast.excepthandler
Plan = tuple[Path, str, list[tuple[str, str]], dict[str, str | None], object]


class InvalidError(ValueError):
    """A request or source the adapter refuses to interpret."""


class _Location(TypedDict):
    rule: str
    path: str
    message: str
    status: str


class Diagnostic(_Location, total=False):
    """One finding: the required fields plus an optional line and column."""

    line: int
    column: int


class Source(TypedDict):
    """A selected input with the hash the adapter actually read."""

    path: str
    sha256: str | None


def fail(message: str) -> NoReturn:
    """Stop the current check with a message that becomes a protocol diagnostic."""
    raise InvalidError(message)


def require(condition: object, message: str) -> None:
    """Raise InvalidError with message unless condition is truthy."""
    if not condition:
        fail(message)


def shape(
    value: object, required: tuple[str, ...], optional: tuple[str, ...] = ()
) -> dict[str, object]:
    """Return value as an object whose keys are exactly the required and optional fields."""
    if not (
        type(value) is dict
        and set(required) <= value.keys()
        and value.keys() <= set(required) | set(optional)
    ):
        fail("Unexpected or missing object fields")
    return value


def relative_name(value: object, *, allow_dot: bool = False) -> str:
    """Return value as a normalized repository-relative path, or refuse it."""
    if not (
        isinstance(value, str)
        and value
        and "\x00" not in value
        and "\\" not in value
        and not value.startswith("/")
        and not re.match(r"^[A-Za-z]:", value)
    ):
        fail("Expected a normalized repository-relative path")
    if value == "." and allow_dot:
        return value
    require(
        all(
            part not in ("", ".", "..", ".git", ".hg", ".svn", "node_modules")
            for part in value.split("/")
        ),
        "Unsafe or non-normalized repository path",
    )
    return value


def safe_path(root: Path, name: str, *, directory: bool = False) -> Path:
    """Return the regular file or directory that name denotes under root, refusing links."""
    path = root
    for part in [] if name == "." else name.split("/"):
        path = path / part
        require(not path.is_symlink(), "Symbolic links are not followed")
    mode = path.stat().st_mode
    if directory:
        require(stat.S_ISDIR(mode), "Expected a regular directory")
    else:
        require(stat.S_ISREG(mode), "Expected a regular source file")
    require(path.resolve().is_relative_to(root), "Path escapes the repository")
    return path


def read_source(root: Path, name: str) -> bytes:
    """Return the bytes of one selected source, without following links."""
    path = safe_path(root, name)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "Expected a regular source file")
        value = stream.read(LIMIT + 1)
    require(len(value) <= LIMIT, "Source exceeds the 16 MiB adapter limit")
    safe_path(root, name)
    return value


def sha256(value: bytes) -> str:
    """Return the SHA-256 hex digest of value."""
    return hashlib.sha256(value).hexdigest()


def file_hash(path: str) -> str:
    """Return the SHA-256 hex digest of the file at path, read in blocks."""
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(65536), b""):
            value.update(block)
    return value.hexdigest()


def manifest() -> dict[str, object]:
    """Return the registry entry that pins this adapter, its interpreter and their hashes."""
    interpreter = str(Path(sys.executable).resolve())
    script = str(Path(__file__).resolve())
    return {
        "schemaVersion": 1,
        "adapters": [
            {
                "id": "python",
                "version": VERSION,
                "files": ["**/*.py", "**/*.pyi"],
                "capabilities": CAPABILITIES,
                "command": [interpreter, "-I", "-S", script],
                "integrity": [
                    {"path": path, "sha256": file_hash(path)} for path in (interpreter, script)
                ],
                "environment": [],
                "inputs": [],
                "tools": {"python": PYTHON},
                "optionsSchema": OPTIONS_SCHEMA,
                "rules": [
                    {
                        "id": "python/" + name,
                        "description": description,
                        "remedy": remedy,
                        "capability": capability,
                        "suppressible": suppressible,
                    }
                    for name, description, remedy, capability, suppressible in RULES
                ],
            }
        ],
    }


def diagnostic(
    rule: str,
    path: str,
    message: str,
    status: str = "incomplete",
    position: tuple[object, object] = (None, None),
) -> Diagnostic:
    """Return one finding for rule at path; line and column are kept only when positive."""
    line, column = position
    value: Diagnostic = {
        "rule": "python/" + rule,
        "path": path,
        "message": message,
        "status": status,
    }
    if type(line) is int and line > 0:
        value["line"] = line
    if type(column) is int and column > 0:
        value["column"] = column
    return value


def response(
    diagnostics: Sequence[Diagnostic] = (),
    coverage: Sequence[dict[str, object]] = (),
    inputs: Sequence[Source] = (),
) -> dict[str, object]:
    """Return the protocol response for these findings, coverage and inputs."""
    status = (
        "incomplete"
        if any(item["status"] == "incomplete" for item in diagnostics)
        else "violation"
        if diagnostics
        else "pass"
    )
    return {
        "schemaVersion": 1,
        "adapter": "python",
        "version": VERSION,
        "status": status,
        "diagnostics": list(diagnostics),
        "coverage": list(coverage),
        "inputs": list(inputs),
        "versions": {"python": PYTHON},
    }


def capabilities_match(value: object) -> bool:
    """Return True when value is a list naming the syntax and policy capabilities once each."""
    return type(value) is list and sorted(value) == sorted(CAPABILITIES)


def prepare_commands(value: object) -> bool:
    """Return True when value is a nonempty list of nonempty argument arrays."""
    return (
        type(value) is list
        and bool(value)
        and all(
            type(command) is list
            and bool(command)
            and all(isinstance(argument, str) and bool(argument) for argument in command)
            for command in value
        )
    )


def absolute_root(value: object) -> str:
    """Return the request root when it is an absolute path without NUL bytes."""
    if not (isinstance(value, str) and "\x00" not in value and Path(value).is_absolute()):
        fail("Repository root must be absolute")
    return value


def dotted_module(value: object) -> str:
    """Return value when it is a dotted Python module name with no keyword parts."""
    if not (
        isinstance(value, str)
        and re.fullmatch(MODULE, value)
        and not any(keyword.iskeyword(part) for part in value.split("."))
    ):
        fail("Forbidden module must be a dotted Python identifier")
    return value


def reason_text(value: object) -> str:
    """Return value when it is a string with visible text."""
    if not (isinstance(value, str) and value.strip()):
        fail("Forbidden imports need a nonempty reason")
    return value


def validate_restrictions(value: object) -> list[tuple[str, str]]:
    """Return the validated (module, reason) pairs of the forbiddenImports option."""
    if type(value) is not list:
        fail("forbiddenImports must be an array")
    restrictions: list[tuple[str, str]] = []
    modules: set[str] = set()
    for entry in value:
        fields = shape(entry, ("module", "reason"))
        module = dotted_module(fields["module"])
        require(module not in modules, "Duplicate forbidden module")
        modules.add(module)
        restrictions.append((module, reason_text(fields["reason"])))
    return restrictions


def input_hash(value: object) -> str | None:
    """Return a SHA-256 hex digest or null, and refuse anything else."""
    if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value):
        return value
    if value is None:
        return None
    fail("Input hashes must be SHA-256 or null")


def validate_entries(value: object, project_root: str) -> dict[str, str | None]:
    """Return the validated path-to-hash evidence of one files or inputs list."""
    if type(value) is not list or len(value) > MAX_INPUTS:
        fail("Input lists must contain at most 10000 files")
    values: dict[str, str | None] = {}
    for entry in value:
        fields = shape(entry, ("path", "sha256"))
        path = relative_name(fields["path"])
        require(path.endswith((".py", ".pyi")), "Only .py and .pyi source inputs are supported")
        require(
            project_root == "." or path.startswith(project_root + "/"),
            "Source is outside its project root",
        )
        require(path not in values, "Duplicate source input")
        values[path] = input_hash(fields["sha256"])
    return values


def validate(request: object) -> Plan:
    """Check the request envelope and return the root, project, restrictions and evidence."""
    fields = shape(
        request,
        (
            "schemaVersion",
            "action",
            "adapter",
            "version",
            "root",
            "project",
            "files",
            "inputs",
            "capabilities",
        ),
    )
    require(
        type(fields["schemaVersion"]) is int and fields["schemaVersion"] == 1,
        "Unsupported protocol schemaVersion",
    )
    require(
        fields["adapter"] == "python" and fields["version"] == VERSION,
        "Unsupported adapter identity or version",
    )
    require(fields["action"] in ("check", "doctor"), "Unsupported action")
    require(
        capabilities_match(fields["capabilities"]),
        "Request must declare syntax and policy capabilities exactly once",
    )
    project = shape(fields["project"], ("root", "profile"), ("options", "prepare"))
    require(project["profile"] == "python", "Unsupported project profile")
    if "prepare" in project:
        require(
            prepare_commands(project["prepare"]),
            "prepare must contain nonempty command argument arrays",
        )
    project_root = relative_name(project["root"], allow_dot=True)
    root = Path(absolute_root(fields["root"])).resolve(strict=True)
    require(root.is_dir(), "Repository root must be a directory")
    safe_path(root, project_root, directory=True)
    options = shape(project.get("options", {}), (), ("forbiddenImports",))
    restrictions = validate_restrictions(options.get("forbiddenImports", []))
    observed = [validate_entries(fields[key], project_root) for key in ("files", "inputs")]
    require(observed[0] == observed[1], "Input evidence must match the selected sources exactly")
    require(
        fields["action"] == "doctor" or bool(observed[0]),
        "No Python source files were selected",
    )
    return root, project_root, restrictions, observed[0], fields["action"]


def column_of(lines: list[str], node: Located) -> int:
    """Return the 1-based UTF-8 column where node starts on its line."""
    return len(lines[node.lineno - 1].encode("utf8")[: node.col_offset].decode("utf8")) + 1


class Scopes:
    """Lexical name resolution: which import, if any, a name denotes at the place it is used."""

    def __init__(self, tree: ast.Module) -> None:
        """Bind every name in the module and follow the plain assignments between them."""
        self.module = tree
        self.bindings: dict[ast.AST, dict[str, set[str | None]]] = {}
        self.parent: dict[ast.AST, ast.AST] = {}
        self.home: dict[ast.Name, ast.AST] = {}
        self.declared: dict[ast.AST, dict[str, ast.AST]] = {}
        self.stars: list[str] = []
        self.aliases: list[tuple[ast.AST, str, ast.expr]] = []
        self.followed: set[int] = set()
        stack: list[tuple[ast.AST, ast.AST]] = [(tree, tree)]
        while stack:
            node, scope = stack.pop()
            stack.extend(reversed(self.note(node, scope)))
        # a plain assignment passes its value's meaning on; chains longer than this stay unfollowed
        for _ in range(8):
            for scope, name, value in self.aliases:
                self.bindings[self.declared.get(scope, {}).get(name, scope)][name] |= self.targets(
                    value
                )

    def bind(self, scope: ast.AST, name: str, target: str | None = None) -> None:
        """Record that name is bound in scope, to the import target when there is one."""
        scope = self.declared.get(scope, {}).get(name, scope)
        self.bindings.setdefault(scope, {}).setdefault(name, set()).add(target)

    def note(self, node: ast.AST, scope: ast.AST) -> list[tuple[ast.AST, ast.AST]]:
        """Record the bindings one node creates and return its children with their scopes."""
        if isinstance(node, ast.Import):
            self.note_import(node, scope)
            return []
        if isinstance(node, ast.ImportFrom):
            self.note_import_from(node, scope)
            return []
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            self.note_declared(node, scope)
            return []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            return self.note_definition(node, scope)
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr)) and isinstance(
            node.value, (ast.Name, ast.Attribute)
        ):
            self.note_alias(node, node.value, scope)
        if isinstance(node, ast.Name):
            self.home[node] = scope
            if not isinstance(node.ctx, ast.Load):
                self.bind(scope, node.id)
        for name in (getattr(node, "name", None), getattr(node, "rest", None)):
            if isinstance(name, str):
                self.bind(scope, name)
        return [(child, scope) for child in ast.iter_child_nodes(node)]

    def note_import(self, node: ast.Import, scope: ast.AST) -> None:
        """Bind the names an import statement creates."""
        for alias in node.names:
            root = alias.name.split(".")[0]
            self.bind(scope, alias.asname or root, alias.name if alias.asname else root)

    def note_import_from(self, node: ast.ImportFrom, scope: ast.AST) -> None:
        """Bind the names a from-import creates, and remember star imports of absolute modules."""
        absolute = node.module if node.level == 0 else None
        for alias in node.names:
            if alias.name != "*":
                target = f"{absolute}.{alias.name}" if absolute else None
                self.bind(scope, alias.asname or alias.name, target)
            elif absolute:
                self.stars.append(absolute)

    def note_declared(self, node: ast.Global | ast.Nonlocal, scope: ast.AST) -> None:
        """Record the scope that global or nonlocal names are bound in."""
        owner: ast.AST = self.module
        if isinstance(node, ast.Nonlocal):
            owner = self.parent.get(scope, self.module)
            while isinstance(owner, ast.ClassDef):
                owner = self.parent.get(owner, self.module)
        for name in node.names:
            self.declared.setdefault(scope, {})[name] = owner

    def note_definition(
        self,
        node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef | ast.Lambda,
        scope: ast.AST,
    ) -> list[tuple[ast.AST, ast.AST]]:
        """Bind a definition's name and parameters and return its children with their scopes."""
        if not isinstance(node, ast.Lambda):
            self.bind(scope, node.name)
        self.parent[node] = scope
        body = {id(item) for item in (node.body if isinstance(node.body, list) else [node.body])}
        children: list[tuple[ast.AST, ast.AST]] = []
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.arguments):
                for item in ast.walk(child):
                    if isinstance(item, ast.arg):
                        self.bind(node, item.arg)
            # decorators, bases, defaults and annotations are evaluated in the enclosing scope
            children.append((child, node if id(child) in body else scope))
        return children

    def note_alias(
        self,
        node: ast.Assign | ast.AnnAssign | ast.NamedExpr,
        value: ast.Name | ast.Attribute,
        scope: ast.AST,
    ) -> None:
        """Remember that the names assigned from value take its meaning."""
        targets: list[ast.expr] = node.targets if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
            if isinstance(target, ast.Name):
                self.aliases.append((scope, target.id, value))
                self.followed.add(id(value))

    def targets(self, node: ast.expr) -> set[str]:
        """Return every dotted import path a name or attribute chain may denote; empty if none."""
        parts: list[str] = []
        while isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        if not isinstance(node, ast.Name) or node not in self.home:
            return set()
        scope: ast.AST = self.home[node]
        found: set[str | None] | None = None
        first = True
        while found is None:
            # a class body's names are invisible to the functions nested in it
            if (first or not isinstance(scope, ast.ClassDef)) and node.id in self.bindings.get(
                scope, {}
            ):
                found = self.bindings[scope][node.id]
            elif scope is self.module:
                found = {node.id, *(f"{module}.{node.id}" for module in self.stars)}
            scope, first = self.parent.get(scope, self.module), False
        # a name rebound to an unknown value keeps its own meaning: a local pytest is pytest
        return {".".join([base or node.id, *reversed(parts)]) for base in found}


def escaped_name(
    node: ast.Name | ast.Attribute, targets: set[str], bases: set[int], followed: set[int]
) -> str | None:
    """Return the import machinery that node reaches without a call, if it reaches any."""
    return min(
        (
            item
            for item in targets
            if (item in ESCAPES and id(node) not in bases | followed)
            or (
                "." in item
                and item.rsplit(".", 1)[0] in ESCAPES
                and item.rsplit(".", 1)[1].startswith("__")
            )
        ),
        default=None,
    )


def call_findings(
    call: ast.Call, target: str, path: str, lines: list[str], restrictions: list[tuple[str, str]]
) -> list[Diagnostic]:
    """Check one call of a dynamic import function against the forbidden modules."""
    argument = (
        call.args[0]
        if call.args
        else next((item.value for item in call.keywords if item.arg == "name"), None)
    )
    position = (call.lineno, column_of(lines, call))
    if (
        isinstance(argument, ast.Constant)
        and type(argument.value) is str
        and not argument.value.startswith(".")
    ):
        return [
            diagnostic(
                "import",
                path,
                f"Dynamic import of {module} is forbidden: {reason}",
                "violation",
                position,
            )
            for module, reason in restrictions
            if argument.value == module or argument.value.startswith(module + ".")
        ]
    return [
        diagnostic(
            "import",
            path,
            f"{target} needs a literal absolute module name; "
            "its import boundary cannot be checked.",
            position=position,
        )
    ]


def dynamic_findings(
    tree: ast.Module,
    source: str,
    path: str,
    restrictions: list[tuple[str, str]],
    scopes: Scopes,
) -> list[Diagnostic]:
    """Find dynamic imports the adapter cannot follow, and literal ones it can check."""
    lines, findings = source.splitlines(), []
    calls = {id(node.func): node for node in ast.walk(tree) if isinstance(node, ast.Call)}
    bases = {id(node.value) for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    for scope, names in scopes.bindings.items():
        if isinstance(scope, ast.ClassDef) and any(
            target and target.split(".")[0] in ESCAPES
            for targets in names.values()
            for target in targets
        ):
            findings.append(
                diagnostic(
                    "import",
                    path,
                    "Import machinery bound in a class body cannot be followed; "
                    "import it at module or function level.",
                    position=(scope.lineno, column_of(lines, scope)),
                )
            )
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Name, ast.Attribute)) or not isinstance(node.ctx, ast.Load):
            continue
        targets = scopes.targets(node)
        target = min(targets & DYNAMIC, default=None)
        if target is None:
            # the module handed elsewhere, or reached through its internals, can import anything
            escaped = escaped_name(node, targets, bases, scopes.followed)
            if escaped:
                findings.append(
                    diagnostic(
                        "import",
                        path,
                        f"Reference to {escaped} cannot be followed; "
                        "call importlib.import_module with a literal module name.",
                        position=(node.lineno, column_of(lines, node)),
                    )
                )
            continue
        call = calls.get(id(node))
        if call is None:
            findings.append(
                diagnostic(
                    "import",
                    path,
                    f"Dynamic import reference {target} cannot be checked; "
                    "call it with a literal module name.",
                    position=(node.lineno, column_of(lines, node)),
                )
            )
            continue
        findings.extend(call_findings(call, target, path, lines, restrictions))
    return findings


def skip_findings(tree: ast.Module, source: str, path: str, scopes: Scopes) -> list[Diagnostic]:
    """Find test code that skips, xfails or expects failure."""
    lines, findings = source.splitlines(), []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Name, ast.Attribute)):
            continue
        target = min(scopes.targets(node) & SKIPS, default=None)
        skipped = target or (
            "skipTest" if isinstance(node, ast.Attribute) and node.attr == "skipTest" else None
        )
        if skipped:
            findings.append(
                diagnostic(
                    "skip",
                    path,
                    f"{skipped} disables or expects failure in a test; "
                    "fix or remove the test instead.",
                    "violation",
                    (node.lineno, column_of(lines, node)),
                )
            )
    return findings


def constant_container(node: ast.Tuple | ast.List | ast.Set | ast.Dict | ast.JoinedStr) -> bool:
    """Return True when every element of a container or f-string is constant."""
    if isinstance(node, ast.Dict):
        return all(
            key is not None and constant(key) and constant(value)
            for key, value in zip(node.keys, node.values, strict=True)
        )
    if isinstance(node, ast.JoinedStr):
        return all(isinstance(item, ast.Constant) for item in node.values)
    return all(constant(item) for item in node.elts)


def constant_operation(node: ast.expr) -> bool:
    """Return True when an operator's operands are all constant."""
    if isinstance(node, ast.UnaryOp):
        return constant(node.operand)
    if isinstance(node, ast.BinOp):
        return constant(node.left) and constant(node.right)
    if isinstance(node, ast.Compare):
        return all(constant(item) for item in [node.left, *node.comparators])
    if isinstance(node, ast.BoolOp):
        return all(constant(item) for item in node.values)
    if isinstance(node, ast.IfExp):
        return constant(node.body) and constant(node.orelse)
    return False


def constant(node: ast.expr) -> bool:
    """Return True when the expression cannot depend on the code under test."""
    if isinstance(node, (ast.Constant, ast.Lambda)):
        return True
    if isinstance(node, (ast.Tuple, ast.List, ast.Set, ast.Dict, ast.JoinedStr)):
        return constant_container(node)
    return constant_operation(node)


def container_truthy(node: ast.Tuple | ast.List | ast.Set | ast.Dict) -> bool:
    """Return True when a display of this kind is never empty."""
    if isinstance(node, ast.Dict):
        return any(key is not None for key in node.keys)
    return bool(node.elts)


def always_true(node: ast.expr) -> bool:
    """Return True when the expression is truthy whatever the code under test does."""
    if isinstance(node, ast.Constant):
        return bool(node.value)
    if isinstance(node, (ast.Tuple, ast.List, ast.Set, ast.Dict)):
        return container_truthy(node)
    if isinstance(node, ast.Lambda):
        return True
    if isinstance(node, ast.BoolOp):
        results = [always_true(item) for item in node.values]
        return any(results) if isinstance(node.op, ast.Or) else all(results)
    if isinstance(node, ast.IfExp):
        return always_true(node.body) and always_true(node.orelse)
    return False


def trivial(node: ast.expr) -> bool:
    """Return True when an expression proves nothing about the code under test."""
    return constant(node) or always_true(node)


def real_call(call: ast.Call, receiver: str | None, scopes: Scopes) -> bool:
    """Return True for a call that can fail the test, such as pytest.raises or self.assertEqual."""
    if scopes.targets(call.func) & ASSERTS:
        return True
    if not isinstance(call.func, ast.Attribute):
        return False
    name = call.func.attr
    on_self = (
        receiver is not None
        and isinstance(call.func.value, ast.Name)
        and call.func.value.id == receiver
    )
    if on_self and name == "fail":
        return True
    if on_self and UNITTEST_ASSERT.fullmatch(name):
        arguments = [*call.args, *(item.value for item in call.keywords)]
        return not (arguments and all(trivial(item) for item in arguments))
    return name.startswith("assert_called") or name in MOCK_ASSERTS


def asserts_in(
    function: ast.FunctionDef | ast.AsyncFunctionDef, receiver: str | None, scopes: Scopes
) -> bool:
    """Return True when the test body contains an assertion that can fail."""
    # statements after an unconditional top-level return or raise never run
    body: list[ast.stmt] = []
    for statement in function.body:
        body.append(statement)
        if isinstance(statement, (ast.Return, ast.Raise)):
            break
    pending: list[ast.AST] = list(body)
    while pending:
        node = pending.pop()
        if isinstance(node, ast.Assert) and not trivial(node.test):
            return True
        if isinstance(node, ast.Call) and real_call(node, receiver, scopes):
            return True
        # nested functions, classes and lambdas are not the test body, so their asserts never count
        if not isinstance(node, NESTED):
            pending.extend(ast.iter_child_nodes(node))
    return False


def assertion_findings(
    tree: ast.Module, source: str, path: str, scopes: Scopes
) -> list[Diagnostic]:
    """Find test functions that contain no assertion that can fail."""
    lines, findings = source.splitlines(), []
    for node in ast.walk(tree):
        owner = scopes.parent.get(node)
        if not isinstance(
            node, (ast.FunctionDef, ast.AsyncFunctionDef)
        ) or not node.name.startswith("test_"):
            continue
        if owner is not tree and not isinstance(owner, ast.ClassDef):
            continue
        arguments = node.args.posonlyargs + node.args.args
        receiver = arguments[0].arg if owner is not tree and arguments else None
        if not asserts_in(node, receiver, scopes):
            findings.append(
                diagnostic(
                    "assertion",
                    path,
                    f"Test {node.name} asserts nothing; call assert, pytest.raises/warns/fail, "
                    "self.assert* or a mock assert_* method in it.",
                    "violation",
                    (node.lineno, column_of(lines, node)),
                )
            )
    return findings


def except_findings(tree: ast.Module, source: str, path: str) -> list[Diagnostic]:
    """Find bare and silently discarding exception handlers."""
    lines, findings = source.splitlines(), []
    for node in ast.walk(tree):
        if not isinstance(node, TRY):
            continue
        for handler in node.handlers:
            silent = all(
                isinstance(item, ast.Pass)
                or (
                    isinstance(item, ast.Expr)
                    and isinstance(item.value, ast.Constant)
                    and item.value.value is Ellipsis
                )
                for item in handler.body
            )
            if handler.type is None:
                message = "Bare except hides every error, including interrupts; name the exception."
            elif silent:
                message = (
                    "Exception handler discards the error with pass or ...; handle it or re-raise."
                )
            else:
                continue
            findings.append(
                diagnostic(
                    "except",
                    path,
                    message,
                    "violation",
                    (handler.lineno, column_of(lines, handler)),
                )
            )
    return findings


def import_findings(
    tree: ast.Module,
    source: str,
    path: str,
    project_root: str,
    restrictions: list[tuple[str, str]],
) -> list[Diagnostic]:
    """Find imports of forbidden modules, including relative and wildcard imports."""
    findings: list[Diagnostic] = []
    local = path if project_root == "." else path[len(project_root) + 1 :]
    package = local.split("/")[:-1]
    lines = source.splitlines()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        column = column_of(lines, node)
        if isinstance(node, ast.Import):
            names, base, star = [alias.name for alias in node.names], "", False
        else:
            if node.level > len(package) + 1:
                findings.append(
                    diagnostic(
                        "import",
                        path,
                        "Relative import escapes the declared project namespace; "
                        "its import policy cannot be checked.",
                        position=(node.lineno, column),
                    )
                )
                continue
            prefix = package[: len(package) - node.level + 1] if node.level else []
            base = ".".join(prefix + ([node.module] if node.module else []))
            names = ([base] if base else []) + [
                ".".join(filter(None, (base, alias.name)))
                for alias in node.names
                if alias.name != "*"
            ]
            star = any(alias.name == "*" for alias in node.names)
        for module, reason in restrictions:
            if any(name == module or name.startswith(module + ".") for name in names):
                findings.append(
                    diagnostic(
                        "import",
                        path,
                        f"Import of {module} is forbidden: {reason}",
                        "violation",
                        (node.lineno, column),
                    )
                )
            elif star and (not base or module.startswith(base + ".")):
                findings.append(
                    diagnostic(
                        "import",
                        path,
                        f"Wildcard import may select forbidden {module}; "
                        "use explicit imports to check this boundary.",
                        position=(node.lineno, column),
                    )
                )
    return findings


def directive_findings(tokens: list[tokenize.TokenInfo], path: str) -> list[Diagnostic]:
    """Find comments that carry a protected suppression directive."""
    return [
        diagnostic(
            "directive",
            path,
            "Protected suppression directive: " + token.string,
            "violation",
            (token.start[0], token.start[1] + 1),
        )
        for token in tokens
        if token.type == tokenize.COMMENT and DIRECTIVE.search(token.string[1:])
    ]


def policy_findings(
    tree: ast.Module,
    source: str,
    path: str,
    project_root: str,
    restrictions: list[tuple[str, str]],
) -> list[Diagnostic]:
    """Run the except, test and import policies over one parsed module."""
    findings = except_findings(tree, source, path)
    scopes = Scopes(tree)
    if TEST_FILE.search(path):
        findings.extend(skip_findings(tree, source, path, scopes))
        findings.extend(assertion_findings(tree, source, path, scopes))
    if restrictions:
        findings.extend(import_findings(tree, source, path, project_root, restrictions))
        findings.extend(dynamic_findings(tree, source, path, restrictions, scopes))
    return findings


def parse_module(raw: bytes, path: str) -> tuple[str, list[tokenize.TokenInfo], ast.Module]:
    """Return the decoded text, tokens and syntax tree of one source, raising on failure."""
    encoding, _ = tokenize.detect_encoding(io.BytesIO(raw).readline)
    source = raw.decode(encoding)
    tokens = list(tokenize.tokenize(io.BytesIO(raw).readline))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", SyntaxWarning)
        warnings.simplefilter("ignore", DeprecationWarning)
        tree = ast.parse(raw, filename=path, mode="exec")
        compile(tree, path, "exec", dont_inherit=True, optimize=0)
    return source, tokens, tree


def syntax_diagnostic(path: str, error: Exception) -> Diagnostic:
    """Return the incomplete diagnostic for a source that does not parse."""
    line, column = getattr(error, "lineno", None), getattr(error, "offset", None)
    if isinstance(error, tokenize.TokenError):
        line, column = error.args[1][0], error.args[1][1] + 1
    message = f"{getattr(error, 'msg', str(error))}; structural policy inspection is incomplete."
    return diagnostic("syntax", path, message, position=(line, column))


def check(request: object) -> dict[str, object]:
    """Check every selected source and return the protocol response."""
    root, project_root, restrictions, selected, action = validate(request)
    if action == "doctor":
        return response()
    diagnostics: list[Diagnostic] = []
    inputs: list[Source] = []
    coverage: dict[str, list[str]] = {capability: [] for capability in CAPABILITIES}
    for path, expected in sorted(selected.items(), key=lambda item: item[0]):
        actual: str | None = None
        try:
            raw = read_source(root, path)
            actual = sha256(raw)
            require(actual == expected, "Source hash differs from the requested input")
        except (OSError, ValueError) as error:
            diagnostics.append(diagnostic("input", path, str(error)))
            inputs.append({"path": path, "sha256": actual})
            continue
        inputs.append({"path": path, "sha256": actual})
        coverage["syntax"].append(path)
        try:
            source, tokens, tree = parse_module(raw, path)
        except (
            SyntaxError,
            UnicodeError,
            LookupError,
            tokenize.TokenError,
            ValueError,
            RecursionError,
        ) as error:
            diagnostics.append(syntax_diagnostic(path, error))
            continue
        coverage["policy"].append(path)
        diagnostics.extend(directive_findings(tokens, path))
        diagnostics.extend(policy_findings(tree, source, path, project_root, restrictions))
    for item in inputs:
        try:
            current: str | None = sha256(read_source(root, item["path"]))
        except (OSError, ValueError):
            current = None
        if current != item["sha256"]:
            diagnostics.append(
                diagnostic(
                    "input",
                    item["path"],
                    "Source changed during the check; rerun against stable inputs.",
                )
            )
    diagnostics.sort(
        key=lambda item: (
            item["path"],
            item.get("line", 0),
            item.get("column", 0),
            item["rule"],
            item["message"],
        )
    )
    return response(
        diagnostics,
        [{"capability": name, "files": files} for name, files in coverage.items()],
        inputs,
    )


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Build a JSON object, refusing duplicate fields."""
    result: dict[str, object] = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON object field")
        result[key] = value
    return result


def main() -> int:
    """Answer the one command in this process and return its exit code."""
    path = "."
    try:
        require(sys.version_info >= (3, 10), "Python 3.10 or newer is required")
        require(sys.flags.isolated and sys.flags.no_site, "Launch the adapter with Python -I -S")
        if sys.argv[1:] == ["--manifest"]:
            sys.stdout.write(json.dumps(manifest(), indent=2) + "\n")
            return 0
        require(not sys.argv[1:], "Unsupported adapter arguments")
        raw = sys.stdin.buffer.read(LIMIT + 1)
        require(len(raw) <= LIMIT, "Request exceeds the 16 MiB adapter limit")
        request: object = json.loads(
            raw.decode("utf8"),
            object_pairs_hook=unique_object,
            parse_constant=lambda value: fail("Invalid JSON constant " + value),
        )
        if isinstance(request, dict):
            project = request.get("project")
            if isinstance(project, dict):
                path = relative_name(project.get("root"), allow_dot=True)
        result = check(request)
    except (OSError, ValueError, TypeError, RecursionError) as error:
        result = response([diagnostic("protocol", path, str(error))])
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return EXIT_CODES[str(result["status"])]


if __name__ == "__main__":
    sys.exit(main())
