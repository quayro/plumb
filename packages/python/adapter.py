"""Plumb's optional, dependency-free Python syntax and structural policy adapter."""

import ast
import hashlib
import io
import json
import keyword
import os
from pathlib import Path
import re
import stat
import sys
import tokenize
import warnings

VERSION = "1.0.0"
PYTHON = ".".join(map(str, sys.version_info[:3]))
CAPABILITIES = ["syntax", "policy"]
LIMIT = 16 * 1024 * 1024
MODULE = r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*"
DIRECTIVE = re.compile(
    r"(?:^|#)\s*(?:(?:(?:ruff|flake8)\s*:\s*)?noqa\b|type\s*:\s*ignore\b|"
    r"fmt\s*:\s*(?:off|skip)\b|yapf\s*:\s*disable\b|isort\s*:\s*(?:off|skip(?:_file)?)\b|"
    r"autopep8\s*:\s*off\b|black\s*:\s*skip\b|pylint\s*:\s*(?:disable(?:-next)?|skip-file)\b|"
    r"pyright\s*:\s*ignore\b|mypy\s*:\s*ignore-errors\b|pragma\s*:\s*no\s*cover\b|nosec\b)", re.IGNORECASE
)
RULES = [
    ("syntax", "Python source parses and compiles without execution.", "Correct the Python syntax, then rerun all checks.", "syntax", False),
    ("input", "Every selected source has the expected bytes and remains readable.", "Restore the selected input and rerun the complete check.", "syntax", False),
    ("protocol", "Requests use the supported protocol and explicit options.", "Correct the adapter request or installation.", "syntax", False),
    ("directive", "Listed lint, type and formatting suppression directives are prohibited.", "Remove the suppression directive and correct the underlying source.", "policy", False),
    ("import", "Import statements respect declared module boundaries.", "Use an allowed import or review a scoped core policy exception.", "policy", True),
    ("except", "Exception handlers must not silently discard errors.", "Handle the specific exception or re-raise it.", "policy", False),
    ("skip", "Test files must not skip, xfail or disable tests.", "Fix the test or remove it from the suite.", "policy", False),
]
DYNAMIC = {"importlib.import_module", "__import__", "builtins.__import__", "__builtins__.__import__"}
ESCAPES = {"importlib", "builtins", "__builtins__"}
SKIPS = {"pytest.mark.skip", "pytest.mark.skipif", "pytest.mark.xfail", "pytest.skip", "pytest.xfail", "unittest.skip", "unittest.skipIf", "unittest.skipUnless"}
TEST_FILE = re.compile(r"(?:^|/)(?:test_[^/]*|[^/]*_test)\.py$")
TRY = (ast.Try, getattr(ast, "TryStar", ast.Try))
OPTIONS_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"forbiddenImports": {
        "type": "array", "uniqueItems": True, "items": {
            "type": "object", "additionalProperties": False, "required": ["module", "reason"],
            "properties": {"module": {"type": "string", "pattern": "^" + MODULE + "$"},
                           "reason": {"type": "string", "minLength": 1, "pattern": r"\S"}},
        },
    }},
}


class Invalid(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Invalid(message)


def shape(value, required, optional=()):
    require(type(value) is dict and set(required) <= value.keys()
            and value.keys() <= set(required) | set(optional), "Unexpected or missing object fields")


def relative_name(value, allow_dot=False):
    require(isinstance(value, str) and value and "\x00" not in value and "\\" not in value
            and not value.startswith("/") and not re.match(r"^[A-Za-z]:", value), "Expected a normalized repository-relative path")
    if value == "." and allow_dot:
        return value
    require(all(part not in ("", ".", "..", ".git", ".hg", ".svn", "node_modules") for part in value.split("/")),
            "Unsafe or non-normalized repository path")
    return value


def safe_path(root, name, directory=False):
    path = root
    for part in ([] if name == "." else name.split("/")):
        path = path / part
        require(not path.is_symlink(), "Symbolic links are not followed")
    mode = path.stat().st_mode
    require(stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode), "Expected a regular directory" if directory else "Expected a regular source file")
    require(path.resolve().is_relative_to(root), "Path escapes the repository")
    return path


