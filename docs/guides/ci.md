# CI and branch protection

Hooks give fast feedback; the required CI job is what enforces the policy. The job needs the full history of the compared range.

```yaml
name: Verify

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: verify-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version-file: package.json
      - run: bun install --frozen-lockfile
      # check --base is the full check plus the policy ratchet, so one run covers both
      - name: Check the repository and refuse policy that weakens the base
        env:
          EVENT: ${{ github.event_name }}
          BASE_REF: ${{ github.base_ref }}
          BEFORE: ${{ github.event.before }}
        run: |
          base=
          if [ "$EVENT" = pull_request ]; then
            base="origin/$BASE_REF"
          elif [ "$EVENT" = push ] && [ "$GITHUB_REF" = refs/heads/main ] && [ "$BEFORE" != 0000000000000000000000000000000000000000 ]; then
            base="$BEFORE"
          fi
          bun --no-env-file tools/plumb/bin/plumb.ts check ${base:+--base "$base"}
      - if: github.event_name == 'pull_request'
        run: bun --no-env-file tools/plumb/bin/plumb.ts commits --range "origin/${{ github.base_ref }}..HEAD"
      - if: github.event_name == 'pull_request'
        env:
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: bun --no-env-file tools/plumb/bin/plumb.ts commits --message "$PR_TITLE"
      - if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.event.before != '0000000000000000000000000000000000000000'
        env:
          BEFORE: ${{ github.event.before }}
          AFTER: ${{ github.sha }}
        run: bun --no-env-file tools/plumb/bin/plumb.ts commits --range "$BEFORE..$AFTER"
```

Pin every action to a full commit SHA with its version in a comment, and keep the token read-only. Node 22.18 or later runs `bin/plumb.ts` the same way, as `node tools/plumb/bin/plumb.ts`. `check` already enforces formatting, and `fix` ends with a full check of its own, so CI does not run `fix`. A push straight to `main` gets the same ratchet against the commit it replaced, so a branch without required checks still reports a weakened policy. The checkout uses the pull request's head commit rather than GitHub's synthetic merge commit, which would otherwise fail `commits.merge`.

## Generated workflow

Instead of maintaining that file by hand, declare it and let `plumb sync` write `.github/workflows/plumb.yml`:

```json
{
  "ci": {
    "github": {
      "command": ["node", "tools/plumb/bin/plumb.ts"],
      "setup": ["npm ci"],
      "branch": "main"
    }
  }
}
```

The generated job checks out full history, sets up Node 22.18 (or Bun when the command starts with `bun`), runs each `setup` line, then `check --base` against the pull request base or the replaced commit. With `commits` configured it also checks every commit and the pull request title. Actions are pinned to full commit SHAs, the token is read-only, and event text reaches the shell only through the environment.

The file is a generated asset: editing it by hand is `generated.drift`, and removing `ci` from the policy is a weakening the [ratchet](policy-ratchet.md) refuses. Require the `plumb` job in branch protection.

## Repository settings

Plumb cannot enforce these; set them once per repository:

- Require the `verify` job on `main`, and require pull requests.
- Allow squash merging only, with the default commit message set to the pull request title.
- Require linear history and review from code owners.
