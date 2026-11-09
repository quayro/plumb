# Commit messages

A commit message is one subject line: `type(scope): subject`. There is no body, footer or trailer.

## Policy

```json
{ "commits": { "types": ["feat", "fix", "docs"], "scopes": ["api"], "maxLength": 100 } }
```

`types` defaults to `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style` and `test`. When `scopes` is set a listed scope is required; otherwise a scope is optional. `maxLength` defaults to 100 code points.

These refusals are always on and cannot be excepted:

| Rule             | Refuses                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `commits.body`   | any second non-empty line, including `Co-authored-by:` and `BREAKING CHANGE:` |
| `commits.fixup`  | `fixup!`, `squash!` and `amend!` subjects                                     |
| `commits.merge`  | merge commits and `Merge …` subjects                                          |
| `commits.format` | git's default `Revert "…"`, an uppercase or spaced subject, a trailing period |
| `commits.type`   | a type outside the list or in capitals                                        |
| `commits.scope`  | a missing or unlisted scope                                                   |
| `commits.length` | a subject over `maxLength`                                                    |
| `commits.range`  | an empty range or a base that is not fetched (incomplete)                     |

| Passes                              | Fails                                        |
| ----------------------------------- | -------------------------------------------- |
| `fix(api): refuse expired sessions` | `Fix(api): refuse expired sessions`          |
| `feat(api)!: drop the v1 routes`    | `fix(api): Refuse expired sessions.`         |
| `revert(api): restore session ttl`  | `Revert "fix(api): refuse expired sessions"` |

## Where it is enforced

- **Locally.** The generated `commit-msg` hook runs `plumb commit-msg "$1"`. Git comment lines and everything below the scissors line are ignored, so `commit.verbose` works.
- **Pull requests.** CI runs `plumb commits --range origin/main..HEAD` over every commit and `plumb commits --message "$PR_TITLE"` over the title, because a squash merge uses the title as the subject.
- **Pushes to `main`.** CI runs `plumb commits --range "$BEFORE..$AFTER"`, which catches anything that reached `main` without a pull request.
- **Automated commits.** Configure bots to write a passing subject, for example Dependabot's `commit-message.prefix: "build"` with `include: scope`. Plumb has no author exemptions.

`git commit --no-verify` cannot be detected locally; CI is the backstop. Squash fixups with `git rebase --autosquash` before pushing.

## Existing hook managers

A repository that already runs husky, lefthook or pre-commit keeps it. Name it in the policy and Plumb generates no hook files of its own:

```json
{ "hooks": { "command": ["node", "tools/plumb/bin/plumb.ts"], "manager": "lefthook" } }
```

| Manager      | Where the invocation lives                  | What `plumb doctor` expects in the clone   |
| ------------ | ------------------------------------------- | ------------------------------------------ |
| `git`        | generated `.githooks/` (the default)        | `core.hooksPath` is the hooks folder       |
| `husky`      | `.husky/pre-commit` and `.husky/commit-msg` | `core.hooksPath` is `.husky` or `.husky/_` |
| `lefthook`   | `lefthook.yml`                              | `lefthook install` has run                 |
| `pre-commit` | `.pre-commit-config.yaml`                   | `pre-commit install` has run               |

`plumb check` requires the manager's file to hold the policy invocation as a whole line: `COMMAND check`, and `COMMAND commit-msg` once `commits` is configured, optionally after `run:`, `entry:` or `exec`. A commented line, an appended `|| true` or an extra flag such as `--observe` is `hooks.manager`, and a missing file is incomplete. The check reads lines, not the manager's schema, so CI stays the enforcement point.
