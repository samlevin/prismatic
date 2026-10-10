# Agent rules

Prismatic holds only its issue workflow so far: issue forms, labels, and the Node scripts in `scripts/` that keep the project board in sync. There is no product code or package manifest yet. Do not read CONTRIBUTING.md unless the task changes it.

## Checks

| Changed | Run |
| --- | --- |
| Docs only | Nothing |
| `scripts/` or `.github/` | `node --test scripts/issue-*.test.mjs` |

Tests mock GitHub and never call it.

## Hard rules

- Public repo: never commit secrets, account IDs, personal addresses, domains, state, plans, or populated env files.
- Run `scripts/issue-*.mjs` with `--apply` only as `.agents/issue-creation.md` directs. They default to a dry run.

## Delivery binding

Repo `samlevin/prismatic`, trunk `main`, project [Prismatic delivery](https://github.com/users/samlevin/projects/2). Discover project field IDs with `gh`.

- PR titles use Conventional Commits, e.g. `feat: add CSV export`. Body: `Closes #N`, plus `Parent issue or epic: #P` when one exists.
- Issue states: claim and move to `In progress` before coding; move to `In review` when the PR opens. Never mark issues `Done`.
- You may build on an unmerged blocker whose PR is open, ready for review, passing checks, and pre-PR approved. Record its head SHA in your claim.
- Issue titles are plain, with no `[Type]:` prefix. For issue filing, follow `.agents/issue-creation.md`.
