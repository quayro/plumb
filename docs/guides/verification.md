# Tests and coverage

`verification` makes a test suite part of the check. Plumb runs the command in an isolated copy of the checked files, reads the report the run wrote, and refuses anything that is not fresh evidence of real tests.

## Policy

```json
{
  "verification": [
    {
      "id": "unit",
      "command": [
        "node",
        "--test",
        "--test-reporter=junit",
        "--test-reporter-destination={report}"
      ],
      "format": "junit",
      "report": "file",
      "minTests": 20,
      "maxSkipped": 0,
      "coverage": { "minLines": 80 }
    }
  ]
}
```

| Field               | Meaning                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| `format`            | `junit` or `plumb-json`                                                               |
| `report`            | `stdout` (default) or `file`, written to `{report}` or `$PLUMB_REPORT`                |
| `minTests`          | executed tests required; at least one                                                 |
| `maxSkipped`        | skipped tests permitted; none by default                                              |
| `coverage.minLines` | minimum percentage of lines executed, read from an lcov report the suite writes       |
| `cwd`, `timeout`    | where the command runs and how long it may take                                       |
| `env`, `inheritEnv` | the only environment the suite sees besides `PATH` and the temporary-directory values |

The suite writes its lcov report to `{coverage}` in the command, or to `$PLUMB_COVERAGE`. Other generated output goes to `{artifacts}`.

## Rules

| Rule                      | Reported when                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `verification.failed`     | a test failed                                                                               |
| `verification.skipped`    | more tests were skipped than `maxSkipped`                                                   |
| `verification.coverage`   | line coverage is below `minLines`                                                           |
| `verification.incomplete` | the command could not run, wrote no fresh report, ran too few tests or changed checked code |

A missing, empty or contradictory coverage report is `verification.incomplete`, never a pass. None of these rules can be excepted.
