# Prismatic workflow

This file follows an issue from filing to merge on the [Prismatic delivery](https://github.com/users/samlevin/projects/2) board, and describes the tracker workflows that keep the board in sync. [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) defines the issue types, the triage tables, the labels, and what each Status means. [AGENTS.md](AGENTS.md) states the same branch, PR, claim, and status rules for coding agents. A change to one of those rules changes both files.

## Issues, containers, and epics

File each issue with the form that fits it; [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md#issue-types) says when to use a Task, Bug, Container, or Epic. Add a container's pieces as native sub-issues. Only leaves are claimed, branched, and closed by a PR. The tracker closes a container or epic, as [Automation](#automation) describes.

## Status

An issue moves through Inbox, Ready, In progress, In review, and Done, in that order. [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md#status) says what each Status means. Whoever claims an issue sets In progress, and the tracker sets every other Status. Nobody sets In review or Done by hand.

## Dependencies

[ISSUE_TRIAGE.md](ISSUE_TRIAGE.md#dependencies) says how to mark an issue that waits on another. To start a blocked issue before its blocker merges, stack on the blocker's open PR as [Size and stacked PRs](#size-and-stacked-prs) describes.

## Claiming work

Before you start, assign yourself, comment with your plan, and move the issue to In progress. Without write access you can't do the first and last steps: comment with your plan, and someone with write access assigns the issue and moves it. If you drop an issue, say so in a comment.

## Branch names

Name the branch `<login>/<issue>-<slug>`, where `<login>` is your GitHub login. Run `node scripts/branch-name.mjs <issue> --actor <login>` and use its output before the first commit; never pick a name by hand. Keep the name once the branch is pushed. Nothing in CI checks branch names.

## Pull requests and review

- Title the PR with [Conventional Commits](https://www.conventionalcommits.org/), e.g. `feat: add CSV export`.
- Fill in the PR template. Put `Closes #N` for the issue the PR finishes, and link the parent issue if there is one.
- Add tests for behavior you change, and update docs if you change how something is used or operated.
- Open the PR ready for review. The reviewer checks it against the issue's acceptance criteria and the template's checklist.

## Size and stacked PRs

Past roughly 400 lines of changed production code (not counting tests, docs, or lockfiles), split the work into stacked PRs. Each layer is its own branch and PR on top of the previous one, and `--layer <n>` names layers 2 and up with `-part-<n>`. Early layers reference the issue, and only the last one closes it.

To build on another issue's open PR, branch from that PR's branch, name your branch for your own issue, and set your PR's base to that branch.

## Automation

The tracker workflows need the `PRISMATIC_PROJECT_TOKEN` repository secret, because the default `GITHUB_TOKEN` cannot write to a user project. The token shares its account's API rate limits with that account's local `gh` use. When a GitHub call fails, the script logs GitHub's error type and message, says when a rate limit resets, and never prints the token or `gh` output beyond that.

[tracker-project-membership.yml](.github/workflows/tracker-project-membership.yml) adds every issue to the board when it opens, however it was created. GitHub's API cannot turn on the project's built-in auto-add, so this workflow does it instead. It sets a new issue's Status to Inbox, and an issue that already has a Status keeps it. The same run then triages the issue, once its project item exists. Running it again for an issue already on the board changes nothing. Run it by hand from the Actions tab to add every open issue missing from the board; `dry_run` defaults to true and lists the issues it would add. Pull requests never go on the board, so the board counts only issues. Nothing else adds items, and the issue forms don't name the project.

[tracker-issue-states.yml](.github/workflows/tracker-issue-states.yml) moves triaged issues from Inbox to Ready, moves every closed issue to Done and every reopened issue out of Done to Ready, and closes a container once all its sub-issues are closed. The project's built-in workflows are off, and the API cannot turn them on, so this workflow is the only thing that sets Done.

- It runs for one issue when the issue is reopened or closed, when a `severity:` label, `epic`, or `automation: container-closed` is added or removed, and when any label on an epic changes, so triage can remove category labels that conflict with `epic`. Other label changes skip the job. That run reconciles only the issue, its project item, and its parent and sub-issue chain.
- Priority and Size are project fields, and changing them starts no run. The hourly sweep picks them up.
- The hourly sweep, which GitHub can delay, runs in one job. It first adds open issues missing from the board, in case GitHub created no run for an `opened` event. That step lists open issues 100 at a time with their project items and adds each missing one with Status Inbox, and writes nothing when none are missing. When one issue fails, it logs the failure, carries on, and fails the step at the end. Then it triages the whole project and closes finished containers. Each step runs even when an earlier one fails, and the run then fails.
- The triage and container sweeps read the whole project in a few GraphQL queries and log the points they used. Each is skipped with a warning when fewer than 1,000 points remain in the token's hourly budget, because people and local agents share that budget. When a run for one issue hits the rate limit, it logs a warning and succeeds, and the next sweep applies the change. A rate-limit error in a sweep, and any other error, fails the run.
- Run it by hand from the Actions tab with `dry_run`, which defaults to true, to preview all three sweeps.

Two more tracker workflows run when a pull request opens, reopens, or leaves draft, and when its description is edited. An edit that changes only the title or the base starts no work, because neither workflow reads them.

[tracker-pr-metadata.yml](.github/workflows/tracker-pr-metadata.yml) copies the linked issue's labels, assignees, and milestone onto the pull request, so a pull request inherits the owner of the issue it closes; nothing assigns people to issues. Run it by hand with a pull request number and `dry_run`, which defaults to true.

[tracker-pr-issue-status.yml](.github/workflows/tracker-pr-issue-status.yml) moves every issue the pull request closes to In review, from Ready or In progress for collaborators and from In progress only for everyone else. It skips a draft pull request until it leaves draft. It logs a skip instead of failing when an issue isn't on the board.
