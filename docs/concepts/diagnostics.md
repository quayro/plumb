# Diagnostics and statuses

Every diagnostic names a rule, a path, a message and a remedy. A run ends in one of three statuses.

| Status       | Exit | Meaning                                                                     |
| ------------ | ---- | --------------------------------------------------------------------------- |
| `pass`       | 0    | every configured check ran and found nothing                                |
| `violation`  | 1    | a check ran and found a breach                                              |
| `incomplete` | 2    | a check could not run: a missing tool, unsupported syntax or an empty scope |

An incomplete result is never a pass and cannot be excepted. `plumb explain RULE` prints a rule's purpose and remedy; `--format json` and `--format sarif` produce machine-readable reports.
