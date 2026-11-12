# Contributing

How a change moves from a branch to a release, and how to write each thing on the way. These rules sit on top of what Plumb checks in its own repository: where a check holds a rule, this guide names the check and does not repeat it. [AGENTS.md](../../AGENTS.md) holds the boundaries every change keeps.

## Set up

```sh
bun install --frozen-lockfile
bun run hooks:install
```

Installing already points git at the generated hooks; the second command repeats it. The checks run on Node 22.18 or later. The native suite and Plumb's check of its own Python and Rust sources need ruff, mypy and a Rust toolchain with rustfmt and clippy, at the versions [plumb.json](../../plumb.json) pins, and the platform's sandbox tool (`sandbox-exec` on macOS, `bwrap` on Linux). CI installs them.

## Change Plumb

1. Read [AGENTS.md](../../AGENTS.md) and every guide its table names for the change.
2. Branch from the current `main`. Name the branch `type/short-topic` with the commit type the change will have, as in `fix/empty-scope-incomplete`.
3. Write the failing fixture first, then the passing one, then the bypasses: aliases, computed access, equivalent rewrites and empty scopes.
4. Export a rule from its module's `RULES` with a description and remedy.
5. If the schema changes, run `node scripts/schema.ts`; a test refuses a stale `plumb.schema.json`.
6. Run `bun run fix`, then `bun run check` and `bun run test`. Run `bun run test:native` when the change touches a native tool, an adapter or the sandbox; CI runs it either way.
7. Update the guide that owns the behavior in the same change.

## Commit

One subject line, `type(plumb): subject`, as described in [commit messages](../guides/commits.md).

## Open a pull request

One pull request holds one logical change and becomes one commit on `main`.

- **Title.** Write the subject the commit will have, in at most 92 characters. CI checks it with the same rule as a commit.
- **Description.** Write five headings: Problem, Change, Verification, Risk and rollout, Documentation. Under Verification, name the commands that ran and what they showed; a planned test is not a result. Say which parts an agent wrote.
- **Size.** Split a change that needs "and" in its title. A refactor that a fix depends on is its own pull request, merged first.
- **Draft.** Open as a draft until the required checks pass, then mark it ready.
- **Updates.** Push further commits during review, each with a passing subject, so a reviewer can read what changed since their last look. Bring the branch up to date by rebasing on `main` and pushing with `--force-with-lease`; a merge commit from `main` is refused by `commits.merge`.

## Review and merge

- [CODEOWNERS](../../.github/CODEOWNERS) names who reviews. The policy, the core, the scripts, the hooks and the workflows change only with an owner's review.
- A reviewer reads the change against the [completion check](../../AGENTS.md#6-completion-check) and the guides it touches, and distinguishes what they read from what they ran.
- Resolve every thread. The author answers a comment with a change or a reason, and the reviewer resolves it.
- Merge by squash only, when the [required checks](../guides/ci.md#required-checks) pass on the latest commit. The title becomes the subject and the message stays empty.
- After the merge, read the run on `main`. A failure there is fixed forward with a new pull request, or reverted with `revert(plumb): …`.
- Pushing to `main`, force-pushing it and merge commits are refused. The [repository settings](../guides/ci.md#repository-settings) say what GitHub enforces.

## Release

1. Put the `package.json` version in the pull request of the substantive change being released. There is no version-only commit.
2. After the merge, confirm that the run on `main` passed for that commit.
3. Create the annotated tag `v<version>` on that commit, with the tag name as its message, and push the tag.
4. Draft the release notes with `bun run release:notes`. Review **Changes** against the tag comparison, replace the prompts under **Upgrade notes** and **Verification**, and publish the result as the GitHub release of the tag.

Versions are `YY.M.MICRO[-CHANNEL]`: the two-digit year, the month without a leading zero, and a counter within that month, as in `26.11.2`. A published commit or tag is never rewritten; the next change takes the next version. A repository that vendors Plumb pins a release by [naming its tag](../getting-started/index.md#update-the-checker), and its revision file records the commit the tag names.

## Write each thing

| Thing                    | How to write it                                                                           | Owner                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Branch                   | `type/short-topic`, lowercase with hyphens                                                | This guide                                                              |
| Commit subject           | `type(plumb): subject`, the behavior in the words the guides use                          | [Commit messages](../guides/commits.md)                                 |
| Pull request title       | The commit subject, at most 92 characters                                                 | [Commit messages](../guides/commits.md#leave-room-for-the-merge-suffix) |
| Pull request description | Problem, Change, Verification, Risk and rollout, Documentation                            | This guide                                                              |
| Code comment             | The constraint the code cannot show, lowercase, beside the code it explains               | [Source hygiene](../guides/source-hygiene.md)                           |
| Rule                     | An entry in its module's `RULES` with a description and a remedy                          | [Architecture](../architecture/index.md)                                |
| Policy exception         | An entry in `plumb.json` with a reason, in the commit that needs it                       | [Repository conventions](../reference/conventions.md)                   |
| Test                     | Beside the suite it belongs to, as `*.test.ts`, with passing, failing and bypass fixtures | [Tests and coverage](../guides/verification.md)                         |
| Guide                    | Plain prose in the guide that owns the behavior, without release stamps or status banners | [Documentation](../guides/documentation.md)                             |
| Version                  | `YY.M.MICRO[-CHANNEL]` in `package.json`                                                  | This guide                                                              |
| Tag                      | Annotated `v<version>` on the released commit                                             | This guide                                                              |
| Release notes            | Generated with `release:notes`, then reviewed                                             | This guide                                                              |