def read_source(root, name):
    path = safe_path(root, name)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "Expected a regular source file")
        value = stream.read(LIMIT + 1)
    require(len(value) <= LIMIT, "Source exceeds the 16 MiB adapter limit")
    safe_path(root, name)
    return value


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def file_hash(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(65536), b""):
            value.update(block)
    return value.hexdigest()


def manifest():
    interpreter, script = str(Path(sys.executable).resolve()), str(Path(__file__).resolve())
    return {"schemaVersion": 1, "adapters": [{
        "id": "python", "version": VERSION, "files": ["**/*.py", "**/*.pyi"], "capabilities": CAPABILITIES,
        "command": [interpreter, "-I", "-S", script],
        "integrity": [{"path": path, "sha256": file_hash(path)} for path in (interpreter, script)],
        "environment": [], "inputs": [], "tools": {"python": PYTHON}, "optionsSchema": OPTIONS_SCHEMA,
        "rules": [{"id": "python/" + name, "description": description, "remedy": remedy,
                   "capability": capability, "suppressible": suppressible}
                  for name, description, remedy, capability, suppressible in RULES],
    }]}


def diagnostic(rule, path, message, status="incomplete", line=None, column=None):
    value = {"rule": "python/" + rule, "path": path, "message": message, "status": status}
    if type(line) is int and line > 0:
        value["line"] = line
    if type(column) is int and column > 0:
        value["column"] = column
    return value


def response(diagnostics=(), coverage=(), inputs=()):
    status = "incomplete" if any(item["status"] == "incomplete" for item in diagnostics) else "violation" if diagnostics else "pass"
    return {"schemaVersion": 1, "adapter": "python", "version": VERSION, "status": status,
            "diagnostics": list(diagnostics), "coverage": list(coverage), "inputs": list(inputs), "versions": {"python": PYTHON}}


def validate(request):
    shape(request, ("schemaVersion", "action", "adapter", "version", "root", "project", "files", "inputs", "capabilities"))
    require(type(request["schemaVersion"]) is int and request["schemaVersion"] == 1, "Unsupported protocol schemaVersion")
    require(request["adapter"] == "python" and request["version"] == VERSION, "Unsupported adapter identity or version")
    require(request["action"] in ("check", "doctor"), "Unsupported action")
    require(type(request["capabilities"]) is list and sorted(request["capabilities"]) == sorted(CAPABILITIES), "Request must declare syntax and policy capabilities exactly once")
    shape(request["project"], ("root", "profile"), ("options", "prepare"))
    project = request["project"]
    require(project["profile"] == "python", "Unsupported project profile")
    if "prepare" in project:
        commands = project["prepare"]
        require(type(commands) is list and commands and all(
            type(command) is list and command and all(isinstance(argument, str) and argument for argument in command)
            for command in commands), "prepare must contain nonempty command argument arrays")
    project_root = relative_name(project["root"], allow_dot=True)
    require(isinstance(request["root"], str) and "\x00" not in request["root"] and os.path.isabs(request["root"]), "Repository root must be absolute")
    root = Path(request["root"]).resolve(strict=True)
    require(root.is_dir(), "Repository root must be a directory")
    safe_path(root, project_root, directory=True)
    options = project.get("options", {})
    shape(options, (), ("forbiddenImports",))
    restrictions = options.get("forbiddenImports", [])
    require(type(restrictions) is list, "forbiddenImports must be an array")
    modules = set()
    for entry in restrictions:
        shape(entry, ("module", "reason"))
        module = entry["module"]
        require(isinstance(module, str) and re.fullmatch(MODULE, module)
                and not any(keyword.iskeyword(part) for part in module.split(".")), "Forbidden module must be a dotted Python identifier")
        require(module not in modules, "Duplicate forbidden module")
        modules.add(module)
        require(isinstance(entry["reason"], str) and entry["reason"].strip(), "Forbidden imports need a nonempty reason")
    observed = []
    for key in ("files", "inputs"):
        require(type(request[key]) is list and len(request[key]) <= 10000, "Input lists must contain at most 10000 files")
        values = {}
        for entry in request[key]:
            shape(entry, ("path", "sha256"))
            path = relative_name(entry["path"])
            require(path.endswith((".py", ".pyi")), "Only .py and .pyi source inputs are supported")
            require(project_root == "." or path.startswith(project_root + "/"), "Source is outside its project root")
            require(path not in values, "Duplicate source input")
            require(entry["sha256"] is None or isinstance(entry["sha256"], str)
                    and re.fullmatch(r"[a-f0-9]{64}", entry["sha256"]), "Input hashes must be SHA-256 or null")
            values[path] = entry["sha256"]
        observed.append(values)
    require(observed[0] == observed[1], "Input evidence must match the selected sources exactly")
    require(request["action"] == "doctor" or observed[0], "No Python source files were selected")
    return root, project_root, restrictions, observed[0]


