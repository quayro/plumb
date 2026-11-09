# 0002 Title-only commits

## Status

Accepted

## Context

Commit bodies and trailers drift into release notes, tool advertisements and co-author noise, and agents fill them freely. Squash merges replace local messages with the pull request title.

## Decision

A commit message is exactly one Conventional Commit subject. Bodies, trailers, fixups, squashes and merge commits are refused locally by the generated hook and in CI over every commit in the range and the pull request title.

## Consequences

Detail belongs in code comments, documentation and the pull request. Bots must be configured to produce passing subjects, and fixups must be autosquashed before pushing.
