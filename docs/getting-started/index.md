# Getting started

Plumb is vendored into each repository so every checkout runs the exact checker it was reviewed with. This page connects a repository end to end: policy, hooks, CI and the shared upstream.

## Vendor the checker

The vendored copy is the exact upstream tree, staged with `git read-tree` so updating it is one ordinary commit. `git subtree` is not used: its squash and merge commits break [title-only, linear history](../guides/commits.md).

```sh
git fetch https://github.com/quayro/plumb.git main
git read-tree --prefix=tools/plumb/ -u FETCH_HEAD
git rev-parse FETCH_HEAD > tools/plumb.revision
git add tools/plumb.revision
git commit -m "build: vendor plumb"
```

Add package scripts so people and agents run one command; `postinstall` installs the hooks in every clone, and does nothing outside a git work tree, as in an image build:

```json
{
  "check": "node tools/plumb/bin/plumb.ts check",
  "fix": "node tools/plumb/bin/plumb.ts fix",
  "hooks:install": "git config core.hooksPath .githooks",
  "postinstall": "git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git config core.hooksPath .githooks || true",
  "plumb:pull": "git fetch -q https://github.com/quayro/plumb.git main && git rm -rq --cached tools/plumb && rm -rf tools/plumb && git read-tree --prefix=tools/plumb/ -u FETCH_HEAD && git rev-parse FETCH_HEAD > tools/plumb.revision && git add tools/plumb.revision"
}
```

The JavaScript pack installs its pinned tools as a workspace, so add `"tools/plumb/packages/javascript"` to the root `workspaces` and install dependencies as regular files:

```toml
# bunfig.toml: plumb reads dependencies as regular files; it refuses symlinked installs
[install]
linker = "hoisted"
```

Exclude the vendored copy from the repository's own checks and protect it:

```json
{
  "exclude": [
    {
      "files": ["tools/plumb/**", "tools/plumb.revision"],
      "reason": "vendored checker, verified upstream"
    }
  ],
  "policy": { "protected": ["tools/plumb/**", "tools/plumb.revision"], "owners": ["@your-handle"] }
}
```

## Declare hooks and commits

```json
{
  "commits": { "scopes": ["api"], "maxLength": 100 },
  "hooks": { "command": ["node", "tools/plumb/bin/plumb.ts"] }
}
```

`plumb sync` writes `.githooks/pre-commit`, `.githooks/commit-msg` and `.github/CODEOWNERS` from the policy; `plumb check` reports any drift. Run `git config core.hooksPath .githooks` once per clone; `plumb doctor` reports a clone where it is unset.

## Require it in CI

Hooks are a convenience: `--no-verify` skips them. CI is the enforcement point. Every pull request runs:

```sh
node tools/plumb/bin/plumb.ts check --base origin/main
node tools/plumb/bin/plumb.ts commits --range origin/main..HEAD
node tools/plumb/bin/plumb.ts commits --message "$PR_TITLE"
node tools/plumb/bin/plumb.ts fix && git diff --exit-code
```

Every push to `main` runs `commits --range` over the pushed commits. See [CI and branch protection](../guides/ci.md) for the workflow and the repository settings it relies on.

## Update the checker

`plumb:pull` replaces `tools/plumb` with upstream `main` and records the revision; commit the result as `build(scope): pull plumb`. Never edit `tools/plumb` in place: fix shared problems in the Plumb repository, then pull in every consumer.