def column_of(lines, node):
    return len(lines[node.lineno - 1].encode("utf8")[:node.col_offset].decode("utf8")) + 1
class Scopes:
    """Lexical name resolution: which import, if any, a name denotes at the place it is used."""

    def __init__(self, tree):
        self.module, self.bindings, self.parent, self.home, self.declared, self.stars = tree, {}, {}, {}, {}, []
        self.aliases, self.followed = [], set()
        stack = [(tree, tree)]
        while stack:
            node, scope = stack.pop()
            stack.extend(reversed(self.note(node, scope)))
        # a plain assignment passes its value's meaning on; chains longer than this stay unfollowed
        for _ in range(8):
            for scope, name, value in self.aliases:
                self.bindings[self.declared.get(scope, {}).get(name, scope)][name] |= self.targets(value)

    def bind(self, scope, name, target=None):
        scope = self.declared.get(scope, {}).get(name, scope)
        self.bindings.setdefault(scope, {}).setdefault(name, set()).add(target)

    def note(self, node, scope):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                self.bind(scope, alias.asname or root, alias.name if alias.asname else root)
            return []
        if isinstance(node, ast.ImportFrom):
            absolute = node.level == 0 and node.module
            for alias in node.names:
                if alias.name != "*":
                    self.bind(scope, alias.asname or alias.name, f"{node.module}.{alias.name}" if absolute else None)
                elif absolute:
                    self.stars.append(node.module)
            return []
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            owner = self.module
            if isinstance(node, ast.Nonlocal):
                owner = self.parent.get(scope, self.module)
                while isinstance(owner, ast.ClassDef):
                    owner = self.parent.get(owner, self.module)
            for name in node.names:
                self.declared.setdefault(scope, {})[name] = owner
            return []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            if not isinstance(node, ast.Lambda):
                self.bind(scope, node.name)
            self.parent[node] = scope
            body = {id(item) for item in (node.body if isinstance(node.body, list) else [node.body])}
            children = []
            for child in ast.iter_child_nodes(node):
                if isinstance(child, ast.arguments):
                    for item in ast.walk(child):
                        if isinstance(item, ast.arg):
                            self.bind(node, item.arg)
                # decorators, bases, defaults and annotations are evaluated in the enclosing scope
                children.append((child, node if id(child) in body else scope))
            return children
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr)) and isinstance(node.value, (ast.Name, ast.Attribute)):
            for target in getattr(node, "targets", None) or [node.target]:
                if isinstance(target, ast.Name):
                    self.aliases.append((scope, target.id, node.value))
                    self.followed.add(id(node.value))
        if isinstance(node, ast.Name):
            self.home[node] = scope
            if not isinstance(node.ctx, ast.Load):
                self.bind(scope, node.id)
        for name in (getattr(node, "name", None), getattr(node, "rest", None)):
            if isinstance(name, str):
                self.bind(scope, name)
        return [(child, scope) for child in ast.iter_child_nodes(node)]

    def targets(self, node):
        """Every dotted import path a name or attribute chain may denote; empty when it is not one."""
        parts = []
        while isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        if not isinstance(node, ast.Name) or node not in self.home:
            return set()
        scope, found, first = self.home[node], None, True
        while found is None:
            # a class body's names are invisible to the functions nested in it
            if (first or not isinstance(scope, ast.ClassDef)) and node.id in self.bindings.get(scope, {}):
                found = self.bindings[scope][node.id]
            elif scope is self.module:
                found = {node.id, *(f"{module}.{node.id}" for module in self.stars)}
            scope, first = self.parent.get(scope, self.module), False
        # a name rebound to an unknown value keeps its own meaning: a local called pytest is assumed to be pytest
        return {".".join([base or node.id, *reversed(parts)]) for base in found}


