"""Plumb's adapter SDK for Python: one dependency-free file for the external adapter protocol."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path, PureWindowsPath
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

PROTOCOL = 1
EXIT = {"pass": 0, "violation": 1, "incomplete": 2}


class _RuleFields(TypedDict):
    id: str
    description: str
    remedy: str
    suppressible: bool


class Rule(_RuleFields, total=False):
    """One rule an adapter declares; its capability defaults to the first capability."""

    capability: str


class _DefinitionFields(TypedDict):
    id: str
    version: str
    files: list[str]
    capabilities: list[str]
    rules: list[Rule]
    check: Callable[[dict[str, str], dict[str, object]], Iterable[dict[str, object]]]


class Definition(_DefinitionFields, total=False):
    """An adapter: its identity, rules, options schema and the check that finds violations."""

    optionsSchema: dict[str, object]


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _read(path: Path) -> bytes:
    with path.open("rb") as stream:
        return stream.read()


# every adapter reports unreadable input and a malformed request under these two rules
def _rules(definition: Definition) -> list[Rule]:
    return [
        {
            "id": "input",
            "description": "Every selected source has the expected bytes and remains readable.",
            "remedy": "Restore the selected input and rerun the complete check.",
            "suppressible": False,
        },
        {
            "id": "protocol",
            "description": "Requests use the supported protocol, identity and options.",
            "remedy": "Correct the adapter request or installation.",
            "suppressible": False,
        },
        *definition["rules"],
    ]


def manifest(definition: Definition, script: str) -> dict[str, object]:
    """Return the registry entry: the interpreter, the script and this SDK, pinned by hash."""
    interpreter, script, sdk = (
        os.path.realpath(path) for path in (sys.executable, script, __file__)
    )
    return {
        "schemaVersion": 1,
        "adapters": [
            {
                "id": definition["id"],
                "version": definition["version"],
                "files": definition["files"],
                "capabilities": definition["capabilities"],
                # isolated from the environment and site-packages, and -B leaves no bytecode
                "command": [interpreter, "-I", "-S", "-B", script],
                "integrity": [
                    {"path": path, "sha256": _sha256(_read(Path(path)))}
                    for path in (interpreter, script, sdk)
                ],
                "environment": [],
                "rules": [
                    {
                        **rule,
                        "id": definition["id"] + "/" + rule["id"],
                        "capability": rule.get("capability", definition["capabilities"][0]),
                    }
                    for rule in _rules(definition)
                ],
                "optionsSchema": definition.get(
                    "optionsSchema", {"type": "object", "additionalProperties": False}
                ),
            }
        ],
    }


def _reply(
    definition: Definition,
    diagnostics: list[dict[str, object]],
    covered: list[str],
    inputs: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "schemaVersion": PROTOCOL,
        "adapter": definition["id"],
        "version": definition["version"],
        "status": "incomplete"
        if any(item.get("status") == "incomplete" for item in diagnostics)
        else "violation"
        if diagnostics
        else "pass",
        "diagnostics": diagnostics,
        "coverage": [
            {"capability": capability, "files": covered}
            for capability in definition["capabilities"]
        ]
        if covered
        else [],
        "inputs": inputs,
    }


def _incomplete(definition: Definition, rule: str, path: str, message: str) -> dict[str, object]:
    return {
        "rule": definition["id"] + "/" + rule,
        "path": path,
        "message": message,
        "status": "incomplete",
    }


def _refuse(definition: Definition, message: str) -> dict[str, object]:
    return _reply(definition, [_incomplete(definition, "protocol", ".", message)], [], [])


def _envelope(
    definition: Definition, request: dict[str, object]
) -> tuple[str, list[object]] | None:
    """Return the root and files of a request that names this protocol, adapter and version."""
    root, files = request.get("root"), request.get("files")
    if (
        request.get("schemaVersion") != PROTOCOL
        # in Python True equals 1, and it is not a protocol version
        or request.get("schemaVersion") is True
        or request.get("adapter") != definition["id"]
        or request.get("version") != definition["version"]
        or not isinstance(root, str)
        or not isinstance(files, list)
    ):
        return None
    return root, files


def _relative(value: object) -> str | None:
    """Return value when it is a repository-relative path that cannot leave the repository."""
    if (
        isinstance(value, str)
        # a root or a drive in either path syntax, whatever platform this runs on
        and not value.startswith("/")
        and not PureWindowsPath(value).anchor
        and ".." not in re.split(r"[\\/]", value)
    ):
        return value
    return None


def _finding(
    definition: Definition, known: set[str], finding: dict[str, object], path: str
) -> dict[str, object]:
    if finding["rule"] not in known:
        message = "The adapter reported the undeclared rule " + str(finding["rule"])
        raise ValueError(message)
    return {**finding, "rule": definition["id"] + "/" + str(finding["rule"]), "path": path}


def _check_source(
    definition: Definition,
    options: dict[str, object],
    path: str,
    data: bytes,
    diagnostics: list[dict[str, object]],
) -> bool:
    """Run the adapter's check over one source; return True when the source was covered."""
    known = {rule["id"] for rule in _rules(definition)}
    try:
        source = {"path": path, "text": data.decode("utf-8-sig")}
        # extend appends each finding as it is produced, so a failure keeps the findings before it
        diagnostics.extend(
            _finding(definition, known, finding, path)
            for finding in definition["check"](source, options)
        )
    except Exception as error:
        message = "The source cannot be checked: " + str(error)
        diagnostics.append(_incomplete(definition, "input", path, message))
        return False
    return True


