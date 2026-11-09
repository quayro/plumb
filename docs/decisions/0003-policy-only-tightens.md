# 0003 Policy only tightens without review

## Status

Accepted

## Context

An agent that cannot satisfy a rule can edit the policy in the same change: add an exception, widen an exclude or raise a budget. Those edits pass an ordinary check.

## Decision

`plumb check --base REF` classifies every policy change against the base revision and refuses anything that is not a tightening or a neutral change. Unclassified changes count as weakening. Protected files are owned through a generated CODEOWNERS file.

## Consequences

Loosening the policy needs a person to override the required check and a code owner's review. Ordinary tightening needs neither.
