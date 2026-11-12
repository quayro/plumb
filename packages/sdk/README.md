# Adapter SDK

The SDK speaks Plumb's external adapter protocol, version 1, as one dependency-free file per language. Copy the file beside your adapter; each needs only its language's standard library.

| File         | Runtime              | The registry pins                    |
| ------------ | -------------------- | ------------------------------------ |
| `adapter.ts` | Node 22.18 or newer  | Node, your script and the SDK file   |
| `adapter.py` | Python 3.10 or newer | Python, your script and the SDK file |
| `adapter.rs` | Rust 1.88 or newer   | the compiled adapter                 |

The three keep one contract, proved by the same tests: the guarantees below hold for each.

## API

| Export                         | Purpose                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| `serve(definition, script)`    | the whole command line: `--manifest`, or one request and one response |
| `respond(definition, request)` | answers one request as a value, for tests                             |
| `manifest(definition, script)` | the registry entry, with the runtime, the script and the SDK pinned   |
| `PROTOCOL`                     | the protocol version this file implements                             |

A definition is `id`, `version`, the `files` globs, `capabilities`, `rules` and `check`. `check` receives one source as `{ path, text }` with the project's validated options and returns findings: `{ rule, message }` with an optional `line`, `column` and `status: "incomplete"`. A rule id is written bare and reported as `ID/rule`.

## Guarantees

- A source is read from the request's `root` and checked only when its bytes match the requested hash. A mismatch, a missing file, invalid UTF-8, an exception from `check` or an undeclared rule is `ID/input`, incomplete.
- A request with another protocol version, adapter id, adapter version or action, or with a path that is absolute, starts with a drive letter or a backslash, or leaves the repository, is `ID/protocol`, incomplete.
- A file is listed under `coverage` only when it was completely checked.
- The exit code is 0 for pass, 1 for violation and 2 for incomplete.

See the [adapters guide](../../docs/guides/adapters.md) for the protocol, the sandbox and the conformance probes.

## Python

`adapter.py` exports `serve`, `respond`, `manifest` and `PROTOCOL` with the same meaning. A definition is a `dict` with the keys above, and a finding is a `dict`:

```python
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parent / "sdk"))
from adapter import serve


def check(file, options):
    return [
        {"rule": "marker", "message": "Task marker.", "line": number}
        for number, line in enumerate(file["text"].split("\n"), 1)
        if "TODO" in line
    ]


serve(
    {
        "id": "todo",
        "version": "1.0.0",
        "files": ["**/*.txt"],
        "capabilities": ["policy"],
        "rules": [{"id": "marker", "description": "No task markers.", "remedy": "Finish the task."}],
        "check": check,
    },
    __file__,
)
```

`python3 -I -S todo.py --manifest > registry.json` prints the registry entry. Its command is `python -I -S -B`: isolated from the environment and from site-packages, and writing no bytecode beside the pinned files. Because `-I` keeps the script's folder off the module path, the adapter names the SDK's folder itself, as above. The pins cover the interpreter binary, the script and the SDK file, not the interpreter's standard library.

## Rust

`adapter.rs` is a module of your binary crate. `Adapter` holds the definition, `check` returns `Result<Vec<Finding>, String>` where `Err` is a source that cannot be checked, and the project options arrive as a `Json` value:

```rust
mod adapter;

use adapter::{Adapter, Finding, Json, Rule};

fn check(_path: &str, text: &str, _options: &Json) -> Result<Vec<Finding>, String> {
    Ok(text
        .lines()
        .zip(1..)
        .filter(|(line, _)| line.contains("TODO"))
        .map(|(_, number)| Finding {
            rule: "marker",
            message: "Task marker.".into(),
            line: Some(number),
            ..Finding::default()
        })
        .collect())
}

fn main() -> std::process::ExitCode {
    adapter::serve(&Adapter {
        id: "todo",
        version: "1.0.0",
        files: &["**/*.txt"],
        capabilities: &["policy"],
        rules: &[Rule {
            id: "marker",
            description: "No task markers.",
            remedy: "Finish the task.",
            ..Rule::default()
        }],
        options_schema: None,
        check,
    })
}
```

`./todo --manifest > registry.json` prints the registry entry, which pins the compiled binary: the SDK is part of it. `options_schema` is the JSON Schema of the project options as JSON text. A finding with `incomplete: true` is reported incomplete. A panic in `check` ends the process without a response, which the core reports as incomplete for the whole project; return `Err` to keep the other files' results.

## Testing

```sh
node scripts/test.ts adapters
node scripts/test.ts native
```

The first runs the TypeScript and Python SDKs; the second compiles an adapter on the Rust SDK with `rustc`.
