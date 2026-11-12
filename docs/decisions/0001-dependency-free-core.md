# 0001 Dependency-free core

## Status

Accepted

## Context

Plumb is vendored into many repositories and must run before their dependencies are installed, including in hooks and minimal CI images.

## Decision

The core in `src/` and `bin/` imports only `node:` built-ins. Engines with dependencies — ESLint, TypeScript, Prettier, Knip, Python, ruff, mypy, cargo — live in packs or adapters with pinned versions, and a missing engine is reported as incomplete.

## Consequences

Core features such as commit checks, the policy ratchet and documentation rules are implemented by hand, without parsers from npm. Markdown support is deliberately limited to the subset Plumb checks.
