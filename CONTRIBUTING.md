# Contributing to Prismatic

All planned work lives in GitHub issues. Make sure an issue exists before you start, and keep decisions and scope changes on that issue or its PR. The [Prismatic delivery](https://github.com/users/samlevin/projects/2) board tracks status, priority, and size.

## Filing an issue

Pick a template:

- **Task** or **Bug** for a single change, with acceptance criteria that say what done looks like.
- **Container** for a group of related issues: explain what, why, and how, and add the pieces as sub-issues. A container has no PR and closes once all its sub-issues close.
- **Epic** for a large body of work, usually tied to a milestone, and only when you mean it. A big task alone isn't an epic.

Keep titles plain ("Add CSV export", not "[Task]: Add CSV export"); labels carry the type.

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

Add one type label (`bug`, `enhancement`, or `documentation`; an epic gets `epic` instead) and an `area:` label for each part of the repo affected. Each directory under `packages/` that contains a `package.json` is an npm workspace and needs a `package: <directory>` label, and a test fails when one is missing. [.github/labels.json](.github/labels.json) has the full list.

## Status

| Status | Meaning |
| --- | --- |
| Inbox | New and not triaged yet |
| Ready | Triaged; set automatically once priority, size, and severity are filled in |
| In progress | Someone is working on it |
| In review | A PR is open |
| Done | Merged |

## Dependencies

When one issue has to wait on another, mark it with GitHub's "blocked by" relationship. A blocked issue waits for its blocker to merge, unless you stack on the blocker's open PR (see [Pull requests](#pull-requests)).

## Claiming work

Before you start, assign yourself, comment with your plan, and move the issue to In progress. Without write access you can't do the first and last steps: comment with your plan, and someone with write access assigns the issue and moves it. If you drop an issue, say so in a comment.

## Pull requests

- Name the branch `<login>/<issue>-<slug>`, where `<login>` is your GitHub login. Run `node scripts/branch-name.mjs <issue> --actor <login>` and use its output before the first commit; never pick a name by hand. Nothing in CI checks branch names.
- Title the PR with [Conventional Commits](https://www.conventionalcommits.org/), e.g. `feat: add CSV export`.
- Fill in the PR template. Put `Closes #N` for the issue the PR finishes, and link the parent issue if there is one.
- Add tests for behavior you change, and update docs if you change how something is used or operated.
- Past roughly 400 lines of changed production code (not counting tests, docs, or lockfiles), split the work into stacked PRs. Each layer is its own branch and PR on top of the previous one; `--layer <n>` names layers 2 and up with `-part-<n>`. Early layers reference the issue, and only the last one closes it.

## Checks

Run `npm run check` before you push. It runs the format check, lint, the generated agent definition check, and every script test. `npm run format` and `npm run lint:fix` fix what they can. `.tool-versions` pins the Node version that CI uses.

## Automation

Workflow files are named `<area>-<name>.yml`, and each workflow is named `<Area>: <name>`. The areas are `ci` for checks on pull requests and pushes, and `tracker` for the project board. Every job and step has a name that says what it does. `scripts/workflow-names.test.mjs` enforces this.

[ci-checks.yml](.github/workflows/ci-checks.yml) runs only the checks a pull request needs. The `Detect changed areas` job classifies the changed files with `scripts/ci-scope.mjs`, read from the base commit, so a change to the classifier applies only after it merges.

A pull request that changes only Markdown outside `.agents/`, `.claude/`, `.codex/`, `.github/`, and `scripts/`, or `LICENSE`, runs the format check. Anything else, including a path the classifier doesn't know, also runs lint, `npm run agents:check`, and every `scripts/*.test.mjs`. Pushes to `main` run every check, and so does a pull request whose files can't be classified.

The `Require every check selected for the changed files` job always runs, even in a cancelled run, and fails unless every selected check passed. Require this job, not the individual checks, in the `main` ruleset: GitHub reports a skipped job as passing, so a required check must never be skipped.

[ci-secret-scan.yml](.github/workflows/ci-secret-scan.yml) runs Gitleaks on every pull request and push to `main`. [ci-pr-title.yml](.github/workflows/ci-pr-title.yml) fails a pull request whose title doesn't follow Conventional Commits.

[tracker-issue-states.yml](.github/workflows/tracker-issue-states.yml) moves triaged issues from Inbox to Ready and closes a container once all its sub-issues are closed. It needs the `PRISMATIC_PROJECT_TOKEN` repository secret.

Two more tracker workflows run when a pull request opens, is edited, or leaves draft, and use the same secret. [tracker-pr-metadata.yml](.github/workflows/tracker-pr-metadata.yml) copies the linked issue's labels, assignees, milestone, and project membership onto the pull request, so a pull request inherits the owner of the issue it closes; nothing assigns people to issues.

[tracker-pr-issue-status.yml](.github/workflows/tracker-pr-issue-status.yml) moves every issue the pull request closes to In review, from Ready or In progress for collaborators and from In progress only for everyone else. Both log a skip instead of failing when an issue isn't on the board.
