# Architecture

Plumb has a dependency-free core and optional engines.

| Part            | Location               | Responsibility                                                        |
| --------------- | ---------------------- | --------------------------------------------------------------------- |
| CLI             | `bin/`, `src/cli.ts`   | argument validation, discovery and reports                            |
| Engine          | `src/engine.ts`        | inventory, policy loading, the execution plan and diagnostic ordering |
| Core checks     | `src/*.ts`             | files, docs, comments, formatting, commits, hooks, ratchet, assets    |
| JavaScript pack | `packages/javascript/` | ESLint, TypeScript Programs, Prettier and Knip with pinned versions   |
| Python adapter  | `packages/python/`     | standard-library `ast` checks over a JSON protocol                    |
| Native adapters | `src/native.ts`        | RuboCop, clang-format and clang-tidy                                  |

A check returns diagnostics; it never edits files. `fix` and `sync` are the only writers, and they skip protected policy files. Each core module exports its `RULES`, so `plumb inspect` and `plumb explain` list every rule.
