# Repository guidance for agents

Issue tracker: GitHub Issues

This line turns on the GitHub issue workflows (`implement #N`, GitHub issue creation) for this repository. Without it, agents use Jira.

## Delivery binding

- Repository: `samlevin/prismatic`; trunk: `main`; project: [Prismatic delivery](https://github.com/users/samlevin/projects/2).
- Triage, statuses, and pull-request rules: [CONTRIBUTING.md](CONTRIBUTING.md). Labels: [.github/labels.json](.github/labels.json). Issue forms: `.github/ISSUE_TEMPLATE/`.
- After creating issues and their relationships, run `node scripts/issue-triage.mjs --apply --issue NUMBER` for each new issue and `node scripts/issue-containers.mjs --apply --issue NUMBER` for each new top-level container, then read back the results.
- Discover project field IDs and options from GitHub. Never hard-code them.
