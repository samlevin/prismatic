# Agent rules

These rules apply to every coding agent, including Claude Code and Codex. Prismatic has no product code yet. It holds the issue workflow (issue forms, labels, and the Node scripts in `scripts/` that keep the project board in sync) and the agent workflows described below. CONTRIBUTING.md is the guide for people. Read it or any other guide only when the task changes that file or a rule here sends you there.

## Checks

Run the narrowest set that covers your change, once before pushing. `npm run format` and `npm run lint:fix` fix what they can in code. Fix Markdown lint problems by hand.

| Changed | Run |
| --- | --- |
| Docs only | `npm run lint:md` |
| `scripts/`, `.github/`, or root configuration | `npm run check` (format, lint, agent definitions, and every script test) |
| `.agents/`, `.claude/`, `.codex/`, or `scripts/agent-policy*` | `npm run agents:generate` after editing a source, then `npm run check` |

CI picks its checks from the changed files, as CONTRIBUTING.md describes. Tests mock GitHub and never call it.

## Autonomous delivery

- A delivery request authorizes issue claims, project moves, commits, pushes, and ready-for-review PRs. Filing authorizes issue publication. Review authorizes no edits or PR writes. Merges, deployments, destructive operations, and changes to GitHub repository settings, CI secrets, or agent tool settings require explicit user authorization.
- Each writer works in its own git worktree based on fresh `origin/main`: the one your tool creates (Claude Code: `.claude/worktrees/`), or else one you add with `git worktree add` under the ignored `.codex/worktrees/`. Never edit, install, build, or switch branches in the human checkout, and never modify a worktree you did not create. If your worktree holds changes you did not make, stop and report them instead of committing or discarding them.
- When a leaf lacks Priority or Size, set Priority to P2 and Size from the scope, as `.agents/issue-creation.md` does. Missing tracker metadata alone does not block delivery. Stop for a concrete unmet prerequisite or missing acceptance criteria.
- When a leaf depends on an unmerged prerequisite PR that is open, ready for review, passing checks, and pre-PR approved, stack on it without asking: create the worktree from fresh `origin/main`, base the branch on the prerequisite branch, and record its head SHA in your claim. Split one leaf into stacked layers only when each layer is reviewable on its own; line count alone does not require a stack.
- Hand off after the final push. Include acceptance criteria, verified prerequisites, repo, branch, worktree path, the head SHA, and the base SHA from `git merge-base <base> HEAD`. Rework handoffs include the existing PR URL.
- Use independent code review for changes across components, shared contracts, security boundaries, and other substantial behavior changes. Always use it, however small the diff, for any change to `.agents/`, `.claude/`, `.codex/`, `AGENTS.md`, `scripts/agent-policy*`, or `.github/workflows/`. Elsewhere, skip it for localized low-risk changes, documentation, and mechanical edits. Reviewers check the diff and relevant callers against the supplied criteria. They may run read-only `git` and `gh` commands, but never edit files or run project code.
- Docs, READMEs, specs, agent instructions, and code comments describe the current state: what exists and how to set it up and run it. The history of changes and fixes goes in PR bodies, commit messages, and changelogs. A code comment may keep prior context only to explain an established regression the code must not reintroduce.
- Report what changed, the PR URL, checks and results, and any concrete blocker. Report current CI status without waiting for, polling, or rerunning remote CI.

## Repository agent workflows

The repository ships the same delivery roles, handoffs, and checks for Claude Code (`.claude/agents/`, `.claude/skills/`) and Codex (`.codex/agents/`, `.agents/skills/`). Tool runtime details live in these definitions, not in configuration outside the repository. Every identifier starts with `prism-` so it cannot collide with a same-named agent or skill defined elsewhere, and routing always names the `prism-` definition. The definitions are generated from `.agents/roles/`, `.agents/workflows/`, and `.agents/policy.json`: edit the source, run `npm run agents:generate`, and commit the output, or ask `prism-agents` to do all three. `.agents/README.md` has the layout and the trust requirements.

