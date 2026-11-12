# Plumb agent guidance

This file is the mandatory entry point for work on Plumb itself. Read it first, then read the subject guides linked below before changing the corresponding behavior. Plumb checks itself with its own policy in [plumb.json](plumb.json).

## 1. Documentation convention

Use one root `AGENTS.md`, the navigation index at `docs/index.md`, and one subject guide per topic in `docs/`.

Update the owning guide when a rule, diagnostic, command, policy key or protocol field changes; update this router when reading paths change. The [documentation guide](docs/guides/documentation.md) describes the structure `plumb check` holds the pages to.

Code, `plumb.schema.json`, `adapter-protocol.schema.json` and the generated [command line reference](docs/reference/cli.md) establish implemented behavior. Documentation explains that behavior and how to use it. A proposed improvement is not an implemented capability; the [roadmap status](docs/reference/roadmap.md) says where each one stands. When evidence disagrees, identify the discrepancy and resolve it in the owning module; do not use prose as permission to bypass a check.

## 2. Read the right guides

Start with the [documentation index](docs/index.md), the [architecture](docs/architecture/index.md) and the [contributing guide](docs/contributing/index.md). Read every subject affected by the change, including downstream effects.

| Task or concern                                            | Required subject guides                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Policy keys, presets, exceptions or protected files        | [Policy and exceptions](docs/concepts/policy.md), [policy ratchet](docs/guides/policy-ratchet.md)                                    |
| Diagnostics, statuses or exit codes                        | [Diagnostics and statuses](docs/concepts/diagnostics.md)                                                                             |
| Adoption, baselines or policy upgrades                     | [Adopting a policy](docs/guides/adoption.md)                                                                                         |
| Packs or organization-wide policy                          | [Policy packs](docs/guides/packs.md)                                                                                                 |
| Repository invariants declared in the policy               | [Custom rules](docs/guides/custom-rules.md)                                                                                          |
| Language profiles or native tools                          | [Language profiles](docs/guides/languages.md)                                                                                        |
| Adapters, the SDK, the protocol or the sandbox             | [Adapters](docs/guides/adapters.md)                                                                                                  |
| Formatting or pinned formatters                            | [Aligned formatting](docs/guides/formatting.md)                                                                                      |
| Comments, suppressions or task markers                     | [Source hygiene](docs/guides/source-hygiene.md)                                                                                      |
| Documentation checks or generated regions                  | [Documentation](docs/guides/documentation.md)                                                                                        |
| Suites, reports or coverage                                | [Tests and coverage](docs/guides/verification.md)                                                                                    |
| Agent instructions, the MCP server or editors              | [Coding agents](docs/guides/agents.md), [editors](docs/guides/editors.md)                                                            |
| Vendoring, install verification or the command line        | [Getting started](docs/getting-started/index.md), [command line](docs/reference/cli.md)                                              |
| Environments, languages or capabilities                    | [Compatibility and capabilities](docs/reference/compatibility.md)                                                                    |
| Branches, commits, pull requests, review, merge or release | [Contributing](docs/contributing/index.md), [commit messages](docs/guides/commits.md), [CI and branch protection](docs/guides/ci.md) |

## 3. Universal boundaries

1. **Keep the core dependency-free.** The core in `src/` and `bin/` imports only `node:` built-ins. Language engines belong in `packages/`.
2. **Write erasable TypeScript.** All code runs without a build: no enums, namespaces or parameter properties, `import type` for types, and relative imports ending in `.ts`.
3. **Never turn an unfinished check into a pass.** A missing tool, unsupported syntax, an empty scope or an unfinished check is reported as `incomplete`.
4. **Fix only what has one predictable result.** `fix` changes formatting, generated assets and generated documentation regions. Policy files and API snapshots change only by explicit review.
5. **Test the bypasses.** Every rule ships with passing and failing tests, including the equivalent rewrites an agent would try to slip past it.

## 4. Working procedure

