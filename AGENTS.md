# Plumb agent guidance

This file is the entry point for work on Plumb itself. Plumb checks itself with its own policy in [plumb.json](plumb.json); read the [documentation index](docs/index.md) and the [contributing guide](docs/contributing/index.md) before changing behaviour.

## Boundaries

- The core in `src/` and `bin/` imports only `node:` built-ins. Language engines belong in `packages/`.
- All code is erasable TypeScript run without a build: no enums, namespaces or parameter properties, `import type` for types, and relative imports ending in `.ts`.
- A missing tool, unsupported syntax, an empty scope or an unfinished check is reported as `incomplete`. Never turn one into a pass.
- `fix` changes only what has one predictable result: formatting, generated assets and generated documentation regions. Policy files and API snapshots change only by explicit review.
- Every rule ships with passing and failing tests, including the equivalent rewrites an agent would try to slip past it.

## Commands

| Command                      | What it does                                     |
| ---------------------------- | ------------------------------------------------ |
| `npm test`                   | Core, JavaScript-pack, Python and adapter suites |
| `npm run test:native`        | Real RuboCop, clang-format and clang-tidy checks |
| `npm run check`              | Plumb's own policy                               |
| `npm run fix`                | Write formatting and generated regions           |
| `node scripts/schema.ts`     | Regenerate `plumb.schema.json` from the schema   |
| `node scripts/plumb.ts sync` | Rewrite generated hooks and CODEOWNERS           |
| `npm run hooks:install`      | Point git at the hooks; installing already does  |

The `node scripts/plumb.ts` wrapper pins the Python adapter from git, not the working tree: `PLUMB_ADAPTER_REF` (default `HEAD`) names the revision. Commit an adapter change before the self-check uses it.

## Commits

One title-only Conventional Commit per logical change, `type: subject`, lowercase subject, no trailing period, at most 100 characters. The generated `commit-msg` hook and CI refuse bodies, trailers, fixups and merges.

`main` is protected: a change lands through a pull request that `verify` and `native` pass on, squash-merged with the pull request title as its one subject. Pushing to `main`, force-pushing and merge commits are refused, administrators included.