| Request | Claude Code | Codex | Role it dispatches |
| --- | --- | --- | --- |
| `implement #N`, an issue URL, or a PR URL | `/prism-implement` | `$prism-implement` | `prism-orchestrator` for an issue with native sub-issues, else `prism-implementer` |
| File or draft issues | `/prism-create-github-issue` | `$prism-create-github-issue` | `prism-issue-triager` (read-only metadata) |
| File a specification's delivery plan as a root container, epics, and leaves | `/prism-spec-to-issues` | `$prism-spec-to-issues` | none; follows `.agents/spec-slicing.md` |
| Review a pushed branch or PR | `/prism-review-code` | `$prism-review-code` | `prism-code-reviewer` (read-only, reports to you) |
| Security review, only when a person asks | `/prism-review-security` | `$prism-review-security` | `prism-security-reviewer` (read-only) |
| Write a PR body, issue body, comment, or doc | `/prism-plain-language` | `$prism-plain-language` | none |
| Change, add, or regenerate these agents and skills | `/prism-agents` | `$prism-agents` | none; edits sources, regenerates both tools, verifies |

- Serial delivery: `prism-orchestrator` dispatches one executable leaf at a time in dependency order and starts the next only after the previous leaf's PR is open or its blocker is recorded. Sibling leaves never run concurrently, even on request.
- Handoffs: `prism-implementer` spawns `prism-code-reviewer` before opening a PR when the review rule above applies, and `prism-stack-manager` for stacked branches. Nothing else spawns a reviewer, and no automatic flow spawns `prism-security-reviewer`.
- Model and effort: `.agents/policy.json` names the model and effort for each role, per tool. Every dispatcher runs `node scripts/agent-policy.mjs resolve --tool <claude|codex> --role <role>` and passes the result explicitly when it spawns, never inheriting a session or user default. An explicit `model <name>` or `effort <level>` in the request overrides only that setting, for that task and the handoffs it names (`reviewer effort max`), and changes nothing on disk. Unsupported values fail with a message instead of substituting another model or effort.
- Reports: each agent's report ends with `Requested settings: Policy: <as dispatched>`, plus one such line for every role it spawned, and relaying skills print those lines verbatim. The lines record what was requested. Reports never claim the model was verified, never ask a model to identify itself, and carry no `Runtime:` line or other remark about which model ran.

## Branch names

Name every branch you push for an issue `agent/<issue>-<slug>`, where `<issue>` is the leaf the PR closes, even when the branch stacks on another issue's PR. Stacked layers after the first end in `-part-<n>`. Print the name with `node scripts/branch-name.mjs <issue>`, adding `--layer <n>` for layer 2 and up, and never type it by hand. Create the branch with that name, or run `git branch -m <name>` on the branch your tool created, before the first commit. Once a branch is pushed, keep its name even if the issue title changes. Nothing in CI checks branch names. For example, #5 gets `agent/5-generate-and-enforce-branch-names-from`, and its second layer adds `-part-2`.

A request with no issue uses `agent/<slug>`, built from a short description of the change by the same slug rules the script applies to issue titles: lowercase, accents dropped, every run of other characters turned into `-`, "Part N" written `partN`, cut to 40 characters at a word boundary, and `issue` when nothing is left.

## Hard rules

- Public repo: never commit secrets, account IDs, personal addresses, domains, state, plans, or populated env files.
- Run `scripts/issue-*.mjs` with `--apply` only as `.agents/issue-creation.md` directs. They default to a dry run.

## Delivery binding

Issue tracker: GitHub Issues. This marker turns on the GitHub issue flows (`implement #N`, GitHub issue filing).

Repo `samlevin/prismatic`, trunk `main`, project [Prismatic delivery](https://github.com/users/samlevin/projects/2). Discover project field IDs with `gh`.

- Triage, statuses, and PR rules live in [CONTRIBUTING.md](CONTRIBUTING.md); labels in [.github/labels.json](.github/labels.json); forms in `.github/ISSUE_TEMPLATE/`.
- PR titles use Conventional Commits, e.g. `feat: add CSV export`. Body: `Closes #N`, plus `Parent issue or epic: #P` when one exists. For a request with no issue, write `No linked issue.` instead and skip the issue state steps.
- Issue states: claim and move to `In progress` before coding. That is the only status an agent sets; agents never set `In review` or `Done`. `tracker-pr-issue-status.yml` moves the closing issue to `In review` when the PR opens. If the issue is not `In review` at handoff, because the workflow has not run, skipped the issue, or failed, report the state you see in the handoff and leave it unchanged.
- Issue titles are plain, with no `[Type]:` prefix. For issue filing, follow `.agents/issue-creation.md`.
