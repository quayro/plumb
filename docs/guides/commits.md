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

## Leave room for the merge suffix

A squash-merged pull request lands on `main` as its title followed by ` (#N)`, and the check on `main` counts that suffix. Keep a title eight characters under `maxLength`, 92 by default, so the subject still fits when the pull request number has four digits.

## Choose the type

| Type       | Use it when the change                                                  | Example                                                  |
| ---------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `feat`     | adds behavior someone can use                                           | `feat(api): add passkey sign-in`                         |
| `fix`      | corrects behavior that was wrong                                        | `fix(api): refuse expired sessions`                      |
| `refactor` | changes structure and leaves behavior as it was                         | `refactor(api): split the session store from its routes` |
| `perf`     | makes the same behavior cheaper or faster, with a measurement           | `perf(api): read a page of sessions with one query`      |
| `test`     | changes tests or fixtures only                                          | `test(api): cover a session that expires mid-request`    |
| `docs`     | changes documentation only                                              | `docs(api): describe session expiry`                     |
| `build`    | changes dependencies, the toolchain, the policy or the vendored checker | `build(api): pull plumb`                                 |
| `ci`       | changes workflows, hooks or repository automation                       | `ci(api): run the suites on pull requests`               |
| `style`    | changes formatting only                                                 | `style(api): sort imports`                               |
| `revert`   | undoes an earlier commit                                                | `revert(api): restore session ttl`                       |
| `chore`    | maintains the repository and fits none of the above                     | `chore(api): ignore local editor settings`               |

When a change fits two types, choose by what a reader of the release notes needs to learn: a fix that needed a refactor is a `fix`. A change that breaks a public or persisted contract carries `!` after the scope, and its pull request says what breaks and how a consumer moves.

## Word the subject

Say what the system does differently, in the words of the domain. Do not describe the edit.

| Write                                                     | Not                                    | Why                                           |
| --------------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| `fix(api): refuse expired sessions`                       | `fix(api): update session check`       | Names the behavior, not the file that changed |
| `feat(api): let an owner transfer the organization`       | `feat(api): add transfer.ts and route` | A reader learns who can now do what           |
| `fix(api): keep page reads consistent through pagination` | `fix(api): fix bug in pagination`      | States the property that now holds            |
| `refactor(api): remove the unreachable admission state`   | `refactor(api): cleanup`               | Says what was removed                         |

- Start lowercase, use the imperative, and end without a period.
- Use the nouns the guides use, so a reader can search the documentation for the words in the subject.
- Leave out ticket numbers, tool names and an "and" that joins two changes. Two changes are two pull requests.
- Name an agent's part in the pull request description. A `Co-authored-by` trailer is refused.

## Where it is enforced

- **Locally.** The generated `commit-msg` hook runs `plumb commit-msg "$1"`. Git comment lines and everything below the scissors line are ignored, so `commit.verbose` works.
- **Pull requests.** CI runs `plumb commits --range origin/main..HEAD` over every commit and `plumb commits --message "$PR_TITLE"` over the title, because a squash merge uses the title as the subject.
- **Pushes to `main`.** CI runs `plumb commits --range "$BEFORE..$AFTER"`, which catches anything that reached `main` without a pull request.
- **Automated commits.** Configure bots to write a passing subject, for example Dependabot's `commit-message.prefix: "build"` with `include: scope`. Plumb has no author exemptions.

`git commit --no-verify` cannot be detected locally; CI is the backstop. Fold a correction into your own unpushed commit with `git commit --amend` or an interactive rebase instead of a `fixup!` commit.

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
