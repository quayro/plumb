# Coding agents

An agent follows a policy it can read. Plumb gives it the conventions before it edits, and the same verdict a person gets after.

## Instructions

`plumb instructions` prints the effective policy as markdown: the workflow, required and forbidden files, naming contracts, protected files, custom rules, boundaries, roles, commit rules and required suites. It is generated from the policy, so it cannot drift from what `plumb check` enforces.

Keep it in the file your agent reads by declaring a generated region; `plumb fix` rewrites it and `plumb check` reports drift:

```json
{
  "docs": {
    "generated": [
      {
        "file": "docs/conventions.md",
        "region": "conventions",
        "command": ["node", "tools/plumb/bin/plumb.ts", "instructions"]
      }
    ]
  }
}
```

## Conventions for one file

`plumb inspect --file PATH` returns the file's owners, its checks and a `conventions` object, for a file that exists or one about to be created:

| Field        | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `writable`   | false for policy and protected files, which change only by review    |
| `names`      | the naming contracts the path must satisfy                           |
| `rules`      | the [custom rules](custom-rules.md) that select it                   |
| `boundaries` | what it may not import                                               |
| `roles`      | the convention roles it falls under                                  |
| `exceptions` | the budgeted exceptions that cover it; fix these rather than add one |

## MCP server

`plumb mcp` serves the same answers over the Model Context Protocol on stdio. Register it as a stdio server in the agent's MCP configuration:

```json
{
  "mcpServers": {
    "plumb": { "command": "node", "args": ["tools/plumb/bin/plumb.ts", "mcp"] }
  }
}
```

| Tool           | Argument | Returns                                                  |
| -------------- | -------- | -------------------------------------------------------- |
| `instructions` |          | the repository's conventions as markdown                 |
| `inspect_file` | `path`   | the file's owners, checks and the conventions that apply |
| `plan`         |          | the checks the policy requires and the files each covers |
| `check`        |          | the complete JSON report                                 |
| `explain`      | `rule`   | one rule's purpose, remedy and kind                      |

- Every tool is read-only. `fix`, `sync`, `snapshot` and policy changes stay outside the server.
- The server keeps the `--root`, `--config`, `--policy` and `--adapters` it was started with. A tool argument is one value and cannot add an option.
- A violation and an incomplete check both return an error result, so neither reads as a pass.
