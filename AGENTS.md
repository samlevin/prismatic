# Agent rules

These repository instructions apply to all coding agents, including Claude and Codex. Prismatic holds its issue workflow so far: issue forms, labels, and the Node scripts in `scripts/` that keep the project board in sync. There is no product code yet. Do not read CONTRIBUTING.md or other guides unless the task changes them or the loaded instructions lack a rule you need.

## Checks

Run the narrowest set that covers your change, once before pushing.

| Changed | Run |
| --- | --- |
| Docs only | Nothing |
| `scripts/` or `.github/` | `node --test scripts/*.test.mjs` |

Tests mock GitHub and never call it.

## Autonomous delivery

- A delivery request authorizes issue claims, project moves, commits, pushes, and ready-for-review PRs. Merges, deployments, destructive operations, and changes to GitHub repository settings, CI secrets, or agent tool settings require explicit user authorization.
- Each writer works in its own git worktree based on fresh `origin/main`. Use the worktree your tool creates (Claude Code: `.claude/worktrees/`); otherwise run `git worktree add` under the ignored `.codex/worktrees/` directory. Never edit, install, build, or switch branches in the human checkout. Never modify a worktree you did not create. If your worktree holds changes you did not make, stop and report them instead of committing or discarding them.
- When a leaf lacks Priority or Size, set Priority to P2 and Size from the scope, as `.agents/issue-creation.md` does. Missing tracker metadata alone does not block delivery. Stop for a concrete unmet prerequisite or missing acceptance criteria.
- When a leaf depends on an unmerged prerequisite PR, stack on it without asking: create the worktree from fresh `origin/main`, then base the branch on the prerequisite branch. You may build on an unmerged blocker whose PR is open, ready for review, passing checks, and pre-PR approved; record its head SHA in your claim. Split one leaf into stacked layers only when each layer is reviewable on its own; line count alone does not require a stack.
- Hand off after the final push. Include acceptance criteria, verified prerequisites, repo, branch, worktree path, the head SHA, and the base SHA from `git merge-base <base> HEAD`. Rework handoffs include the existing PR URL.
- Use independent code review for changes across components, shared contracts, security boundaries, and other substantial behavior changes. Skip it for localized low-risk changes, documentation, and mechanical edits.
- Report what changed, the PR URL, checks and results, and any concrete blocker. Report current CI status without waiting for, polling, or rerunning remote CI.

## Hard rules

- Public repo: never commit secrets, account IDs, personal addresses, domains, state, plans, or populated env files.
- Run `scripts/issue-*.mjs` with `--apply` only as `.agents/issue-creation.md` directs. They default to a dry run.

## Delivery binding

Issue tracker: GitHub Issues. This marker turns on the GitHub issue flows (`implement #N`, GitHub issue filing).

Repo `samlevin/prismatic`, trunk `main`, project [Prismatic delivery](https://github.com/users/samlevin/projects/2). Discover project field IDs with `gh`.

- Triage, statuses, and PR rules live in [CONTRIBUTING.md](CONTRIBUTING.md); labels in [.github/labels.json](.github/labels.json); forms in `.github/ISSUE_TEMPLATE/`.
- PR titles use Conventional Commits, e.g. `feat: add CSV export`. Body: `Closes #N`, plus `Parent issue or epic: #P` when one exists. For a request with no issue, write `No linked issue.` instead and skip the issue state steps.
- Issue states: claim and move to `In progress` before coding; move to `In review` when the PR opens. Never mark issues `Done`.
- Issue titles are plain, with no `[Type]:` prefix. For issue filing, follow `.agents/issue-creation.md`.
