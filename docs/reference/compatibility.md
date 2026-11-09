# Compatibility and capabilities

## Environments

| Environment  | Status                                                                                  |
| ------------ | --------------------------------------------------------------------------------------- |
| Node         | 22.18 or newer; CI runs 22.18.0 and 24                                                  |
| Bun          | the pinned version in `package.json`, for installs and standalone builds                |
| Linux, macOS | every suite runs in CI on both                                                          |
| Windows      | standalone binaries are built for `bun-windows-x64`; the suites are not run there in CI |
| Git          | 2.30 or newer for change-coupling rules, which compare the work tree with a merge base  |
| Network      | none: every check is offline, and inputs outside the repository are pinned by hash      |

## Languages

| Language                 | Provided by                    | Syntax or types     | Lint and policy            | Format            | Boundaries                      |
| ------------------------ | ------------------------------ | ------------------- | -------------------------- | ----------------- | ------------------------------- |
| TypeScript, JavaScript   | JavaScript pack (`typescript`) | TypeScript Programs | ESLint, Knip               | Prettier          | imports, exports, API surface   |
| React                    | JavaScript pack (`react`)      | TypeScript Programs | ESLint with React rules    | Prettier          | imports, exports, API surface   |
| Ruby                     | native (`ruby`)                | RuboCop             | RuboCop                    | RuboCop           |                                 |
| C and C++                | native (`cpp`)                 | clang-tidy          | clang-tidy                 | clang-format      |                                 |
| Python                   | adapter (`python`)             | `ast` and `compile` | directives, skips, excepts |                   | forbidden and dynamic imports   |
| Go                       | adapter (`go`)                 | tokenizer           | directives, skips          |                   | forbidden imports               |
| Any text                 | core                           |                     | custom rules, comments     | tables, JSON keys | file names, required, forbidden |
| SQL, shell, TOML, Prisma | core `format.tools`            |                     |                            | pinned formatter  |                                 |

## Capabilities by surface

| Capability                        | CLI                                                  | MCP tool       | Editor |
| --------------------------------- | ---------------------------------------------------- | -------------- | ------ |
| Full check                        | `check`                                              | `check`        | `lsp`  |
| Conventions before editing a file | `inspect --file`                                     | `inspect_file` |        |
| Policy as instructions            | `instructions`                                       | `instructions` |        |
| Planned checks and coverage       | `plan`                                               | `plan`         |        |
| Rule purpose, remedy and kind     | `explain`                                            | `explain`      |        |
| Safe repairs with preview         | `fix`, `fix --dry-run`                               |                |        |
| Adoption and progress             | `baseline`, `progress`, `upgrade`, `check --observe` |                |        |
| Policy ratchet                    | `check --base`, `policy-diff`                        |                |        |
| Adapter conformance               | `conformance`                                        |                |        |
| Install verification              | `version`, `doctor`                                  |                |        |

## Hook managers and CI

| Integration | Support                                                          |
| ----------- | ---------------------------------------------------------------- |
| git hooks   | generated `.githooks/pre-commit` and `commit-msg`                |
| husky       | verified invocation in `.husky/`                                 |
| lefthook    | verified invocation in `lefthook.yml`                            |
| pre-commit  | verified invocation in `.pre-commit-config.yaml`                 |
| GitHub      | generated `.github/workflows/plumb.yml` and `.github/CODEOWNERS` |