def respond(definition: Definition, request: object) -> dict[str, object]:
    """Answer one protocol request; anything the adapter cannot verify is incomplete, not a pass."""
    if not isinstance(request, dict):
        return _refuse(definition, "Unsupported protocol, adapter identity or version.")
    fields: dict[str, object] = request
    envelope = _envelope(definition, fields)
    if envelope is None:
        return _refuse(definition, "Unsupported protocol, adapter identity or version.")
    root, files = envelope
    if fields.get("action") == "doctor":
        return _reply(definition, [], [], [])
    if fields.get("action") != "check":
        return _refuse(definition, "Unsupported action.")
    project = fields.get("project")
    options = project.get("options") if isinstance(project, dict) else None
    check_options: dict[str, object] = options if isinstance(options, dict) else {}
    diagnostics: list[dict[str, object]] = []
    covered: list[str] = []
    inputs: list[dict[str, object]] = []
    for file in files:
        entry: dict[str, object] = file if isinstance(file, dict) else {}
        path = _relative(entry.get("path"))
        if path is None:
            return _refuse(definition, "A selected file is not a repository-relative path.")
        try:
            data = _read(Path(root, path))
        except (OSError, ValueError) as error:
            inputs.append({"path": path, "sha256": None})
            message = "Cannot read the source: " + str(error)
            diagnostics.append(_incomplete(definition, "input", path, message))
            continue
        actual = _sha256(data)
        inputs.append({"path": path, "sha256": actual})
        if entry.get("sha256") != actual:
            message = "Source hash differs from the requested input."
            diagnostics.append(_incomplete(definition, "input", path, message))
            continue
        if _check_source(definition, check_options, path, data, diagnostics):
            covered.append(path)
    return _reply(definition, diagnostics, covered, inputs)


def serve(definition: Definition, script: str, argv: list[str] | None = None) -> None:
    """Handle the command line: --manifest prints the registry, else one request is answered."""
    if "--manifest" in (sys.argv[1:] if argv is None else argv):
        sys.stdout.write(json.dumps(manifest(definition, script), indent=2) + "\n")
        return
    request: object = None
    try:
        request = json.loads(sys.stdin.buffer.read())
    except Exception:
        # an unreadable request is answered as a refused one
        request = None
    response = respond(definition, request)
    sys.stdout.write(json.dumps(response) + "\n")
    sys.exit(EXIT[str(response["status"])])
