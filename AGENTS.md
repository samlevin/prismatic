# Agent rules

## Delivery binding

Issue tracker: GitHub Issues. This marker turns on the GitHub issue flows (`implement #N`, GitHub issue filing); without it, agents use Jira.

Repo `samlevin/prismatic`, trunk `main`, project [Prismatic delivery](https://github.com/users/samlevin/projects/2). Discover project field IDs with `gh`.

- Triage, statuses, and PR rules live in [CONTRIBUTING.md](CONTRIBUTING.md); labels in [.github/labels.json](.github/labels.json); forms in `.github/ISSUE_TEMPLATE/`.
- Issue states: claim and move to `In progress` before coding; move to `In review` when the PR opens. Never mark issues `Done`.
- After filing issues and their relationships, run `node scripts/issue-triage.mjs --apply --issue N` per new issue and `node scripts/issue-containers.mjs --apply --issue N` per new top-level container, then read back.