1. Identify what the change touches: a rule, a policy key, a command, a pack, an adapter or documentation. Read the owning guide and module before editing.
2. Write the failing fixture first, then the passing one, then the bypasses. Keep a rule in its module's `RULES` with a description and a remedy.
3. Use the Bun version pinned in the [package manifest](package.json) with frozen dependencies, and Node 22.18 or later. Do not add a runtime dependency to the core.
4. Run the checks the change needs and satisfy the required CI checks. Do not weaken a rule, an exception or a test to obtain a pass. Regenerate `plumb.schema.json` when the schema changes, and review the generated difference.
5. Update the owning guide with the implementation. Explain a non-obvious constraint in a comment beside the code. Label any remaining gap in the [roadmap status](docs/reference/roadmap.md) accurately.
6. Use one title-only Conventional Commit per logical change, scoped `plumb`; the generated `commit-msg` hook and CI refuse a body, a trailer, a fixup, a merge or another form. Plumb versions use `YY.M.MICRO[-CHANNEL]`. Include the version in the substantive change commit and tag that verified commit after finalizing its history; never create a standalone version-only or release commit. Published tags are immutable.
7. Land a change through a pull request that `verify` and `native` pass on, squash-merged with the pull request title as its one subject. Never push to `main`, force-push it or merge with a merge commit. Follow the [contributing guide](docs/contributing/index.md); [CI and branch protection](docs/guides/ci.md) says what GitHub enforces.

| Command                      | What it does                                      |
| ---------------------------- | ------------------------------------------------- |
| `bun run test`               | Core, JavaScript-pack, Python and adapter suites  |
| `bun run test:native`        | Real ruff, mypy, rustfmt, clippy and rustc checks |
| `bun run check`              | Plumb's own policy                                |
| `bun run fix`                | Write formatting and generated regions            |
| `node scripts/schema.ts`     | Regenerate `plumb.schema.json` from the schema    |
| `node scripts/plumb.ts sync` | Rewrite generated hooks and CODEOWNERS            |
| `bun run hooks:install`      | Point git at the hooks; installing already does   |
| `bun run release:notes`      | Draft the release notes of the current tag        |

The `node scripts/plumb.ts` wrapper pins the Python adapter from git, not the working tree: `PLUMB_ADAPTER_REF` (default `HEAD`) names the revision. Commit an adapter change before the self-check uses it.

## 5. Machine-checked conventions

These conventions are held by checks rather than habit. Every rule and every exception lives in [plumb.json](plumb.json) and is enforced by Plumb itself; `bun run check` runs it, and source cannot disable a rule (eslint-disable, `@ts-ignore` and formatter-ignore comments are refused). Change an exception in the same edit as the code it admits, with a reason on each entry. `bun install` points git at the generated hooks, and `bun run hooks:install` repeats it. [Repository conventions](docs/reference/conventions.md) is the effective policy, generated from `plumb.json`.

| Convention                                                         | Check                                              | Where it lives                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------- |
| Erasable TypeScript, types, lint, reachability and cycles          | the `typescript` profile, `javascript/knip`        | `plumb.json` `projects`, `knip.json`                              |
| The Python adapter and SDK pass ruff, mypy and the Python policy   | the `python` profile                               | `plumb.json` `projects`, `tools.versions`                         |
| The Rust SDK passes rustfmt, clippy and the Rust policy            | the `rust` profile                                 | `plumb.json` `projects`, `tools.versions`                         |
| Module and page names, required and forbidden files                | `files.names`, `files.required`, `files.forbidden` | `plumb.json` `files`                                              |
| Page structure, links and one H1 per page                          | `docs.layout`, `docs.links`, `docs.headings`       | `plumb.json` `docs`                                               |
| The generated reference pages                                      | `docs.generated`                                   | `plumb.json` `docs`, [conventions](docs/reference/conventions.md) |
| A task marker names its issue                                      | `comments.task`                                    | `plumb.json` `comments`                                           |
| Formatting leaves nothing to fix                                   | `pre-commit` hook and CI                           | `.githooks/pre-commit`, `bun run fix`                             |
| One line, `type(plumb): subject`, at most 100 characters           | `commit-msg` hook, `plumb commits` in CI           | `plumb.json` `commits`                                            |
| Policy only tightens without an owner's override                   | `plumb check --base` in CI                         | `plumb.json`, generated `.github/CODEOWNERS`                      |
| Exact dependency versions, a lockfile and a pinned package manager | `javascript/dependencies`                          | `package.json`                                                    |
| The published schema matches the schema in source                  | a core test refuses a stale `plumb.schema.json`    | `scripts/schema.ts`                                               |

## 6. Completion check

- [ ] The owning module and affected guides were read and updated.
- [ ] The rule has passing, failing and bypass tests, and an unfinished check still reports `incomplete`.
- [ ] The core still imports only `node:` built-ins, and every source stays erasable TypeScript.
- [ ] Required checks passed, or an explicit unresolved blocker is reported.
- [ ] Generated files match their sources: the schema, the reference pages, the hooks and CODEOWNERS.
- [ ] No rule, exception or test was weakened to obtain a pass.
- [ ] The handoff states what changed, why, evidence and remaining gaps.

Recheck source-sensitive details against the checkout being changed. Write guides in plain prose without release stamps or status banners. See the [documentation index](docs/index.md).
