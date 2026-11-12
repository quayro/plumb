# Command line

This region is generated from `plumb --help`; `plumb fix` rewrites it and `plumb check` refuses drift.

<!-- plumb:generated cli -->

```text
Plumb — executable repository contracts

Usage: plumb <command> [options]

  init                  create plumb.json from the detected languages; never overwrite files
  packs                 list the policy packs of a registry with their pinned hashes
  vendor                install or update the checker in tools/plumb, pinned to a revision
  check                 run the complete, read-only policy
  plan                  show required checks, ownership and task obligations
  doctor                check prerequisites and suggest adoption steps
  inspect               show effective policy, coverage and rule metadata
  explain RULE          show one rule's purpose and remedy
  fix                   apply conservative source formatting, then check
  sync                  write or repair Plumb-owned files and executable modes
  snapshot              explicitly update configured public API snapshots
  prepare               explicitly run configured code-generation commands
  policy-diff           compare effective policy with --against FILE
  pin-policy FILE       print an offline bundle reference with its content hash
  pin-input PATH        print the digest for an approved input file or directory
  policy-test           run approved convention examples and intentional violations
  commit-msg FILE       check one commit message file, as the generated commit-msg hook does
  commits --range A..B  check every commit in a range; --message TEXT checks one subject line
  scaffold ROLE NAME    validate and create policy-defined source and companion files
  baseline              print exceptions that budget today's violations, for review
  progress              summarize violations and exception budgets; --base adds their change
  upgrade               preview adopting --policy FILE: policy changes and new violations
  conformance           probe every adapter in --adapters FILE against the protocol
  instructions          print the effective policy as instructions for a coding agent
  mcp                   serve the read-only commands to an agent over stdio
  lsp                   serve check diagnostics to an editor over the Language Server Protocol
  version               print the checker identity and verify a vendored install (--version)

  --root PATH           project root (otherwise discover plumb.json upwards)
  --config FILE         repository-relative JSON policy (default plumb.json)
  --policy FILE         use an approved policy outside the candidate checkout
  --task FILE           add an approved external task contract
  --adapters FILE       use an approved external pinned adapter registry
  --inputs FILE         add explicitly pinned inputs to an isolated check
  --file PATH           explain one file's owner, checks and exclusions (inspect)
  --dry-run             preview conservative repairs or scaffolding
  --apply FILE          apply a reviewed repair plan after hash/mode validation
  --output FILE         save JSON, SARIF or a repair plan outside the project
  --cache DIRECTORY     reuse unchanged deterministic core results outside CI
  --format FORMAT       text, json, or sarif (check only)
  --profile PROFILE     init a typescript, react, python, rust or generic project (default: detect)
  --preset PRESET       init with ozmikhail (default) or portable
  --pack NAMES          init with these comma-separated packs, copied and pinned as bundles
  --type TYPE           init with the packs for an application, library or documentation
  --interactive         init by answering questions; defaults come from the repository
  --index FILE          packs, init: use this registry index instead of the shipped packs
  --export DIRECTORY    packs: write the registry as a directory others can host
  --from SOURCE         vendor: the upstream repository or a local clone (default: this clone)
  --revision REV        vendor: the tag, branch or commit to pin (default: HEAD)
  --project PATH        snapshot only this configured project
  --base REF            check: report policy changes that weaken the git revision REF
  --observe             check: report violations without failing; incomplete still fails

Exit codes: 0 complete success; 1 policy violation; 2 incomplete or invalid invocation.
```

<!-- /plumb:generated -->
