# Architecture

Plumb has a dependency-free core and optional engines.

| Part            | Location               | Responsibility                                                        |
| --------------- | ---------------------- | --------------------------------------------------------------------- |
| CLI             | `bin/`, `src/cli.ts`   | argument validation, discovery and reports                            |
| MCP server      | `src/mcp.ts`           | read-only check, plan, inspect and explain for agents over stdio      |
| Editor server   | `src/lsp.ts`           | check diagnostics over the Language Server Protocol                   |
| Engine          | `src/engine.ts`        | inventory, policy loading, the execution plan and diagnostic ordering |
| Core checks     | `src/*.ts`             | files, docs, comments, formatting, commits, hooks, ratchet, assets    |
| JavaScript pack | `packages/javascript/` | ESLint, TypeScript Programs, Prettier and Knip with pinned versions   |
| Python adapter  | `packages/python/`     | standard-library `ast` source policy over a JSON protocol             |
| Native profiles | `src/native.ts`        | ruff and mypy for Python, rustfmt and clippy for Rust                 |
| Adapter SDK     | `packages/sdk/`        | the adapter protocol in one file each for TypeScript, Python and Rust |
| Rust adapter    | `packages/rust/`       | tokenizer-based Rust source policy, built on the SDK                  |
| Policy packs    | `src/assets/pack-*`    | shipped policies that `init` copies and pins as bundles               |

A check returns diagnostics; it never edits files. `fix` and `sync` are the only writers, and they skip protected policy files. Each core module exports its `RULES`, so `plumb inspect` and `plumb explain` list every rule.
