# Policy ratchet

`plumb check --base REF` compares the effective policy with the policy at the git revision `REF` and refuses any change that weakens it. A policy can tighten in an ordinary change; loosening it needs a human to override the required check.

## Classification

Every changed JSON pointer is classified. Anything not listed is a weakening.

| Classification | Examples                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tighten        | removing an exception, exclude or format ignore; lowering `max`; adding required, forbidden, named or protected files; adding a project, suite, contract or a new section such as `commits`                    |
| neutral        | `tools.versions`, `tools.timeout`, generated content, reordering                                                                                                                                               |
| weaken         | a new exception id; a larger `max`; new exception files or rules; a later or removed `expires`; a wider `exclude`; a removed project; a new commit type or scope; a longer `maxLength`; a changed hook command |

Renaming an exception, moving its files to another id or splitting it in two are all weakenings: identity is the id. A missing base revision or base policy is reported `policy.base` (incomplete), never a pass.

## Protected files and owners

`policy.protected` lists files that `fix`, `sync` and repairs never write. Plumb always protects its own policy, generated hooks, `.github/workflows/**`, `.github/CODEOWNERS`, TypeScript, Knip, Prettier and EditorConfig files. With `policy.owners`, `plumb sync` generates `.github/CODEOWNERS` from that list so every protected change needs an owner's review.

## Policy location

Inside git, Plumb uses the policy at the work-tree top level; another `plumb.json` elsewhere is `policy.nested`. `--config` is refused in CI and with `--base` unless it names `plumb.json`.
