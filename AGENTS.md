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

- A delivery request authorizes issue claims, project moves, commits, pushes, and ready-for-review PRs. Filing authorizes issue publication. Review authorizes no edits, and its only PR write is the one review `prism-review-code` posts to an open PR target through `publish-review`. Merges, deployments, destructive operations, and changes to GitHub repository settings, CI secrets, or agent tool settings require explicit user authorization.
- Each writer works in its own git worktree based on fresh `origin/main`: the one your tool creates, or else one you add with `git worktree add` under the ignored `.claude/worktrees/` (Claude Code) or `.codex/worktrees/` (Codex). The writer that creates a worktree runs every change in it, stack operations included; other agents only inspect it. Never edit, install, build, or switch branches in the human checkout, and never modify a worktree you did not create. If your worktree holds changes you did not make, stop and report them instead of committing or discarding them.
- When a leaf lacks Priority or Size, set Priority to P2 and Size from the scope, as `.agents/issue-creation.md` does. Missing tracker metadata alone does not block delivery. Stop for a concrete unmet prerequisite or missing acceptance criteria.
- When a leaf depends on an unmerged prerequisite PR that is open, ready for review, passing checks, and pre-PR approved, stack on it without asking: create the worktree from fresh `origin/main`, base the branch on the prerequisite branch, and record its head SHA in your claim. Stacked branches are built, linked, and cascaded only by the worktree's creator through the `prism-stack` skill and `gh stack`. Split one leaf into stacked layers only when each layer is reviewable on its own; line count alone does not require a stack.
- Handoffs carry the acceptance criteria, accepted decisions, verified prerequisites and their SHAs, the assigned scope, and the expected output. A delivery handoff after the final push adds the repo, branch, worktree path, the head SHA, and the base SHA from `git merge-base <base> HEAD`, and a rework handoff adds the existing PR URL. Recipients reuse the supplied facts and fetch only what is missing or stale, as `.agents/evidence.md` describes, instead of repeating tracker discovery. A reviewer still reads the diff, the issue, and the callers itself and never gets the implementer's self-assessment.
- Use independent code review for changes across components, shared contracts, security boundaries, and other substantial behavior changes. Always use it, however small the diff, for any change to `.agents/`, `.claude/`, `.codex/`, `AGENTS.md`, `scripts/agent-policy*`, or `.github/workflows/`. Elsewhere, skip it for localized low-risk changes, documentation, and mechanical edits. Reviewers check the diff and relevant callers against the supplied criteria. They may run read-only `git` and `gh` commands, but never edit files or run project code.
- Report what changed, the PR URL, checks and results, and any concrete blocker. Report current CI status without waiting for, polling, or rerunning remote CI.

## Code and comments

- Match the surrounding code's naming, idiom, and comment density. Add no checks for cases that cannot happen, no one-use helpers or wrappers, and no options nobody asked for.
- Comment only what the code cannot say: a constraint, a workaround, or an invariant. Keep it to one line. No comments that restate the code, no section banners, and no docstrings on obvious functions.
- Docs, specs, agent instructions, and comments describe the current state. Change history goes in PR bodies and commit messages. A comment may cite past behavior only to guard against a known regression.

## Repository agent workflows

The repository ships the same delivery roles, handoffs, and checks for Claude Code (`.claude/agents/`, `.claude/skills/`) and Codex (`.codex/agents/`, `.agents/skills/`). Tool runtime details live in these definitions, not in configuration outside the repository. Every identifier starts with `prism-` so it cannot collide with a same-named agent or skill defined elsewhere, and routing always names the `prism-` definition. The definitions are generated from `.agents/roles/`, `.agents/workflows/`, and `.agents/policy.json`: edit the source, run `npm run agents:generate`, and commit the output, or ask `prism-agents` to do all three. `.agents/README.md` has the layout and the trust requirements.

