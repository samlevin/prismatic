# Issue triage

These rules classify and plan issues on the [Prismatic delivery](https://github.com/users/samlevin/projects/2) board. All planned work lives in GitHub issues: an issue exists before the work starts, and decisions and scope changes stay on that issue or its PR. Every issue gets a priority, a size, one severity label, a type label, and its `area:` labels.

## Issue types

- **Task** or **Bug** is a leaf: one logical change, with acceptance criteria that say what done looks like.
- **Container** groups related issues as native sub-issues. Its body explains what, why, and how, with no acceptance criteria. A container has no PR and closes once all its sub-issues close.
- **Epic** is a large body of work, usually tied to a milestone, filed only when someone asks for one. A big task alone isn't an epic.

Titles are plain ("Add CSV export", not "\[Task]: Add CSV export"). Labels carry the type.

## Severity and priority

Priority defaults to P2.

| Severity | Meaning | Priority |
| --- | --- | --- |
| critical | Outage, data loss, serious security impact | P0 while active, else P1 |
| high | Important functionality broken | P1 |
| medium | Bounded defect | P2 |
| low / none | Minor defect / planned work | P2, or P3 if optional |

## Size

| Size | Scope |
| --- | --- |
| XS | Narrow edit |
| S | One component |
| M | One outcome across a few components |
| L | Too big to start; break it down first |

## Labels

Add one type label: `bug`, `enhancement`, or `documentation`. An epic gets `epic` instead, as its only type label. Add exactly one `severity:` label and an `area:` label for each part of the repository the issue affects. [.github/labels.json](.github/labels.json) has the full list.

## Status

| Status | Meaning |
| --- | --- |
| Inbox | New and not triaged yet |
| Ready | Triaged; set automatically once priority, size, and severity are filled in |
| In progress | Someone is working on it |
| In review | A PR is open |
| Done | Closed; set automatically |

## Dependencies

When one issue has to wait on another, mark it with GitHub's "blocked by" relationship. A blocked issue waits for its blocker to merge, unless the work stacks on the blocker's open PR.
