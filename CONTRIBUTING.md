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

For the type, use one of `bug`, `enhancement`, or `documentation`, and add `area:` labels for the parts of the repo affected. An epic gets the `epic` label instead of a type label. The full list is in [.github/labels.json](.github/labels.json).

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

- Name the branch `<actor>/<issue>-<slug>`, where the actor is `agent` for AI agents and your GitHub login for people, and later stacked layers append `-part-2`, `-part-3`. Run `node scripts/branch-name.mjs <issue>` (add `--actor <login>` for people, `--layer <n>` for stacked layers) and rename the worktree branch to its output before the first commit; never pick a name by hand. CI rejects other names, and Release Please and Dependabot branches are exempt. Branches opened before this rule fail the check on their next push; rename on GitHub with `gh api -X POST repos/samlevin/prismatic/branches/<old>/rename -f new_name=<new>` so the PR survives, then close and reopen it to re-run the check, because a rename emits no pull_request event; never push a new branch and delete the old one, which closes the PR for good.
- Title it with [Conventional Commits](https://www.conventionalcommits.org/), e.g. `feat: add CSV export`.
- Fill in the PR template. Put `Closes #N` for the issue the PR finishes, and link the parent issue if there is one.
- Run the tests before you push: `node --test scripts/*.test.mjs`.
- Add tests for behavior you change, and update docs if you change how something is used or operated.
- Keep PRs reviewable. Past roughly 400 lines of changed production code (not counting tests, docs, or lockfiles), split the work into stacked PRs.

## Automation

A GitHub Action keeps the board tidy. It moves triaged issues from Inbox to Ready, and it closes a container once all its sub-issues are closed. It needs the `PRISMATIC_PROJECT_TOKEN` repository secret. Details are in [.github/workflows/issue-triage.yml](.github/workflows/issue-triage.yml).

Two more actions run when a pull request opens, is edited, or leaves draft. [pr-issue-metadata.yml](.github/workflows/pr-issue-metadata.yml) copies the linked issue's labels, milestone, and project membership onto the pull request. [pr-issue-status.yml](.github/workflows/pr-issue-status.yml) moves every issue the pull request closes to In review, from Ready or In progress for collaborators and from In progress only for everyone else. Both use the same secret and log a skip instead of failing when an issue is not on the board.

[secret-scan.yml](.github/workflows/secret-scan.yml) runs gitleaks on every pull request and push to `main`, and [semantic.pr.yaml](.github/workflows/semantic.pr.yaml) fails a pull request whose title does not follow Conventional Commits.

The [CI workflow](.github/workflows/ci.yml) runs `node --test scripts/*.test.mjs` on pull requests and on pushes to `main`.
