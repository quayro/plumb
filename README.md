# Plumb

Plumb turns repository conventions into deterministic, executable checks. One `plumb.json` declares what a repository requires — file names, layers, owners, formatting, documentation structure, commit subjects and the policy itself — and `plumb check` refuses anything else. Rules cannot be switched off from source; an exception is a reviewed, reasoned, budgeted entry in the policy.

The core is dependency-free, erasable TypeScript that Node 22.18 or later and Bun run without a build step. Language engines live in optional packs: [the JavaScript pack](packages/javascript/README.md) (ESLint, TypeScript, Prettier, Knip) and [the Python adapter](packages/python/README.md).

## Quick start

```sh
git fetch https://github.com/quayro/plumb.git main
git read-tree --prefix=tools/plumb/ -u FETCH_HEAD
git rev-parse FETCH_HEAD > tools/plumb.revision
node tools/plumb/bin/plumb.ts init
node tools/plumb/bin/plumb.ts sync
git config core.hooksPath .githooks
node tools/plumb/bin/plumb.ts check
```

`check` exits 0 on success, 1 on a violation and 2 when a check is incomplete. A check that cannot run never passes.

## Documentation

Start at the [documentation index](docs/index.md). Contributors and coding agents read [AGENTS.md](AGENTS.md) first.

## License

MIT, see [LICENSE](LICENSE).
