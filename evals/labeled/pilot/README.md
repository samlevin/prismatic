# Pilot labeled histories

The P0.11a pilot corpus: 10 synthetic pull request histories in the format [the evaluation protocol](../../protocol.md) defines. P0.12 (#146) runs them to find implementation and contract problems. They support no quality claim.

| History | Language | Rounds | Scenarios | Defects (severity, introduced, fixed) | Decoys |
| --- | --- | --- | --- | --- | --- |
| `go-config-from-env-clean` | go | 2 | clean-pr | none | none |
| `go-display-name-nil-profile` | go | 3 | correct-high-severity, incremental-fix, partial-fix | `nil-profile` (high, R1, fixed R3) | none |
| `go-page-window-off-by-one` | go | 2 | correct-high-severity, incremental-fix | `first-page-skipped` (high, R1, fixed R2) | none |
| `py-client-logs-auth-header` | python | 1 | correct-high-severity | `token-in-debug-log` (high, R1) | none |
| `py-counter-late-race` | python | 6 | late-round-regression, correct-high-severity | `unlocked-increment` (high, R6) | none |
| `py-order-total-guarded` | python | 1 | clean-pr, false-positive | none | `line-total-none` |
| `ts-format-units-caller` | typescript | 1 | correct-high-severity, cross-file | `caller-passes-cents` (high, R1) | none |
| `ts-invoice-role-check` | typescript | 1 | correct-high-severity, cross-file | `any-role-may-modify` (high, R1), `delete-not-admin-only` (high, R1) | none |
| `ts-retry-dismissed` | typescript | 3 | dismissed-finding | `zero-attempts` (medium, R1) | none |
| `ts-vendored-chart-excluded` | typescript | 1 | unreviewable-change | `vendor-escape-dropped` (high, R1, ineligible) | none |

In `go-display-name-nil-profile`, round 2 adds a nil check on the user rather than the profile, so the finding should persist; round 3 fixes it. In `ts-retry-dismissed`, the author dismisses the finding before round 2, and round 3 edits the same file and shifts its lines; the finding should stay dismissed. In `ts-vendored-chart-excluded`, the only defect is in a vendored file that policy excludes, so coverage should be partial and the defect never counts toward recall.

## Label status

An agent (`agent:prism-implementer`) wrote every label on 2026-10-19. The second check is pending for all 10 histories. The protocol requires that check before P0.12 scores anything.

To check a history, the checker reads its source round by round, then its defects, decoys and expected behavior, and decides whether each label is right. Then they replace `labels.check` with:

```json
{
  "status": "confirmed",
  "by": "<checker's GitHub login>",
  "on": "<YYYY-MM-DD>",
  "notes": "<what was checked, and any disagreement>"
}
```

Use `amended` instead of `confirmed` when the check changed a label, and say what changed in `notes`. Run `npx vitest run evals` afterwards. It fails when a label no longer matches its source.
