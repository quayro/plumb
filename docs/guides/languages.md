# Language profiles

A project's `profile` names the language Plumb checks it as. Plumb supports three families: TypeScript and JavaScript, Python, and Rust.

| Profile               | Sources         | Format      | Lint         | Types        | Source policy                       |
| --------------------- | --------------- | ----------- | ------------ | ------------ | ----------------------------------- |
| `typescript`, `react` | `.ts`, `.js`, … | Prettier    | ESLint, Knip | TypeScript   | [JavaScript pack][javascript]       |
| `python`              | `.py`, `.pyi`   | ruff format | ruff         | mypy         | [Python adapter][python], if listed |
| `rust`                | `.rs`           | rustfmt     | clippy       | cargo clippy | [Rust adapter][rust], if listed     |

[javascript]: ../../packages/javascript/README.md
[python]: ../../packages/python/README.md
[rust]: ../../packages/rust/README.md

The JavaScript pack ships its tools as pinned dependencies. Python and Rust use the tools installed on `PATH`: each launcher is located outside the repository and pinned by hash for the run, a missing tool is `tools.missing`, and a version other than the one in `tools.versions` is `tools.version`. Both are incomplete.

```json
{
  "projects": [
    { "root": "service", "profile": "python" },
    { "root": "engine", "profile": "rust" }
  ],
  "tools": {
    "versions": {
      "ruff": "0.17.4",
      "mypy": "2.4.1",
      "rustfmt": "1.10.0-stable",
      "clippy": "0.1.99"
    }
  }
}
```

`plumb sync` writes each project's tool policy into its root, and `plumb check` reports a copy that drifts. A profile takes no `options` of its own; `options` belong to the source-policy adapter of the same id, which runs beside the tools when the registry passed with `--adapters` lists it.

## Python

| Check           | Command                                                                      | Fix           |
| --------------- | ---------------------------------------------------------------------------- | ------------- |
| `python.format` | `ruff format --check --config ruff.toml --no-cache -- <files>`               | `ruff format` |
| `python.lint`   | `ruff check --no-fix --ignore-noqa --config ruff.toml --no-cache -- <files>` |               |
| `python.types`  | `mypy --config-file mypy.ini --cache-dir <null> -- <files>`                  |               |

- `ruff.toml` selects every ruff rule and turns off only those that contradict another rule or the formatter, each with its reason. `mypy.ini` is strict mode with modules named by path.
- The generated files are passed explicitly, so a `pyproject.toml`, a nested `ruff.toml` or a `setup.cfg` cannot loosen them.
- A `# noqa` comment suppresses nothing, and it is itself refused with every other [suppression comment](source-hygiene.md).
- Every selected file is passed to each tool by name. Source a tool cannot parse is incomplete for that tool.
- mypy resolves imports in the environment it is installed in: install it where the project's dependencies are.

## Rust

| Check         | Command                                                                                | Fix         |
| ------------- | -------------------------------------------------------------------------------------- | ----------- |
| `rust.format` | `cargo fmt --check -- --config-path rustfmt.toml --verbose`                            | `cargo fmt` |
| `rust.lint`   | `cargo clippy --frozen --all-targets --all-features --target-dir <tmp> -- -D warnings` |             |

- The project root is the package or workspace root: it holds `Cargo.toml`, and `Cargo.lock` must be current, because `--frozen` neither writes it nor reaches the network.
- rustfmt names each file it formats. A selected `.rs` file it never reaches, such as a module no target declares, is `native.scope`, incomplete: declare the module or exclude the file with a reason.
- clippy lints what cargo compiles, so `rust.lint` answers for the project and claims no file. Each compiler or clippy error, and each warning-level message, is a diagnostic with its path, line and lint name. Clippy compiles the project, so its build scripts and procedural macros run with the caller's permissions.
- A `[lints]` table that sets `allow`, and `rustflags` in `.cargo/config.toml` that allow, cap or force-warn lints, would switch findings off after `-D warnings`. Either is `native.scope`, incomplete. A `warn`, `deny` or `forbid` level is accepted: a warning is still denied. A compiler wrapper (`rustc-wrapper`, `rustc-workspace-wrapper`, `[build] rustc`) is refused, because it can swallow every lint, and so is a character escape (`\x`, `\u`, `\U`) in a manifest or cargo config, because it can spell one of these words.
- A project that is a member of an ancestor workspace is `native.scope`, incomplete: configure the workspace root as the project. A root package that is also a workspace runs `cargo clippy --workspace` and `cargo fmt --all`.
- Build output goes to a temporary folder outside the checkout, so a check leaves the repository untouched.

Suppression attributes such as `#[allow]`, `#[expect]` and `#[rustfmt::skip]`, forbidden paths and ignored tests are refused by the [Rust adapter][rust]. Without it the tools still honor those attributes.

## Limits

- `RUSTFLAGS`, a compiler wrapper in the environment and a cargo configuration outside the repository belong to the machine, like the tools themselves, and are not inspected.
- A `clippy.toml` changes lint thresholds; it is a protected file and changes only by review.
- Other languages are not checked. Under the `ozmikhail` preset a recognized source file that no project covers is `projects.unsupported`, incomplete, until it is excluded with a reason.
