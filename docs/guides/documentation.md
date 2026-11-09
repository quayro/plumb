# Documentation

Plumb checks Markdown structure the same way it checks code: deterministically, with no style engine.

## Policy

```json
{
  "docs": {
    "index": "docs/index.md",
    "sections": [
      "getting-started",
      "guides",
      "concepts",
      "reference",
      "architecture",
      "decisions",
      "contributing"
    ],
    "kinds": [
      {
        "files": ["docs/decisions/*.md"],
        "exclude": ["docs/decisions/index.md"],
        "name": "^\\d{4}-[a-z0-9-]+\\.md$",
        "sections": ["Status", "Context", "Decision", "Consequences"],
        "status": ["Proposed", "Accepted", "Superseded", "Deprecated"],
        "sequence": true
      }
    ],
    "generated": [
      {
        "file": "docs/reference/cli.md",
        "region": "cli",
        "command": ["node", "bin/plumb.ts", "--help"]
      }
    ]
  }
}
```

## Rules

| Rule             | Requires                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `docs.links`     | relative links and anchors resolve; reference labels are defined; folders are linked by their `index.md`              |
| `docs.index`     | the index links every page under its folder (without `sections`)                                                      |
| `docs.layout`    | top-level folders come from `sections`; each folder has an `index.md` linking its pages and child indexes; no orphans |
| `docs.headings`  | one ATX H1 as the first line, no skipped levels, no duplicate sibling headings                                        |
| `docs.fences`    | every fence names a language (`text` is allowed)                                                                      |
| `docs.kinds`     | file names, required `##` sections in order, a listed status and contiguous numbering                                 |
| `docs.generated` | the region between `<!-- plumb:generated name -->` and `<!-- /plumb:generated -->` equals the command output          |
| `docs.scope`     | a configured docs section, kind or generated region governs at least one file (incomplete otherwise)                  |

`plumb fix` rewrites only generated regions. It never moves, renames or restructures pages: reorganizing documentation is a reviewed change, and `docs.links` verifies the result.
