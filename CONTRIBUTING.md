# Contributing to Prismatic

This guide covers setting up, running the checks, and submitting a change. Two more files hold the rest:

- [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md) says how to file and classify an issue: the issue types, severity, priority, size, labels, and what each Status means.
- [WORKFLOW.md](WORKFLOW.md) says how to claim and deliver an issue, from claim to merge, and how the tracker workflows keep the board in sync.

## Setup

Follow [Setup](README.md#setup) in the README.

## Submitting a change

1. Find the issue for the change, or file one and classify it by [ISSUE_TRIAGE.md](ISSUE_TRIAGE.md).
2. Claim it, branch, and open a pull request as [WORKFLOW.md](WORKFLOW.md) describes.
3. Run the [checks](#checks) before you push.

## Checks

Run `npm run check` before you push. It runs the format check, lint of JavaScript, TypeScript, and Markdown, the strict TypeScript check, the generated agent definition check, every script test, and the Vitest unit tests with the 90% coverage gate. `npm run format` and `npm run lint:fix` fix what they can in code. Fix Markdown lint problems by hand. `.tool-versions` pins the Node version that CI uses.

When you change the `Dockerfile`, `.dockerignore`, `docker/`, or `apps/action/`, also run `npm run test:container`. It builds the Action image and runs the container smoke test, so it needs Docker and network access for the build. CI does not run it yet.

### CI

[ci-checks.yml](.github/workflows/ci-checks.yml) runs only the checks a pull request needs. The `Detect changed areas` job classifies the changed files with `scripts/ci-scope.mjs`, read from the base commit, so a change to the classifier applies only after it merges.

A pull request that changes only Markdown outside `.agents/`, `.claude/`, `.codex/`, `.github/`, `scripts/`, `src/`, `apps/`, `tooling/`, `tests/`, and `evals/`, or `LICENSE`, runs the format check and the Markdown lint, `npm run lint:md`. Prettier ignores Markdown, so the Markdown lint is the only check that reads it. Anything else, including a path the classifier doesn't know, runs the format check, lint of every file, `npm run typecheck`, `npm run agents:check`, every `scripts/*.test.mjs`, and `npm run test:unit`, which fails when coverage drops below 90%. CI installs the Node version in `.tool-versions` and runs `npm ci` first. Pushes to `main` run every check, and so does a pull request whose files can't be classified.

The `Require every check selected for the changed files` job always runs, even in a cancelled run, and fails unless every selected check passed. Require this job, not the individual checks, in the `main` ruleset: GitHub reports a skipped job as passing, so a required check must never be skipped.

[ci-secret-scan.yml](.github/workflows/ci-secret-scan.yml) runs Gitleaks on every pull request and push to `main`. [ci-pr-title.yml](.github/workflows/ci-pr-title.yml) fails a pull request whose title doesn't follow Conventional Commits.

## Workflow naming

Workflow files are named `<area>-<name>.yml`, and each workflow is named `<Area>: <name>`. The areas are `ci` for checks on pull requests and pushes, and `tracker` for the project board. Every job and step has a name that says what it does. `scripts/workflow-names.test.mjs` enforces this.
