# Contributing to Prismatic

All planned work lives in GitHub issues. Make sure an issue exists before you start, and keep decisions and scope changes on that issue or its PR. The [Prismatic delivery](https://github.com/users/samlevin/projects/2) board tracks status, priority, and size.

## Filing an issue

Pick a template:

- **Task** or **Bug** for a single change, with acceptance criteria that say what done looks like.
- **Container** for a group of related issues: explain what, why, and how, and add the pieces as sub-issues. A container has no PR and closes once all its sub-issues close.
- **Epic** for a large body of work, usually tied to a milestone, and only when you mean it. A big task alone isn't an epic.

Keep titles plain ("Add CSV export", not "\[Task]: Add CSV export"); labels carry the type.

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

[ci-security.yml](.github/workflows/ci-security.yml) runs the supply-chain checks on every pull request, every push to `main`, once a week, and by hand. Its jobs:

- `Review dependency changes` runs GitHub's dependency review on pull requests and fails when a change adds or updates a dependency with a known advisory of any severity. It allows the GHSA IDs of the unexpired entries in `tooling/security/npm-audit-triage.json`. The action cannot tie an allowed advisory to a package, so it allows a triaged advisory in any package, while `npm audit` triage allows it only in the package the entry names.
- `Audit npm advisories and licenses` runs `npm audit` and passes only when every advisory it reports is fixed or has an unexpired entry in `tooling/security/npm-audit-triage.json`. It also checks every package in `package-lock.json` against `tooling/security/license-policy.json`.
- `Audit shipped code for dangerous process patterns` runs `tooling/security/ProcessPatternAudit.ts` over every non-test `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, and `.jsx` file under `src/` and `apps/`. Only `src/repository/ReadOnlyProcessRunner.ts` may import `spawn` and only `apps/action/main.ts` may import `spawnSync`. No shipped file may use `eval`, `Function`, `require`, a `constructor` property other than `constructor.name`, a call argument that names one of those, a computed or URL import, a code-loading built-in such as `node:vm`, a process loader such as `process.binding`, or a `shell` option other than `false`. It is a static check, so a name assembled at run time can get past it.
- `Verify pinned native binary checksums` downloads every artifact in `docker/binaries.lock` and `tooling/security/tools.lock` and checks its SHA-256 with `docker/fetch-pinned.sh`. The weekly run catches an upstream release that was replaced after it was pinned.
- `Scan the Action image and record SBOMs` builds the image, uploads CycloneDX SBOMs of the npm lockfile and of the image as the `sbom` artifact, and fails when Trivy finds a secret in the image or a high or critical vulnerability with a fix available that `tooling/security/trivy-ignore.yaml` does not list. Trivy itself comes from `tooling/security/tools.lock`, checked by checksum. Trivy cannot see Git or ast-grep, because neither leaves package metadata in the image, so `tooling/security/LockedBinariesSbom.ts` adds both to the image SBOM from `docker/binaries.lock`. The vulnerability scan still does not cover them. Check their security advisories by hand whenever you change `docker/binaries.lock`.

When `npm audit` reports an advisory that has no fix you can take, add an entry to `tooling/security/npm-audit-triage.json` with the GHSA ID, the affected package, why the advisory does not reach the Action, and an `expires` date at most 180 days away. The audit fails once the date passes, so someone looks at the advisory again. It warns about entries for advisories npm no longer reports. When the image scan reports a vulnerability that is fixed upstream but in no base image yet, check whether a newer `node` image or Dependabot pull request carries the fix and take it if one does. If none does, add an entry to `tooling/security/trivy-ignore.yaml` with the CVE or GHSA ID, a `statement` saying why it does not reach the Action or which update will remove it, and an `expired_at` date at most 30 days away. Trivy stops ignoring the entry on that date, so the scan fails until someone looks again. `tooling/security/TrivyIgnoreCheck.ts` fails the job on an entry with another field, no statement, or a later date. Never ignore a secret finding.

A package whose license the policy does not allow, or whose lockfile entry has no license, needs a replacement or a reviewed entry under `exceptions` in `tooling/security/license-policy.json` that names the exact version and the license you checked by hand.

Dependabot, configured in [dependabot.yml](.github/dependabot.yml), opens weekly pull requests for npm packages, the pinned actions, and the `Dockerfile` base image. It offers a version only after it has been published for seven days, and it never proposes a new Node.js major for the base image or `@types/node`. A base image update changes only the `Dockerfile`, so update `.tool-versions` and the workflow Node pins in the same pull request.

The tracker workflows need the `PRISMATIC_PROJECT_TOKEN` repository secret, because the default `GITHUB_TOKEN` cannot write to a user project. The token shares its account's API rate limits with that account's local `gh` use. When a GitHub call fails, the script logs GitHub's error type and message, says when a rate limit resets, and never prints the token or `gh` output beyond that.

[tracker-project-membership.yml](.github/workflows/tracker-project-membership.yml) adds every issue and pull request to the board when it opens, however it was created, including pull requests from forks. It runs only scripts from the default branch, never code from the pull request. GitHub's API cannot turn on the project's built-in auto-add, so this workflow does it instead. It also sets a new issue's Status to Inbox, so triage picks it up. Pull requests get no Status, and an issue that already has a Status keeps it. Running it again for an item already on the board changes nothing. Nothing else adds items, and the issue forms don't name the project.

[tracker-issue-states.yml](.github/workflows/tracker-issue-states.yml) moves triaged issues from Inbox to Ready and closes a container once all its sub-issues are closed.

Two more tracker workflows run when a pull request opens, is edited, or leaves draft. [tracker-pr-metadata.yml](.github/workflows/tracker-pr-metadata.yml) copies the linked issue's labels, assignees, and milestone onto the pull request, so a pull request inherits the owner of the issue it closes; nothing assigns people to issues.

[tracker-pr-issue-status.yml](.github/workflows/tracker-pr-issue-status.yml) moves every issue the pull request closes to In review, from Ready or In progress for collaborators and from In progress only for everyone else. It logs a skip instead of failing when an issue isn't on the board.
