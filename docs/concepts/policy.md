# Policy and exceptions

`plumb.json` is data only. It is validated against [plumb.schema.json](../../plumb.schema.json) before any check runs.

## Presets

`ozmikhail` is the strict default: required `AGENTS.md`, coverage of every recognized source file, documentation checks and task markers. `portable` enables only what the policy declares.

## Exclusions and exceptions

- An `exclude` entry removes files from every check and needs a reason. Use it for vendored or generated code only.
- An `exceptions` entry admits a bounded number of diagnostics for exact rule ids and files, with a reason and an optional expiry. An unused, over-budget or expired exception fails. Rules marked not suppressible cannot be excepted.
- Source comments cannot disable a rule.

The [policy ratchet](../guides/policy-ratchet.md) refuses any of these that widen between a base revision and the change.