def dynamic_findings(tree, source, path, restrictions, scopes):
    lines, findings = source.splitlines(), []
    calls = {id(node.func): node for node in ast.walk(tree) if isinstance(node, ast.Call)}
    bases = {id(node.value) for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    for scope, names in scopes.bindings.items():
        if isinstance(scope, ast.ClassDef) and any(target and target.split(".")[0] in ESCAPES for targets in names.values() for target in targets):
            findings.append(diagnostic("import", path, "Import machinery bound in a class body cannot be followed; import it at module or function level.", line=scope.lineno, column=column_of(lines, scope)))
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Name, ast.Attribute)) or not isinstance(node.ctx, ast.Load):
            continue
        targets = scopes.targets(node)
        target = min(targets & DYNAMIC, default=None)
        if target is None:
            # the module itself handed elsewhere, or reached through its internals, can import anything
            escaped = min((item for item in targets if item in ESCAPES and id(node) not in bases | scopes.followed or "." in item and item.rsplit(".", 1)[0] in ESCAPES and item.rsplit(".", 1)[1].startswith("__")), default=None)
            if escaped:
                findings.append(diagnostic("import", path, f"Reference to {escaped} cannot be followed; call importlib.import_module with a literal module name.", line=node.lineno, column=column_of(lines, node)))
            continue
        call = calls.get(id(node))
        if call is None:
            findings.append(diagnostic("import", path, f"Dynamic import reference {target} cannot be checked; call it with a literal module name.", line=node.lineno, column=column_of(lines, node)))
            continue
        argument = call.args[0] if call.args else next((item.value for item in call.keywords if item.arg == "name"), None)
        if isinstance(argument, ast.Constant) and type(argument.value) is str and not argument.value.startswith("."):
            for entry in restrictions:
                module = entry["module"]
                if argument.value == module or argument.value.startswith(module + "."):
                    findings.append(diagnostic("import", path, f"Dynamic import of {module} is forbidden: {entry['reason']}", "violation", call.lineno, column_of(lines, call)))
        else:
            findings.append(diagnostic("import", path, f"{target} needs a literal absolute module name; its import boundary cannot be checked.", line=call.lineno, column=column_of(lines, call)))
    return findings
def skip_findings(tree, source, path, scopes):
    lines, findings = source.splitlines(), []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Name, ast.Attribute)):
            continue
        target = min(scopes.targets(node) & SKIPS, default=None)
        if target or isinstance(node, ast.Attribute) and node.attr == "skipTest":
            findings.append(diagnostic("skip", path, f"{target or node.attr} disables or expects failure in a test; fix or remove the test instead.", "violation", node.lineno, column_of(lines, node)))
    return findings
def except_findings(tree, source, path):
    lines, findings = source.splitlines(), []
    for node in ast.walk(tree):
        if not isinstance(node, TRY):
            continue
        for handler in node.handlers:
            silent = all(isinstance(item, ast.Pass) or isinstance(item, ast.Expr) and isinstance(item.value, ast.Constant) and item.value.value is Ellipsis for item in handler.body)
            if handler.type is None:
                message = "Bare except hides every error, including interrupts; name the exception."
            elif silent:
                message = "Exception handler discards the error with pass or ...; handle it or re-raise."
            else:
                continue
            findings.append(diagnostic("except", path, message, "violation", handler.lineno, column_of(lines, handler)))
    return findings
def import_findings(tree, source, path, project_root, restrictions):
    findings = []
    local = path if project_root == "." else path[len(project_root) + 1:]
    package = local.split("/")[:-1]
    lines = source.splitlines()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        column = len(lines[node.lineno - 1].encode("utf8")[:node.col_offset].decode("utf8")) + 1
        if isinstance(node, ast.Import):
            names, base, star = [alias.name for alias in node.names], "", False
        else:
            if node.level > len(package) + 1:
                findings.append(diagnostic("import", path, "Relative import escapes the declared project namespace; its import policy cannot be checked.", line=node.lineno, column=column))
                continue
            prefix = package[:len(package) - node.level + 1] if node.level else []
            base = ".".join(prefix + ([node.module] if node.module else []))
            names = ([base] if base else []) + [".".join(filter(None, (base, alias.name))) for alias in node.names if alias.name != "*"]
            star = any(alias.name == "*" for alias in node.names)
        for entry in restrictions:
            module = entry["module"]
            if any(name == module or name.startswith(module + ".") for name in names):
                findings.append(diagnostic("import", path, f"Import of {module} is forbidden: {entry['reason']}", "violation", node.lineno, column))
            elif star and (not base or module.startswith(base + ".")):
                findings.append(diagnostic("import", path, f"Wildcard import may select forbidden {module}; use explicit imports to check this boundary.", line=node.lineno, column=column))
    return findings


