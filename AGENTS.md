# Agent rules

These repository instructions apply to all coding agents, including Claude and Codex. The repository ships its own namespaced agents and skills for both tools (see [Repository agent workflows](#repository-agent-workflows)); tool runtime details live in those definitions, never in a contributor's personal configuration. Prismatic holds its issue workflow so far: issue forms, labels, and the Node scripts in `scripts/` that keep the project board in sync. There is no product code yet. Do not read CONTRIBUTING.md or other guides unless the task changes them or the loaded instructions lack a rule you need.

## Checks

Run the narrowest set that covers your change, once before pushing.

| Changed | Run |
| --- | --- |
| Docs only | Nothing |
| `scripts/`, `.github/`, or root configuration | `npm run check` (format, lint, agent definitions, and every script test) |
| `.agents/`, `.claude/`, `.codex/`, or `scripts/agent-policy*` | `npm run agents:generate` after editing a source, then `npm run check` |

Tests mock GitHub and never call it.

## Autonomous delivery

- A delivery request authorizes issue claims, project moves, commits, pushes, and ready-for-review PRs. Merges, deployments, destructive operations, and changes to GitHub repository settings, CI secrets, or agent tool settings require explicit user authorization.
- Each writer works in its own git worktree based on fresh `origin/main`. Use the worktree your tool creates (Claude Code: `.claude/worktrees/`); otherwise run `git worktree add` under the ignored `.codex/worktrees/` directory. Never edit, install, build, or switch branches in the human checkout. Never modify a worktree you did not create. If your worktree holds changes you did not make, stop and report them instead of committing or discarding them.
- When a leaf lacks Priority or Size, set Priority to P2 and Size from the scope, as `.agents/issue-creation.md` does. Missing tracker metadata alone does not block delivery. Stop for a concrete unmet prerequisite or missing acceptance criteria.
- When a leaf depends on an unmerged prerequisite PR, stack on it without asking: create the worktree from fresh `origin/main`, then base the branch on the prerequisite branch. You may build on an unmerged blocker whose PR is open, ready for review, passing checks, and pre-PR approved; record its head SHA in your claim. Split one leaf into stacked layers only when each layer is reviewable on its own; line count alone does not require a stack.
- Hand off after the final push. Include acceptance criteria, verified prerequisites, repo, branch, worktree path, the head SHA, and the base SHA from `git merge-base <base> HEAD`. Rework handoffs include the existing PR URL.
- Use independent code review for changes across components, shared contracts, security boundaries, and other substantial behavior changes. Skip it for localized low-risk changes, documentation, and mechanical edits. Reviewers check the diff and relevant callers against the supplied criteria. They may run read-only `git` and `gh` commands, but never edit files or run project code.
- Report what changed, the PR URL, checks and results, and any concrete blocker. Report current CI status without waiting for, polling, or rerunning remote CI.

## Repository agent workflows

Version-controlled agents and skills under `.claude/agents/` and `.claude/skills/` (Claude Code) and `.codex/agents/` and `.agents/skills/` (Codex) encapsulate delivery. Every identifier starts with `prism-`, so a contributor's own `code-reviewer` or `issue-implementer` keeps working, and routing always names the `prism-` definition. Both tools get the same roles, handoffs, and checks; only the packaging differs. The definitions are generated from `.agents/roles/`, `.agents/workflows/`, and `.agents/policy.json`, which are shared with mcc-stats-suite: edit the source, run `npm run agents:generate`, and commit the output, or ask `prism-agents` to do all three. `.agents/README.md` has the layout, the trust requirements, and how to pick up upstream source changes.

| Request | Claude Code | Codex | Role it dispatches |
| --- | --- | --- | --- |
| `implement #N`, an issue URL, or a PR URL | `/prism-implement` | `$prism-implement` | `prism-orchestrator` for an issue with native sub-issues, else `prism-implementer` |
| File or draft issues | `/prism-create-github-issue` | `$prism-create-github-issue` | `prism-issue-triager` (read-only metadata) |
| Review a pushed branch or PR | `/prism-review-code` | `$prism-review-code` | `prism-code-reviewer` (read-only, reports to you) |
| Security review, only when a person asks | `/prism-review-security` | `$prism-review-security` | `prism-security-reviewer` (read-only) |
| Write a PR body, issue body, comment, or doc | `/prism-write-prose` | `$prism-write-prose` | none |
| Change, add, or regenerate these agents and skills | `/prism-agents` | `$prism-agents` | none; edits sources, regenerates both tools, verifies |

- Serial delivery: `prism-orchestrator` dispatches one executable leaf at a time in dependency order and starts the next only after the previous leaf's PR is open or its blocker is recorded. Sibling leaves never run concurrently, even on request.
- Handoffs: `prism-implementer` spawns `prism-code-reviewer` before opening a PR when the review threshold above applies, and `prism-stack-manager` for stacked branches. Nothing else spawns a reviewer, and no automatic flow spawns `prism-security-reviewer`.
- Authority: filing authorizes issue publication; implementation authorizes claims, project moves, commits, pushes, and ready-for-review PRs; review authorizes no edits or PR writes. Merges, deployments, and settings changes keep their separate approval.
- Model and effort: `.agents/policy.json` names the model and effort for issue creation, triage, orchestration, implementation, stack management, code review, and security review, per tool. Every dispatcher runs `node scripts/agent-policy.mjs resolve --tool <claude|codex> --role <role>` and passes the result explicitly when it spawns; it never inherits a session or contributor default. An explicit `model <name>` or `effort <level>` in the request overrides only that setting, for that task and the handoffs it names (`reviewer effort max`), and changes nothing on disk. Unsupported values fail with a message instead of substituting another model or effort. Each agent's report ends with `Requested settings: Policy: <as dispatched>`, plus one such line for every role it spawned, and relaying skills print those lines verbatim. They record what was requested; reports never claim the model was verified and say nothing about which model ran.

## Branch names

Every branch an agent pushes for an issue is named `agent/<issue>-<slug>`. When one leaf is split into stacked layers, layers after the first end in `-part-<n>`. A branch stacked on another issue's PR uses its own issue's name:

- `<issue>` is the number of the leaf issue the PR closes, without `#`.
- `<slug>` is that issue's title in lowercase, with accents dropped and every run of other characters turned into `-`. "Part N" in the title becomes `partN`. The slug is cut to 40 characters at a word boundary, and is `issue` when the title has no ASCII letters or digits.
- Examples: `agent/5-generate-and-enforce-branch-names-from` for #5, and `agent/5-generate-and-enforce-branch-names-from-part-2` for its second stacked layer.

A request with no issue uses `agent/<slug>`, with the slug built by the same rules from a short description of the change.

For issue work, never type a branch name by hand. Print it with `node scripts/branch-name.mjs <issue>`, adding `--layer <n>` for layer 2 and up. Create the branch with that name, or run `git branch -m <name>` when your tool created the worktree branch under another name. Do this before the first commit. Once a branch is pushed, keep its name, even if the issue title changes later. Nothing in CI checks branch names, so following this rule is up to you.

## Hard rules

- Public repo: never commit secrets, account IDs, personal addresses, domains, state, plans, or populated env files.
- Run `scripts/issue-*.mjs` with `--apply` only as `.agents/issue-creation.md` directs. They default to a dry run.

## Delivery binding

Issue tracker: GitHub Issues. This marker turns on the GitHub issue flows (`implement #N`, GitHub issue filing).

Repo `samlevin/prismatic`, trunk `main`, project [Prismatic delivery](https://github.com/users/samlevin/projects/2). Discover project field IDs with `gh`.

- Triage, statuses, and PR rules live in [CONTRIBUTING.md](CONTRIBUTING.md); labels in [.github/labels.json](.github/labels.json); forms in `.github/ISSUE_TEMPLATE/`.
- PR titles use Conventional Commits, e.g. `feat: add CSV export`. Body: `Closes #N`, plus `Parent issue or epic: #P` when one exists. For a request with no issue, write `No linked issue.` instead and skip the issue state steps.
- Issue states: claim and move to `In progress` before coding. `tracker-pr-issue-status.yml` moves the closing issue to `In review` when the PR opens; move it yourself only if its run logs a skip. Never mark issues `Done`.
- Issue titles are plain, with no `[Type]:` prefix. For issue filing, follow `.agents/issue-creation.md`.
