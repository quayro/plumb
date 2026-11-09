# Policy packs

A pack is an ordinary policy file that another policy imports as a pinned bundle. Packs compose: each adds rules, and a conflict between two of them is an error, never a silent override.

## Shipped packs

`plumb packs` lists the registry shipped with the checker: each pack's name, description, the repository types it suits, its content and the SHA-256 that pins it.

| Pack                   | Adds                                                               | Suits                               |
| ---------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| `hygiene`              | refuses editor and merge leftovers and unresolved conflict markers | application, library, documentation |
| `secrets`              | refuses credential files, private keys and cloud or forge tokens   | application, library, documentation |
| `conventional-commits` | title-only Conventional Commits with the default types             | application, library, documentation |
| `open-source`          | requires `LICENSE` and `README.md`                                 | library                             |

## Choosing packs at init

```sh
plumb init --type library
plumb init --pack hygiene,secrets
plumb init --interactive
```

`init` reads the repository before it writes:

- language profiles come from the files present; a language without a built-in profile is listed under `detected.external` and needs an adapter;
- a history of Conventional Commits suggests the `conventional-commits` pack;
- a hook manager already in use is reported as `detected.hookManager`, for [`hooks.manager`](commits.md#existing-hook-managers);
- `suggestedPacks` names the packs that fit and were not chosen.

`--interactive` asks for the preset, the profiles and the packs, offering what it detected as defaults. Each chosen pack is copied to `.plumb/packs/NAME.json` and referenced from `bundles` with its hash, so an edited copy is an invalid policy, not a weaker one.

## Registries

A registry is a directory: an `index.json` beside the packs it lists, each with its SHA-256.

```json
{
  "schemaVersion": 1,
  "packs": [
    {
      "name": "org-base",
      "description": "What every repository of ours enforces.",
      "suits": ["application", "library"],
      "path": "org-base.json",
      "sha256": "…"
    }
  ]
}
```

- The public registry is [`packs/`](../../packs/index.json) in the Plumb repository. It is the same set the checker ships, so `plumb packs` needs no network.
- `plumb packs --index FILE` lists any other registry, and `plumb init --index FILE --pack NAME` installs from it.
- `plumb packs --export DIRECTORY` writes a registry in this format, ready to host. It never overwrites an existing file.

A pack is used only when its bytes match the hash in its index, it is a valid policy, it sits beside the index and it imports no bundles of its own. Anything else is an error and exit 2: an untrusted registry lists nothing.

## Organization-wide policy

A shared policy is a registry your organization owns. Vendor it and install from it:

```sh
plumb init --index vendor/org-policy/index.json --pack org-base
```

A policy that is not in a registry can be pinned directly:

```sh
plumb pin-policy vendor/org-policy/base.json
```

```json
{
  "schemaVersion": 1,
  "bundles": [{ "path": "vendor/org-policy/base.json", "sha256": "…" }]
}
```

Bundles nest, so an organization base, a team overlay and the repository policy form one chain. An overlay may add to protective lists, such as required and forbidden files, custom rules and `format.sortKeys`, where the deepest matching entry applies. It may not widen an allowance or set `format.keyColumns`, which would replace the default env globs; `plumb inspect` shows which file every effective value came from, and `plumb upgrade --policy` previews a new version before it is adopted.

## Updating a pack

Replace the copied file with the `policy` that `plumb packs` prints for the new version and update its `sha256`. `plumb check --base` classifies the difference like any other policy change.

## Contributing a pack

1. Add `src/assets/pack-NAME.json` with `"preset": "portable"`, so it composes under either preset.
2. List it in `src/assets/packs.json` with a description and the repository types it suits.
3. Keep it additive: required and forbidden files, custom rules, commits, verification. A pack never carries exclusions or exceptions.
4. Regenerate the public registry with `rm -r packs && node bin/plumb.ts packs --export packs`; a test refuses a stale one.
5. Add its expectations to `test/init.test.ts`, then run `npm test` and `npm run check`.

A pack that is specific to one organization or community does not need to be shipped: publish it in a registry of your own.