def check(request):
    root, project_root, restrictions, selected = validate(request)
    if request["action"] == "doctor":
        return response()
    diagnostics, inputs = [], []
    coverage = {capability: [] for capability in CAPABILITIES}
    for path, expected in sorted(selected.items()):
        actual = None
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
            encoding, _ = tokenize.detect_encoding(io.BytesIO(raw).readline)
            source = raw.decode(encoding)
            tokens = list(tokenize.tokenize(io.BytesIO(raw).readline))
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", SyntaxWarning)
                warnings.simplefilter("ignore", DeprecationWarning)
                tree = ast.parse(raw, filename=path, mode="exec")
                compile(tree, path, "exec", dont_inherit=True, optimize=0)
        except (SyntaxError, UnicodeError, LookupError, tokenize.TokenError, ValueError, RecursionError) as error:
            line, column = getattr(error, "lineno", None), getattr(error, "offset", None)
            if isinstance(error, tokenize.TokenError):
                line, column = error.args[1][0], error.args[1][1] + 1
            diagnostics.append(diagnostic("syntax", path, f"{getattr(error, 'msg', str(error))}; structural policy inspection is incomplete.", line=line, column=column))
            continue
        coverage["policy"].append(path)
        for token in tokens:
            if token.type == tokenize.COMMENT and DIRECTIVE.search(token.string[1:]):
                diagnostics.append(diagnostic("directive", path, "Protected suppression directive: " + token.string, "violation", token.start[0], token.start[1] + 1))
        diagnostics.extend(except_findings(tree, source, path))
        scopes = Scopes(tree)
        if TEST_FILE.search(path):
            diagnostics.extend(skip_findings(tree, source, path, scopes))
        if restrictions:
            diagnostics.extend(import_findings(tree, source, path, project_root, restrictions))
            diagnostics.extend(dynamic_findings(tree, source, path, restrictions, scopes))
    for item in inputs:
        try:
            current = sha256(read_source(root, item["path"]))
        except (OSError, ValueError):
            current = None
        if current != item["sha256"]:
            diagnostics.append(diagnostic("input", item["path"], "Source changed during the check; rerun against stable inputs."))
    diagnostics.sort(key=lambda item: (item["path"], item.get("line", 0), item.get("column", 0), item["rule"], item["message"]))
    return response(diagnostics, [{"capability": name, "files": files} for name, files in coverage.items()], inputs)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON object field")
        result[key] = value
    return result


def main():
    path = "."
    try:
        require(sys.version_info >= (3, 10), "Python 3.10 or newer is required")
        require(sys.flags.isolated and sys.flags.no_site, "Launch the adapter with Python -I -S")
        if sys.argv[1:] == ["--manifest"]:
            print(json.dumps(manifest(), indent=2))
            return 0
        require(not sys.argv[1:], "Unsupported adapter arguments")
        raw = sys.stdin.buffer.read(LIMIT + 1)
        require(len(raw) <= LIMIT, "Request exceeds the 16 MiB adapter limit")
        request = json.loads(raw.decode("utf8"), object_pairs_hook=unique_object,
                             parse_constant=lambda value: require(False, "Invalid JSON constant " + value))
        if isinstance(request, dict) and isinstance(request.get("project"), dict):
            path = relative_name(request["project"].get("root"), allow_dot=True)
        result = check(request)
    except (OSError, ValueError, TypeError, RecursionError) as error:
        result = response([diagnostic("protocol", path, str(error))])
    print(json.dumps(result, separators=(",", ":")))
    return {"pass": 0, "violation": 1, "incomplete": 2}[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
