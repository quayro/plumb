# Custom rules

`rules` declares repository invariants in the policy itself, with no adapter and in any language. Each entry becomes the rule `custom.<id>`, known to `inspect`, `explain`, `baseline` and `exceptions` like a built-in rule.

## Policy

```json
{
  "rules": [
    {
      "id": "no-console",
      "files": ["src/**/*.ts"],
      "forbid": "\\bconsole\\.log\\(",
      "reason": "Library code reports through the logger.",
      "remedy": "Call log.info instead."
    },
    {
      "id": "licensed",
      "files": ["src/**"],
      "require": "^// SPDX-License-Identifier: ",
      "reason": "Every source file names its licence."
    },
    {
      "id": "documented-commands",
      "files": ["src/commands/*.ts"],
      "mentionedIn": "docs/reference/commands.md",
      "reason": "Every command is documented."
    },
    {
      "id": "migrated",
      "files": ["db/schema.sql"],
      "changesWith": ["db/migrations/*.sql"],
      "reason": "A schema change ships with its migration."
    }
  ]
}
```

| Field         | Violation                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `forbid`      | a line of a selected file matches the pattern; reported with its line                             |
| `require`     | a selected file does not match the pattern; `^` and `$` match at line boundaries                  |
| `mentionedIn` | the named document does not mention a selected file's name (its basename up to the first dot)     |
| `changesWith` | with `--base REF`, a selected file changed since the base and no file matching these patterns did |

An entry needs at least one of the four. `reason` opens every message; `remedy` is optional.

## Guarantees

- A rule that selects no files, or whose `mentionedIn` document is missing, is `rules.scope` (incomplete), never a pass.
- `changesWith` is evaluated only with `--base`, as the [policy ratchet](policy-ratchet.md) is. Untracked files count as changed. A base that cannot be compared is `rules.base` (incomplete).
- Adding a rule tightens the policy; removing or editing one is a weakening the ratchet refuses.
- A bundle can add rules; an overlay cannot remove one.

## Limits

These rules read text, not syntax. A pattern split across lines or built at run time is not seen, and a `mentionedIn` name must stand alone as a word. When a rule needs the syntax tree, use a convention role, a contract or an adapter.

Pairs of files that must exist together, such as an `.up.sql` beside every `.down.sql`, are convention `companions`, not custom rules.
