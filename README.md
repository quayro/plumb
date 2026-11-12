# Plumb

<div align="center">

**Repository conventions, enforced — not remembered.**

**A flexible, extensible repository contract engine for humans and coding agents.**  
Define what belongs in your codebase. Plumb checks it deterministically, explains violations, and refuses to treat an incomplete check as a pass.

<p>
  <a href="https://github.com/quayro/plumb/actions/workflows/verify.yml"><img alt="CI" src="https://github.com/quayro/plumb/actions/workflows/verify.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22.18+" src="https://img.shields.io/badge/Node.js-22.18%2B-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="docs/reference/compatibility.md"><img alt="Multi-language" src="https://img.shields.io/badge/support-multi--language-6f42c1"></a>
  <a href="docs/guides/agents.md"><img alt="Agent-ready" src="https://img.shields.io/badge/integration-MCP%20%7C%20LSP-555"></a>
</p>

[**Get started**](#quick-start) · [**Explore features**](#what-plumb-enforces) · [**Policy packs**](#choose-your-conventions) · [**Agent integrations**](#built-for-coding-agents) · [**Documentation**](#documentation)

</div>

---

## Why Plumb?

Coding agents can overlook instructions, and people can disagree about conventions. Documentation alone cannot reliably prevent drift.

**Plumb makes repository conventions executable.** A reviewed `plumb.json` describes the rules for files, architecture, documentation, commits, tests, and more. The same policy runs locally, in editors, through agent tools, and in CI.

> **Your repository chooses the conventions. Plumb enforces the contract.**

## What Plumb enforces

|     | Capability                   | What it covers                                                                                         |
| :-: | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| 📁  | **Repository structure**     | Required or forbidden files, names, companion files, and generated assets.                             |
| 🧩  | **Architecture**             | Module boundaries, dependency restrictions, ownership, imports, exports, and public API snapshots.     |
| 🛠️  | **Language-aware checks**    | Engines for TypeScript/JavaScript, React, Python, and Rust: format, lint, types and source policy.     |
| 📝  | **Documentation & commits**  | Documentation structure, generated regions, links, task markers, and commit subjects.                  |
| ✅  | **Verification**             | Required test suites, fresh test reports, coverage thresholds, and controlled exceptions.              |
| 🔒  | **Policy integrity**         | Pinned policy bundles, protected files, policy-diff checks, and checks that cannot silently skip work. |
| 🤖  | **Agent & editor workflows** | File-specific instructions, an MCP server, an LSP server, and actionable diagnostics.                  |

The **core uses only Node.js built-ins**. Language-specific tools run through optional packs and adapters. See the [capability matrix](docs/reference/compatibility.md) for exactly what each language supports.

## Quick start

**Requirements:** Git and Node.js **22.18+**. Language-specific checks may require additional, pinned tools.

Plumb is currently installed by **vendoring a pinned copy** into a repository, rather than through a published npm package.

```bash
# Get Plumb once.
git clone https://github.com/quayro/plumb.git ~/src/plumb

# In the Git repository you want to protect:
cd /path/to/your/repository

# Install a pinned copy under tools/plumb.
node ~/src/plumb/bin/plumb.ts vendor --root .

# Create a policy from the repository's detected needs.
node tools/plumb/bin/plumb.ts init --interactive

# Generate policy-owned integrations, then inspect the current state.
node tools/plumb/bin/plumb.ts sync
node tools/plumb/bin/plumb.ts check --observe
```

Review the generated `plumb.json`, install any tools required by your selected profiles, and enable the relevant Git hooks/CI integration. Once the baseline is ready, enforce it with:

```bash
node tools/plumb/bin/plumb.ts check
```

**Exit codes:** `0` = complete success · `1` = policy violation · `2` = incomplete check or invalid invocation. **A check that cannot run never passes.** Observe mode reports violations without failing, but still fails on incomplete checks.

For the full installation, hook, and CI procedure, follow the [getting started guide](docs/getting-started/index.md).

## Choose your conventions

Start with a preset and combine reusable **policy packs**, or define repository-specific rules. Built-in packs include `hygiene`, `secrets`, `conventional-commits`, and `open-source`.

```bash
# Discover available packs.
node tools/plumb/bin/plumb.ts packs

# Alternatively, start with packs suited to a library.
node tools/plumb/bin/plumb.ts init --type library
```

A compact `plumb.json` might look like this:

```json
{
  "schemaVersion": 1,
  "preset": "portable",
  "files": {
    "required": ["README.md", "LICENSE"]
  },
  "rules": [
    {
      "id": "no-unfinished-tasks",
      "files": ["src/**/*.ts"],
      "forbid": "\\bTODO\\b",
      "reason": "Tracked source must not contain unfinished task markers.",
      "remedy": "Complete the work or move the task to the issue tracker."
    }
  ]
}
```

Policies are validated against the [JSON Schema](plumb.schema.json). Packs can be pinned by hash and composed for teams, projects, and repositories. Conflicting policy choices are reported instead of silently overridden.

**Learn more:** [Policy packs](docs/guides/packs.md) · [Custom rules](docs/guides/custom-rules.md) · [Policies and exceptions](docs/concepts/policy.md)

## Built for coding agents

Agents can retrieve the conventions _before_ they edit and receive the same verdict as CI _after_ they edit.

```bash
# Generate readable instructions from the effective policy.
node tools/plumb/bin/plumb.ts instructions

# See the rules that apply to a particular file.
node tools/plumb/bin/plumb.ts inspect --file src/example.ts

# Explain a rule and its remedy.
node tools/plumb/bin/plumb.ts explain RULE_ID

# Expose read-only policy tools over MCP (stdio).
node tools/plumb/bin/plumb.ts mcp
```

The MCP server exposes **instructions, file inspection, planning, checking, and rule explanations**. A separate LSP server provides editor diagnostics. Neither server silently rewrites policy files.

[Agent integration guide](docs/guides/agents.md) · [Editor setup](docs/guides/editors.md)

## Adopt without rewriting everything

Existing codebases do not need to become perfect overnight.

```bash
# See current violations without treating them as compliant.
node tools/plumb/bin/plumb.ts check --observe

# Propose reviewed, budgeted exceptions for existing debt.
node tools/plumb/bin/plumb.ts baseline

# Prevent policy weakening relative to the base revision.
node tools/plumb/bin/plumb.ts check --base origin/main

# Inspect compliance progress.
node tools/plumb/bin/plumb.ts progress --base origin/main
```

Exceptions need a reason and a budget; source-level suppression comments do not switch off Plumb rules. Repairs are conservative and reviewable.

[Adoption guide](docs/guides/adoption.md) · [Policy ratchet](docs/guides/policy-ratchet.md)

## Extensible by design

| Layer                 | Responsibility                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Core**              | File inventory, policy validation, execution, diagnostics, and integrity checks.                                              |
| **Policy packs**      | Reusable conventions that can be composed and pinned.                                                                         |
| **Language engines**  | Type-aware and language-specific checks with established tooling.                                                             |
| **External adapters** | Add new languages or tools using the [versioned adapter protocol](docs/guides/adapters.md) and [SDK](packages/sdk/README.md). |
| **Integrations**      | Git hooks, CI, MCP, and LSP, all backed by the same policy.                                                                   |

The public adapter protocol records capabilities, inputs, tool versions, coverage, and diagnostics. Missing coverage or invalid adapter results are **incomplete**, not successful.

[Architecture](docs/architecture/index.md) · [Adapters](docs/guides/adapters.md) · [Compatibility](docs/reference/compatibility.md)

## Documentation

| Start here                                              | For                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| [Getting started](docs/getting-started/index.md)        | Installation, generated hooks, and CI.                           |
| [Guides](docs/guides/index.md)                          | Policy packs, rules, formatting, testing, and adoption.          |
| [CLI reference](docs/reference/cli.md)                  | Available commands and flags.                                    |
| [Compatibility](docs/reference/compatibility.md)        | Supported runtimes, languages, and integrations.                 |
| [Roadmap and limitations](docs/reference/roadmap.md)    | Implemented capabilities and known limitations.                  |
| [Contributing](docs/contributing/index.md)              | Branches, pull requests, review, merge and release.              |
| [Commit messages](docs/guides/commits.md)               | The one-line commit policy and how to word a subject.            |
| [CI and branch protection](docs/guides/ci.md)           | Required checks and the GitHub repository settings.              |
| [Repository conventions](docs/reference/conventions.md) | The effective machine-checked policy of this repository.         |
| [AGENTS.md](AGENTS.md)                                  | The boundaries every change keeps, for people and coding agents. |

## Contributing

Issues, bug reproductions, policy packs, and adapters are welcome. Contributions to a rule should include passing, failing, and bypass-oriented tests. A change lands through a pull request that the required checks pass on, squash-merged with its title as the one commit subject. Read the [contribution guide](docs/contributing/index.md) before changing behavior.

## License

Plumb is distributed under the [MIT License](LICENSE).
