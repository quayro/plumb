# Policy and exceptions

`plumb.json` is data only. It is validated against [plumb.schema.json](../../plumb.schema.json) before any check runs.

## Presets

`ozmikhail` is the strict default: required `AGENTS.md`, coverage of every recognized source file, documentation checks and task markers. `portable` enables only what the policy declares.

## Guarantees and conventions

Every rule is one of two kinds, shown as `kind` by `plumb inspect` and `plumb explain`.

| Kind         | Meaning                                                                                                            | Exceptions |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ---------- |
| `guarantee`  | enforcement itself: an invalid policy, a missing tool, an empty scope, a failed suite, a weakened or nested policy | never      |
| `convention` | a choice the policy makes: names, formatting, boundaries, comments, custom rules                                   | budgeted   |

A guarantee holds whatever the policy says, so no exception, bundle or baseline can relax it. A convention is the policy's to choose, and an existing violation of one can be budgeted while it is fixed.

## Exclusions and exceptions

- An `exclude` entry removes files from every check and needs a reason. Use it for vendored or generated code only.
- An `exceptions` entry admits a bounded number of diagnostics for exact rule ids and files, with a reason and an optional expiry. An unused, over-budget or expired exception fails. Rules marked not suppressible cannot be excepted.
- `plumb baseline` prints one such entry per rule for the violations a repository has today, so a new policy can be adopted without fixing everything first. It writes nothing: review the entries, replace the reason, and add them to `exceptions`. What an exception cannot suppress stays a diagnostic.
- Source comments cannot disable a rule.

The [policy ratchet](../guides/policy-ratchet.md) refuses any of these that widen between a base revision and the change.
