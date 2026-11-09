# Getting started

Plumb is vendored into each repository so every checkout runs the exact checker it was reviewed with. This page connects a repository end to end: policy, hooks, CI and the shared upstream.

## Vendor the checker

From a clone of Plumb, one command installs the checker into a repository, pinned to a commit:

```sh
node ~/src/plumb/bin/plumb.ts vendor --root .
git commit -m "build: vendor plumb"
```

`vendor` stages the exact upstream tree under `tools/plumb` and records its commit in `tools/plumb.revision`, so installing or updating is one ordinary commit. `--revision` pins a tag, branch or commit; the default is the source's `HEAD`. It refuses to replace a vendored copy that has uncommitted edits.

It runs the same steps you can run by hand. `git subtree` is not used: its squash and merge commits break [title-only, linear history](../guides/commits.md).

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

## Start from the repository

`plumb init` writes the first policy from what the repository already is: it detects the languages present, recognizes a history of Conventional Commits and an existing hook manager, and suggests the [policy packs](../guides/packs.md) that fit. `plumb init --interactive` asks instead of assuming, and `plumb init --type library` starts from a ready-made set. Then follow [adopting a policy](../guides/adoption.md): observe, baseline, ratchet.

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

## Verify the checker

`plumb version` (or `plumb --version`) prints the checker's identity, a hash of its exact sources. For a vendored checker it also compares `tools/plumb` with the commit recorded in `tools/plumb.revision`: an edited copy is `install.modified`, and a revision that is not available locally is incomplete. `plumb doctor` runs the same comparison. Run it in CI after fetching upstream so the checker that judges a change is the one that was reviewed:

```sh
git fetch -q https://github.com/quayro/plumb.git "$(cat tools/plumb.revision)"
node tools/plumb/bin/plumb.ts version
```

`node scripts/build.ts` in the Plumb repository builds a standalone binary with the same identity embedded, for machines without Node.

## Update the checker

```sh
node tools/plumb/bin/plumb.ts vendor --from https://github.com/quayro/plumb.git --revision main
git commit -m "build: pull plumb"
```

Pin a release by naming its tag as `--revision`. The `plumb:pull` script above does the same without the checker. Never edit `tools/plumb` in place: fix shared problems in the Plumb repository, then pull in every consumer; `plumb version` reports an edited copy.
