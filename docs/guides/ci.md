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
        env:
          BASE_REF: ${{ github.base_ref }}
        run: bun --no-env-file tools/plumb/bin/plumb.ts commits --range "origin/$BASE_REF..HEAD"
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

## Required checks

Require every job that holds a rule, by the name GitHub reports for it. Plumb's own [Verify workflow](../../.github/workflows/verify.yml) runs on every pull request and on every push to `main`, and a merge needs two of its jobs to pass on the latest commit of the branch:

| Check    | Holds                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| `verify` | `plumb check` with the policy ratchet, commit subjects and the title, the suites, and a `fix` that changes none |
| `native` | The real ruff, mypy, rustfmt, clippy and rustc checks, inside the sandbox                                       |

- A failed, cancelled, skipped or still running check is not a pass. Do not re-run a failed check until it passes without finding the cause.
- The `environments` jobs run the suites on other platforms and Node versions. They report, and a merge does not wait for them.
- Pushing a new commit cancels the run of the previous one on the same branch. Only the run on the latest commit counts.
- After a merge, the push to `main` runs the workflow again. Read that run before anything else merges, and before a release is tagged.

## Repository settings

Plumb cannot enforce these; set them once per repository:

- Require the checks above on `main`, on a branch that contains the current `main`, and require pull requests with resolved review threads.
- Allow squash merging only, with the commit title set to the pull request title and a blank message.
- Require linear history, and refuse force-pushes to `main` and its deletion.
- Refuse updating or deleting a `v*` tag.
- Delete a branch when its pull request merges, and keep auto-merge off.
- Give workflows a read-only token that cannot approve pull requests.

A setting is a fact about GitHub, not about a checkout. Apply the settings as a repository administrator, then verify them; do not infer them from a guide. These are the commands for Plumb's own repository; replace `quayro/plumb` and the check names with yours.

```sh
gh api -X PATCH repos/quayro/plumb -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=BLANK -F delete_branch_on_merge=true -F allow_auto_merge=false -F has_wiki=false -F has_projects=false
gh api -X PUT repos/quayro/plumb/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

The branch and tag rules are two rulesets:

```sh
gh api -X POST repos/quayro/plumb/rulesets --input - <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "verify" }, { "context": "native" }]
      }
    }
  ]
}
JSON
gh api -X POST repos/quayro/plumb/rulesets --input - <<'JSON'
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }, { "type": "update" }]
}
JSON
```

Verify what is in force:

```sh
gh api repos/quayro/plumb --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, squash_merge_commit_title, squash_merge_commit_message, delete_branch_on_merge}'
gh api repos/quayro/plumb/rulesets --jq '.[] | {name, target, enforcement}'
```

- Rulesets on a private repository need a paid GitHub plan. When the rulesets call answers 403, GitHub enforces none of the branch and tag rules, and they are held by review alone. Say so in a handover instead of assuming protection.
- The `main` ruleset requires no approving review, because GitHub does not let an author approve their own pull request and Plumb has one maintainer. When a second maintainer joins, raise `required_approving_review_count` to `1`, set `require_code_owner_review` to `true`, and update the ruleset with `gh api -X PUT repos/quayro/plumb/rulesets/<id>`.
- Code owners are generated into `.github/CODEOWNERS` from `policy` in `plumb.json`. Change the policy and run `plumb sync`; never edit the file.
- The first push to an empty repository has no base to compare with, so the policy ratchet and the commit-range check do not run for it. Apply the rulesets after that push.
