# Contributing to Prismatic

All planned work lives in GitHub issues. Make sure an issue exists before you start, and keep decisions and scope changes on that issue or its PR. The [Prismatic delivery](https://github.com/users/samlevin/projects/2) board tracks status, priority, and size.

## Filing an issue

Pick a template:

- **Task** or **Bug** for a single change, with acceptance criteria that say what done looks like.
- **Container** for a group of related issues: explain what, why, and how, and add the pieces as sub-issues. A container has no PR and closes once all its sub-issues close.
- **Epic** for a large body of work, usually tied to a milestone, and only when you mean it. A big task alone isn't an epic.

Keep titles plain ("Add CSV export", not "\[Task]: Add CSV export"); labels carry the type.

## Triage

[ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) defines severity, Priority, Size, labels, and when to split work into sub-issues.

## Status

| Status | Meaning |
| --- | --- |
| Inbox, or no Status | New and not triaged yet; the membership workflow sets Inbox on a new issue, and triage treats both the same |
| Ready | Triaged; triage moves an Inbox issue here once priority, size, and severity are filled in |
| In progress | Someone is working on it |
| In review | A PR is open |
| Done | Closed; set automatically when an issue closes, and a reopened issue moves back to Ready |

## Dependencies

When one issue has to wait on another, mark it with GitHub's "blocked by" relationship. A blocked issue waits for its blocker to merge, unless you stack on the blocker's open PR (see [Pull requests](#pull-requests)).

## Claiming work

Before you start, assign yourself, comment with your plan, and move the issue to In progress. Without write access you can't do the first and last steps: comment with your plan, and someone with write access assigns the issue and moves it. If you drop an issue, say so in a comment.

## Pull requests

- Name the branch `<login>/<issue>-<slug>`, where `<login>` is your GitHub login. Run `node scripts/branch-name.mjs <issue> --actor <login>` and use its output before the first commit; never pick a name by hand. Nothing in CI checks branch names.
- Title the PR with [Conventional Commits](https://www.conventionalcommits.org/), with a component scope, e.g. `fix(tracker): skip archived items`.
- Fill in the PR template. Put `Closes #N` for the issue the PR finishes, and link the parent issue if there is one.
- Add tests for behavior you change, and update docs if you change how something is used or operated.
- Past roughly 400 lines of changed production code (not counting tests, docs, or lockfiles), split the work into stacked PRs. Each layer is its own branch and PR on top of the previous one; `--layer <n>` names layers 2 and up with `-part-<n>`. Early layers reference the issue, and only the last one closes it.
- To build on another issue's open PR, branch from that PR's branch, name your branch for your own issue, and set your PR's base to that branch.

## Checks

Run `npm run check` before you push. It runs the format check, lint of JavaScript, TypeScript, and Markdown, the strict TypeScript check, the generated agent definition check, every script test, and the Vitest unit tests with the 90% coverage gate. `npm run format` and `npm run lint:fix` fix what they can in code. Fix Markdown lint problems by hand. `.tool-versions` pins the Node version that CI uses.

When you change the `Dockerfile`, `.dockerignore`, `docker/`, or `apps/action/`, also run `npm run test:container`. It builds the Action image and runs the container smoke test, so it needs Docker and network access for the build. CI does not run it yet.

## Automation

Workflow files are named `<area>-<name>.yml`, and each workflow is named `<Area>: <name>`. The areas are `ci` for checks on pull requests and pushes, and `tracker` for the project board. Every job and step has a name that says what it does. `scripts/workflow-names.test.mjs` enforces this.

[ci-checks.yml](.github/workflows/ci-checks.yml) runs only the checks a pull request needs. The `Detect changed areas` job classifies the changed files with `scripts/ci-scope.mjs`, read from the base commit, so a change to the classifier applies only after it merges.

A pull request that changes only Markdown outside `.agents/`, `.claude/`, `.codex/`, `.github/`, `scripts/`, `src/`, `apps/`, `tooling/`, `tests/`, and `evals/`, or `LICENSE`, runs the format check and the Markdown lint, `npm run lint:md`. Prettier ignores Markdown, so the Markdown lint is the only check that reads it. Anything else, including a path the classifier doesn't know, runs the format check, lint of every file, `npm run typecheck`, `npm run agents:check`, every `scripts/*.test.mjs`, and `npm run test:unit`, which fails when coverage drops below 90%. CI installs the Node version in `.tool-versions` and runs `npm ci` first. Pushes to `main` run every check, and so does a pull request whose files can't be classified.

The `Require every check selected for the changed files` job always runs, even in a cancelled run, and fails unless every selected check passed. Require this job, not the individual checks, in the `main` ruleset: GitHub reports a skipped job as passing, so a required check must never be skipped.

[ci-secret-scan.yml](.github/workflows/ci-secret-scan.yml) runs Gitleaks on every pull request and push to `main`. [ci-pr-title.yml](.github/workflows/ci-pr-title.yml) fails a pull request whose title doesn't follow Conventional Commits.

The tracker workflows keep the project in step with the work.

The [project membership workflow](.github/workflows/tracker-project-membership.yml) adds every new issue to Prismatic delivery when it opens, however it was created, sets its Status to Inbox when it has none, and then runs that issue's first triage. An existing Status never changes. GitHub sometimes starts no run for an issue's `opened` event, so the hourly sweep described below adds any open issue that is missing from the project. An issue archived in the project counts as present. An `opened` run that hits the GraphQL rate limit logs a warning and succeeds, and the next sweep adds the issue. A membership sweep logs an issue it cannot add, continues with the rest, and fails at the end. An issue deleted or transferred before the sweep adds it gets a warning and does not fail the sweep. Run a membership sweep alone by hand from this workflow in the Actions tab; a manual run is a dry run that lists the missing issues unless you clear `dry_run`. Pull requests are not added to the project. Adding an item that is already in the project changes nothing. It runs trusted default-branch code only and uses `PRISMATIC_PROJECT_TOKEN`.

The [issue states workflow](.github/workflows/tracker-issue-states.yml) uses deterministic GitHub API calls, with no model usage. It moves an open issue whose Status is empty or Inbox to Ready when Priority, exactly one supported severity, and Size are present. Other statuses are left alone by metadata triage. A sweep asks the project only for open issues whose Status is not Ready, In progress, In review, or Done, so it never reads items that cannot qualify. It also keeps Done equal to closed: it moves every closed issue to Done, whatever its Status, and moves a reopened issue still in Done back to Ready. For that, a sweep asks only for closed issues not in Done and open issues in Done. Ready means triaged; implementation still requires clear scope, acceptance criteria, validation, and satisfied dependencies.

It also removes conflicting standard labels and any `type:` label from issues labeled `epic`, preserving severity, area, and risk metadata. It closes any container when all direct children are closed and updates its project status to Done. Nested completion rolls up in the same run. If an unfinished child appears, it reopens only containers carrying the automation's `automation: container-closed` marker and sets their status to Ready. Manually closed containers are left alone. An empty issue is never auto-closed. Closed children count as complete regardless of close reason; a cancelled child should have its scope removed or reassigned before closure.

An issue event reconciles only that issue: triage reads its own project item, and container reconciliation reads its sub-issue subtree and its ancestors. Reopening and closing an issue start a run. Adding or removing a label starts one only for a `severity:` label, `epic`, or `automation: container-closed`, or for any label on an issue labeled `epic`. Opening an issue and editing its title or body start no run. One hourly job in the issue states workflow runs three sweeps in order on one runner: it adds open issues missing from the project, triages every issue, and reconciles every container. It catches project field and hierarchy edits that lack an Actions trigger. Each sweep runs even when an earlier one failed, and the job fails at the end if any sweep failed. A manual run of the issue states workflow runs the same three sweeps and is a dry run unless you clear `dry_run`. Each run logs the GraphQL budget before and after. A sweep skips with a warning when fewer than 1,000 points remain. An issue event that hits the rate limit logs a warning and succeeds, because the next sweep repeats its work.

Right after a batch's metadata and relationships are complete, the filing skills run `scripts/issue-triage.mjs` on each new issue and `scripts/issue-containers.mjs` on each new top-level container. `scripts/issue-containers.mjs --issue N` reconciles the named issue's container subtree and ancestors, never unrelated issues. Both scripts default to dry-run. Actions uses `PRISMATIC_PROJECT_TOKEN`, a token with write access to the Prismatic delivery project. Creating or changing it requires explicit authorization. Local use relies on existing `gh` authentication. Do not print credentials or copy them during ordinary issue filing. Workflow activation requires publication on `main`; runtime field IDs are discovered. Concurrent human edits can race API writes, so avoid competing reconciliation sessions.

[tracker-pr-metadata.yml](.github/workflows/tracker-pr-metadata.yml) copies the linked issue's labels, assignees, and milestone onto the pull request, so a pull request inherits the owner of the issue it closes; nothing assigns people to issues.

When a non-draft PR is opened, reopened, marked ready for review, or has its body edited, the [PR issue status workflow](.github/workflows/tracker-pr-issue-status.yml) moves open issues named by closing keywords to `In review`: from `In progress` for any author, and also from `Ready` for the owner and collaborators. It skips other statuses and ordinary issue mentions, and its run logs each skip with the reason. It runs separately from `tracker-pr-metadata.yml`, so a status lookup failure does not block PR metadata. Both workflows read linked issues from the PR body only, so an edit to the title or base branch starts no job in either. It also uses `PRISMATIC_PROJECT_TOKEN`.
