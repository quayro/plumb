# Editors

`plumb lsp` is a Language Server Protocol server on stdio. When a file is opened or saved it runs the whole check and publishes the diagnostics, so the editor shows exactly what `plumb check` and CI report: the rule id as the code, the message and its remedy, on the line the check named.

- A violation and an incomplete check are both errors. A repository-wide failure, such as a missing tool, is shown on `plumb.json`.
- A file that becomes clean is cleared on the next save.
- The server is read-only. It keeps the `--root`, `--config`, `--policy` and `--adapters` it was started with.

## Configuration

Any editor with a generic language client can start it. Neovim:

```lua
vim.lsp.config("plumb", {
  cmd = { "node", "tools/plumb/bin/plumb.ts", "lsp" },
  root_markers = { "plumb.json" },
})
vim.lsp.enable("plumb")
```

Helix, in `.helix/languages.toml`:

```toml
[language-server.plumb]
command = "node"
args = ["tools/plumb/bin/plumb.ts", "lsp"]

[[language]]
name = "typescript"
language-servers = ["typescript-language-server", "plumb"]
```

Zed and JetBrains editors need a language-client extension to launch an arbitrary server; point it at the same command.

VS Code needs no extension: a task with a problem matcher puts every diagnostic in the Problems panel, on its file and line. In `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "plumb check",
      "type": "shell",
      "command": "node tools/plumb/bin/plumb.ts check",
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": {
        "owner": "plumb",
        "fileLocation": ["relative", "${workspaceFolder}"],
        "pattern": {
          "regexp": "^(.+?)(?::(\\d+))? \\[([^\\]]+)\\] (.*)$",
          "file": 1,
          "line": 2,
          "code": 3,
          "message": 4
        }
      }
    }
  ]
}
```

`plumb check --format sarif --output ../plumb.sarif` writes the same result for any SARIF viewer.

## Limits

Each run checks the whole repository, so a save takes as long as `plumb check`. Diagnostics describe saved files, not unsaved buffers.
