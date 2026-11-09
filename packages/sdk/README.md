# Adapter SDK

`adapter.ts` is one dependency-free file that speaks Plumb's external adapter protocol, version 1. Copy it beside your adapter or import it from a vendored checker; it needs Node 22.18 or newer and nothing else.

## API

| Export                         | Purpose                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| `serve(definition, script)`    | the whole command line: `--manifest`, or one request and one response |
| `respond(definition, request)` | answers one request as a value, for tests                             |
| `manifest(definition, script)` | the registry entry, with the runtime, the script and the SDK pinned   |
| `PROTOCOL`                     | the protocol version this file implements                             |

A definition is `id`, `version`, the `files` globs, `capabilities`, `rules` and `check`. `check` receives one source as `{ path, text }` with the project's validated options and returns findings: `{ rule, message }` with an optional `line`, `column` and `status: "incomplete"`. A rule id is written bare and reported as `ID/rule`.

## Guarantees

- A source is read from the request's `root` and checked only when its bytes match the requested hash. A mismatch, a missing file, invalid UTF-8, an exception from `check` or an undeclared rule is `ID/input`, incomplete.
- A request with another protocol version, adapter id, adapter version or action, or with a path that is absolute or leaves the repository, is `ID/protocol`, incomplete.
- A file is listed under `coverage` only when it was completely checked.
- The exit code is 0 for pass, 1 for violation and 2 for incomplete.

See the [adapters guide](../../docs/guides/adapters.md) for the protocol, the sandbox and the conformance probes.

## Testing

```sh
node scripts/test.ts adapters
```
