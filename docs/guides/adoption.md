# Adopting a policy

A repository with history rarely passes a new policy on the first day. These recipes move it to full enforcement without a clean-up sprint and without ever reporting a failure as a pass.

## Recipes

### Observe before enforcing

```sh
plumb check --observe
```

`--observe` reports every violation and exits 0. The report keeps `status: "violation"` and adds `observed: true`, so nothing reads as a pass. An incomplete run still exits 2: a check that could not run is not an observation.

### Freeze what exists

```sh
plumb baseline
```

`baseline` prints one budgeted exception per rule for today's violations. Review the entries, replace the reason and add them to `exceptions`. From then on a new violation fails, and a fixed one makes its budget stale until the budget shrinks.

### Refuse regressions

```sh
plumb check --base origin/main
```

The [policy ratchet](policy-ratchet.md) refuses a larger budget, a new exception or a wider exclude. Budgets only shrink.

### Track progress

```sh
plumb progress --base origin/main
```

| Field          | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `totals`       | violations, incomplete diagnostics, suppressed count, budget    |
| `rules`        | per rule: what still fails and what an exception hides          |
| `exceptions`   | per exception: `used` against `max`, and its expiry             |
| `budgetChange` | with `--base`: how the total budget moved; negative is progress |

`progress` keeps the exit code of the check it ran. Save one report per commit with `--output` to chart the trend.

### Upgrade a policy

```sh
plumb upgrade --policy ../candidate.json
```

`upgrade` checks the repository under its own policy and under the candidate, and reports:

| Field         | Meaning                                                           |
| ------------- | ----------------------------------------------------------------- |
| `changes`     | every changed policy pointer, classified tighten, neutral, weaken |
| `diagnostics` | what the candidate newly reports                                  |
| `resolved`    | what it no longer reports                                         |
| `exceptions`  | baseline entries that would budget the candidate's violations     |

It exits 1 when the candidate introduces violations and 2 when the candidate cannot be checked completely. It writes nothing.

## Order

1. `plumb init`, then `plumb check --observe` in CI for visibility.
2. `plumb baseline`, review, add the exceptions, drop `--observe`.
3. Add `--base` in CI so budgets and exclusions cannot grow.
4. Fix violations rule by rule; lower each `max` as `exceptions.stale` asks.
5. Tighten with `plumb upgrade --policy` before each policy change.
