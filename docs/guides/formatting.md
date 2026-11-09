# Aligned formatting

`plumb fix` lays out data and schema files as well as code, and `plumb check` refuses a file that differs from that layout. The aligners are plain JavaScript in the core, so a repository needs no language pack to use them.

## Core aligners

| Rule                    | Files                                                            | Layout                                                                                    |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `format.markdown-table` | `*.md`                                                           | Every table is padded into aligned columns, whatever its width; `:--`, `:-:`, `--:` kept. |
| `format.key-columns`    | `format.keyColumns`, default `**/.env.schema`, `**/.env.example` | `NAME rest # comment` runs get aligned value and comment columns.                         |
| `format.json-keys`      | `format.sortKeys[].files`                                        | Keys sorted by code point to `depth` (default 1); arrays are never reordered.             |

- The `ozmikhail` preset turns on the table and key-column aligners; `portable` leaves them off. JSON key order applies only to files a policy lists, in either preset.
- In a repository with a JavaScript project, Markdown is formatted by the pack's Prettier first and then by the table aligner, in both `check` and `fix`, so the two cannot undo each other.
- A table is a header row and a delimiter row with the same number of cells, as in GitHub Flavored Markdown. A table with a row longer than its header, YAML front matter, and code indented four spaces are left as written; an indented table keeps its indent.
- A file with CRLF endings keeps them.
- A table pipe splits a cell unless it is escaped as `\|`, as in GitHub Flavored Markdown, including inside a code span. Tables in code fences are untouched.
- In a key-column file, `#` starts a comment only after whitespace and outside quotes. A `NAME=value` line keeps its text; only its comment moves. A run ends at a blank line or a full-line comment, and a line without a comment is left as written.
- A selected JSON file that does not parse is reported as incomplete, never skipped.

## Pinned external formatters

`format.tools` opts into installed formatters. Each binary is found on `PATH`, then in the repository's `node_modules/.bin`. An entry runs only once its version is pinned in `tools.versions`; an unpinned or different version reports `tools.version`, a missing tool `tools.missing`. Exit code 1 counts as a violation only when the output shows a formatting difference; anything else, such as a parse error, makes the check incomplete. Prisma formats a whole schema folder, so a folder that also holds an excluded or ignored schema file is refused.

| Tool            | Rule            | Check                                                                      | Fix                                               |
| --------------- | --------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| `prisma`        | `format.prisma` | `prisma format --check --schema <folder>`                                  | `prisma format --schema <folder>`                 |
| `shfmt`         | `format.shell`  | `shfmt -i 2 -d <files>`                                                    | `shfmt -i 2 -w <files>`                           |
| `sql-formatter` | `format.sql`    | `sql-formatter --language <dialect> <file>`, output compared with the file | `sql-formatter --language <dialect> --fix <file>` |
| `taplo`         | `format.toml`   | `taplo fmt --check <files>`                                                | `taplo fmt <files>`                               |

`dialect` applies only to `sql-formatter` and defaults to `postgresql`. An entry whose globs match no file, and a file a tool cannot parse, make the check incomplete.

## Example policy

```json
{
  "format": {
    "keyColumns": ["**/.env.schema", "**/.env.example", "config/*.keys"],
    "sortKeys": [{ "files": ["config/flags.json"], "depth": 2 }],
    "tools": [
      { "tool": "prisma", "files": ["api/src/prisma/schema/*.prisma"] },
      { "tool": "shfmt", "files": ["**/*.sh", ".githooks/*"] },
      { "tool": "sql-formatter", "files": ["api/sql/**/*.sql"], "dialect": "postgresql" }
    ],
    "ignore": [
      { "path": "api/src/prisma/migrations/**", "reason": "deployed migrations are immutable" }
    ]
  },
  "tools": { "versions": { "prisma": "7.10.1", "shfmt": "3.10.0", "sql-formatter": "15.6.0" } }
}
```

`exclude` and `format.ignore` protect a file from every formatter.
