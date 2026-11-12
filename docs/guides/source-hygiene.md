# Source hygiene

These checks apply to every language Plumb can read.

## Coverage

Plumb lists files with `git ls-files --cached --others --exclude-standard`, so ignored files stay out and nothing tracked is hidden. Outside git it walks the tree. Under the `ozmikhail` preset, a recognized source file that no project or adapter covers is `projects.uncovered` or `projects.unsupported` (incomplete). Add a project, an adapter or an `exclude` entry with a reason.

## Suppression comments

Comments that switch a tool off are refused in every supported comment syntax: `eslint-disable`, `@ts-ignore`, `prettier-ignore`, `biome-ignore`, `stylelint-disable`, `markdownlint-disable`, `noqa`, `type: ignore`, `pragma: no cover`, `nosec`, `pylint: disable`, `fmt: off`, `nolint`, `shellcheck disable`, `hadolint ignore`, `yamllint disable`, `istanbul ignore`, `c8 ignore`, `v8 ignore` and similar. A real exception is a reasoned entry in `plumb.json`.

## Task markers

Under `ozmikhail`, `TODO`, `FIXME`, `XXX` and `HACK` in comments are refused unless the marker matches `comments.tasks`, for example `"TODO\\(#\\d+\\)"` to require an issue reference.