| Request | Claude Code | Codex | Role it dispatches |
| --- | --- | --- | --- |
| `implement #N`, an issue URL, or a PR URL | `/prism-implement` | `$prism-implement` | none by default: the invoking thread delivers a leaf or PR rework itself and runs a container as a dependency queue; `prism-code-reviewer` for the pre-PR gate; one isolated `prism-implementer` only as an explicit exception |
| Build, link, rebase, or sync stacked branches during delivery | `/prism-stack` | `$prism-stack` | none; the agent that created the worktree runs it |
| File or draft issues | `/prism-create-github-issue` | `$prism-create-github-issue` | none by default (inline classification); `prism-issue-triager` (read-only) when the batch needs independent classification, decomposition, or dependency judgment |
| File a specification's delivery plan as a root container, epics, and leaves | `/prism-spec-to-issues` | `$prism-spec-to-issues` | `prism-issue-triager` (read-only) for independence groups only; follows `.agents/spec-slicing.md` |
| Review a pushed branch or PR | `/prism-review-code` | `$prism-review-code` | `prism-code-reviewer` (read-only, reports to you); the skill posts the report as one review on an open PR target |
| Security review, only when a person asks | `/prism-review-security` | `$prism-review-security` | `prism-security-reviewer` (read-only) |
| Write a PR body, issue body, comment, or doc | `/prism-plain-language` | `$prism-plain-language` | none |
| Change, add, or regenerate these agents and skills | `/prism-agents` | `$prism-agents` | none; edits sources, regenerates both tools, verifies |

- Delivery: `prism-implement` makes the invoking thread the delivery owner. It delivers a leaf or a PR rework itself by [leaf delivery](.agents/workflows/implement/references/delivery.md), and a container as a [dependency queue](.agents/workflows/implement/references/queue.md) in dependency order, recording each leaf's result before the next leaf starts. Those two files are the procedures. One isolated `prism-implementer` may take a large leaf as a deliberate exception with a bounded assignment. Leaves run at the same time only when the request asks for parallel delivery, each leaf is substantial, and their parent's independence record puts them in different groups; at most one implementer runs per group, and a leaf the record does not list runs alone. Only `prism-issue-triager` forms those groups, and `.agents/issue-creation.md` defines them and their record. Nothing infers independence, and a request cannot widen the record.
- Handoffs: the delivery owner spawns `prism-code-reviewer` before opening a PR when the review rule above applies, and runs stack operations itself through `prism-stack`. Nothing else spawns a reviewer, and no automatic flow spawns `prism-security-reviewer`.
- Model and effort: `.agents/policy.json` names the model and effort for each role, per tool. Every dispatcher runs `node scripts/agent-policy.mjs resolve --tool <claude|codex> --role <role>` and passes the result explicitly when it spawns, never inheriting a session or user default. A skill cannot change the session model (Claude Code skill frontmatter pins a model only for the turn that loads the skill), so `prism-implement` delivers at the session settings and says so instead of spawning an agent to enforce the policy. An explicit `model <name>` or `effort <level>` in the request overrides only that setting, for that task and the handoffs it names (`reviewer effort max`), and changes nothing on disk. Unsupported values fail with a message instead of substituting another model or effort.
- Reports: each agent's report ends with `Requested settings: Policy: <as dispatched>`, plus one such line for every role it spawned, and relaying skills print those lines verbatim. Inline work reports `Advisory policy: ...` instead, because nothing dispatched it. The lines record what was requested. Reports never claim the model was verified, never ask a model to identify itself, and carry no `Runtime:` line or other remark about which model ran.

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
- Agents make their own GitHub calls through REST with `gh api`: issues, PRs, comments, labels, assignees, sub-issues, issue dependencies, and Projects v2 under `users/<owner>/projectsV2/<n>`. `gh issue`, `gh pr`, `gh project`, and `gh api graphql` spend the GraphQL limit that agents share with Actions tokens, so use them only for an operation REST lacks. When a GraphQL call is rate-limited, switch to REST instead of waiting. Repository code, such as GitHub Actions workflows and the scripts they run, keeps its GraphQL calls.
