# Contributing to Prismatic

All planned work lives in GitHub issues. Before you start something, make sure there's an issue for it, and keep decisions and scope changes on that issue or its PR. The [Prismatic delivery](https://github.com/users/samlevin/projects/2) board tracks status, priority, and size.

## Filing an issue

Pick a template when you open a new issue:

- **Task** or **Bug** for a single change. Describe what done looks like in the acceptance criteria.
- **Container** for a group of related issues. Explain what, why, and how, then add the pieces as sub-issues. A container has no PR of its own and closes on its own once all its sub-issues are closed.
- **Epic** for a large body of work, usually tied to a milestone. Only use it when you mean it. A big task alone doesn't need to be an epic.

Keep titles plain ("Add CSV export", not "[Task]: Add CSV export"). Labels carry the type. If one issue has to wait on another, mark it with GitHub's "blocked by" relationship.

## Triage

Each issue gets a priority, a size, and one severity label. Priority defaults to P2.

| Severity | Meaning | Priority |
| --- | --- | --- |
| critical | Outage, data loss, serious security impact | P0 while active, else P1 |
| high | Important functionality broken | P1 |
| medium | Bounded defect | P2 |
| low / none | Minor defect / planned work | P2, or P3 if optional |

| Size | Scope |
| --- | --- |
| XS | Narrow edit |
| S | One component |
| M | One outcome across a few components |
| L | Too big to start; break it down first |

For the type, use one of `bug`, `enhancement`, or `documentation`, and add `area:` labels for the parts of the repo affected. An epic gets the `epic` label instead of a type label. [.github/labels.json](.github/labels.json) lists the labels. Its shared core is identical to mcc-stats-suite's. To change a shared label, edit the file in both repos and apply the change by hand in both with `gh label create`, `gh label edit`, or `gh label delete`.

## Status

| Status | Meaning |
| --- | --- |
| Inbox | New and not triaged yet |
| Ready | Triaged; set automatically once priority, size, and severity are filled in |
| In progress | Someone is working on it |
| In review | A PR is open |
| Done | Merged |

Before you start an issue, assign yourself, leave a short comment saying what you plan to do, and move it to In progress. If you drop it, say so in a comment.

## Pull requests

- Title it with [Conventional Commits](https://www.conventionalcommits.org/), e.g. `feat: add CSV export`.
- Fill in the PR template. Put `Closes #N` for the issue the PR finishes, and link the parent issue if there is one.
- Run the tests before you push: `node --test scripts/*.test.mjs`.
- Add tests for behavior you change, and update docs if you change how something is used or operated.
- Keep PRs reviewable. Past roughly 400 lines of changed production code (not counting tests, docs, or lockfiles), split the work into stacked PRs.

## Automation

A GitHub Action keeps the board tidy. It moves triaged issues from Inbox to Ready, and it closes a container once all its sub-issues are closed. It needs the `PRISMATIC_PROJECT_TOKEN` repository secret. Details are in [.github/workflows/issue-triage.yml](.github/workflows/issue-triage.yml).
