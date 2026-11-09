# Adapters

An adapter adds a language or a tool without adding a dependency to the core. It is a separate program, listed in a reviewed registry outside the repository it checks, that answers one JSON request with one JSON response.

## Write one with the SDK

[`packages/sdk/adapter.ts`](../../packages/sdk/README.md) is a single dependency-free file. An adapter is its rules and a function from one source file to findings:

```ts
import { fileURLToPath } from "node:url";

import { serve } from "./sdk/adapter.ts";

serve(
  {
    id: "todo",
    version: "1.0.0",
    files: ["**/*.txt"],
    capabilities: ["policy"],
    rules: [{ id: "marker", description: "No task markers.", remedy: "Finish the task." }],
    check: ({ text }) =>
      text
        .split("\n")
        .flatMap((line, index) =>
          line.includes("TODO")
            ? [{ rule: "marker", message: "Task marker.", line: index + 1 }]
            : [],
        ),
  },
  fileURLToPath(import.meta.url),
);
```

`node adapter.ts --manifest > registry.json` prints the registry entry: the runtime, the script and the SDK, each pinned by its SHA-256. Keep the adapter and its registry outside the candidate repository and pass the registry with `--adapters`. A project selects the adapter by `profile`.

The SDK verifies every source against the hash in the request, namespaces rule ids, reports unreadable input as `ID/input` and a malformed request as `ID/protocol`, and exits with the code that matches its status. The [Go adapter](../../packages/go/README.md) and the [Python adapter](../../packages/python/README.md) are complete examples, one on the SDK and one without it.

## Protocol

Version 1 is stable: a field is never removed or given a new meaning, and a new optional field never changes an answer that omits it. A breaking change is a new `schemaVersion`, and an adapter refuses a version it does not know.

The protocol is published as [adapter-protocol.schema.json](../../adapter-protocol.schema.json): the registry entry, the request and the response as JSON Schema, generated from the code the core validates with. A test refuses a schema that is stale or that drops a field version 1 promises, so a change to the plugin API is always a reviewed diff.

A request arrives on standard input:

| Field           | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| `schemaVersion` | `1`                                                         |
| `action`        | `check`, or `doctor` to validate prerequisites only         |
| `adapter`       | the adapter id; `version` is the version the registry pins  |
| `root`          | the absolute checkout; the working directory is the project |
| `project`       | the policy's project entry, with its validated `options`    |
| `files`         | the selected sources, each `{ path, sha256 }`               |
| `inputs`        | every declared input the core observed, with its hash       |
| `capabilities`  | the capabilities the registry declares                      |

The response on standard output:

| Field           | Meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `schemaVersion` | `1`, with the same `adapter` and `version`                                   |
| `status`        | `pass`, `violation` or `incomplete`; the exit code is 0, 1 or 2 to match     |
| `diagnostics`   | `{ rule, path, message }` with optional `remedy`, `status`, `line`, `column` |
| `coverage`      | per capability, the files that were completely checked                       |
| `inputs`        | every file read, with the hash of the bytes read                             |
| `versions`      | the exact version of every tool the registry declares                        |

The core refuses a response whose identity, exit code or status disagree, that names an undeclared rule or a file outside its scope, that omits or misreports an input hash, or that follows a changed file. Any of these is incomplete, never a pass.

## Capabilities

A registry entry declares what it can do, and nothing else is credited to it:

| Field           | Declares                                                  |
| --------------- | --------------------------------------------------------- |
| `files`         | the globs it can check                                    |
| `capabilities`  | the kinds of check it performs; coverage is recorded each |
| `rules`         | every rule id, namespaced `ID/...`, with its capability   |
| `optionsSchema` | the project options it accepts; anything else is refused  |
| `tools`         | the exact tool versions it must report                    |
| `environment`   | the only environment variables it receives                |
| `inputs`        | extra files it may read, which become part of the hash    |
| `sandbox`       | whether the core runs it sandboxed                        |

## Sandbox

Set `"sandbox": true` on a registry entry for an adapter you did not write. The core then runs it so that it can read the checkout but cannot write a file or open a network connection: `sandbox-exec` on macOS, `bwrap` on Linux. Where no sandbox tool is available the adapter does not run and its checks are incomplete.

## Conformance

```sh
plumb conformance --adapters registry.json
```

Every adapter in the registry is run against a scratch project and probed:

| Probe             | The adapter must                                                 |
| ----------------- | ---------------------------------------------------------------- |
| `doctor`          | answer validly without claiming any source coverage              |
| `check`           | answer validly, with declared rules and the hash of what it read |
| `stale-hash`      | refuse a source whose bytes differ from the requested hash       |
| `foreign-version` | not pass a request for another adapter version                   |
| `malformed`       | not pass a request that is not JSON                              |
| `read-only`       | leave the project exactly as it found it                         |

A failed probe is `adapters.conformance`. Run it before pinning an adapter and again after every upgrade.

## Contributing an adapter or a rule

1. Build on the SDK, with `id` as the rule namespace and one `capability` per kind of check.
2. Ship passing, failing and bypass tests: the equivalent rewrites an agent would try, and the inputs the adapter cannot follow, which must be incomplete.
3. Pass `plumb conformance`, and state the limits of the analysis in the adapter's README.
4. Add the adapter to the [compatibility matrix](../reference/compatibility.md).

A convention that needs no parser belongs in the policy instead, as a [custom rule](custom-rules.md) or a [pack](packs.md).
