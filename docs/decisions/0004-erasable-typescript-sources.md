# 0004 Erasable TypeScript sources

## Status

Accepted

## Context

Plumb holds the repositories it checks to strict typed rules, and its own code should meet the same rules. Plain JavaScript can only be typed with JSDoc block comments, which the ozmikhail comment rule refuses. The core must still run straight from a vendored folder, before any install and without a build.

## Decision

All of Plumb's code is TypeScript limited to erasable syntax: no enums, namespaces or parameter properties, type-only imports written `import type`, and relative imports that name the `.ts` file. Node 22.18 or later runs it by stripping types, and Bun runs it as is. The JavaScript pack imports the core by relative path, because it always ships inside the Plumb folder.

## Consequences

The entry point is `bin/plumb.ts`. Node refuses to strip types under `node_modules`, so Plumb runs from a vendored folder or a workspace link whose real path is outside `node_modules`, never from an installed package.
