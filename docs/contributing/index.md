# Contributing

## Set up

```sh
bun install --frozen-lockfile
git config core.hooksPath .githooks
```

## Change a rule

1. Write the failing fixture first, then the passing one, then the bypasses: aliases, computed access, equivalent rewrites and empty scopes.
2. Export the rule from its module's `RULES` with a description and remedy.
3. If the schema changes, run `node scripts/schema.ts`; a test refuses a stale `plumb.schema.json`.
4. Run `npm test` and `npm run check`. The native suite needs Ruby, RuboCop, clang-format and clang-tidy; CI runs it.
5. Update the guide that owns the behaviour.

## Commit

One subject line, `type: subject`, as described in [commit messages](../guides/commits.md).
