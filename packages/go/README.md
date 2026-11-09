# Optional Go adapter

This adapter adds Go source policy without a Go toolchain and without a dependency in Plumb's core. It is built on the [adapter SDK](../sdk/README.md) and needs Node 22.18 or newer.

## Installation

Keep the adapter and its registry outside the candidate repository:

```sh
node tools/plumb/packages/go/adapter.ts --manifest > "$HOME/.local/share/plumb-go/registry.json"
```

The manifest pins the Node binary, the adapter and the SDK by SHA-256. Add a Go project to the policy and pass the registry:

```json
{
  "schemaVersion": 1,
  "preset": "portable",
  "projects": [
    {
      "root": ".",
      "profile": "go",
      "options": {
        "forbiddenImports": [{ "path": "os/exec", "reason": "Use the reviewed runner" }]
      }
    }
  ]
}
```

```sh
plumb check --adapters "$HOME/.local/share/plumb-go/registry.json"
```

## Checks and limits

| Rule           | Behavior                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `go/import`    | an import of a forbidden path or of a package beneath it, however the declaration is written   |
| `go/directive` | `//nolint`, `// #nosec`, `//lint:ignore`, `//lint:file-ignore` and `//revive:disable` comments |
| `go/skip`      | `.Skip(`, `.Skipf(` and `.SkipNow(` calls in `_test.go` files                                  |
| `go/input`     | a source that cannot be read, does not match its hash or cannot be tokenized (incomplete)      |

The adapter tokenizes each file, so text inside strings, raw strings, runes and comments is never mistaken for code. Single, aliased, dot, blank and grouped imports are all read, including raw-string paths. `os/exec` matches `os/exec` and `os/exec/internal`, not `os/execx`. An import path written with escape sequences is incomplete, since its value cannot be compared literally.

It reads tokens, not types: it does not follow reflection, cgo, `plugin.Open`, `go:linkname` or generated code, and `go/skip` reports any method named `Skip` in a test file. Only `go/import` can be excepted. Run `go vet` and the tests as a [verification suite](../../docs/guides/verification.md) for what needs the compiler.

## Testing

```sh
node scripts/test.ts adapters
```
