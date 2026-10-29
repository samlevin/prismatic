# Agent rules

These rules apply to every coding agent, including Claude Code and Codex. Prismatic is a pull request review agent in one npm package: product modules under `src/` with lint-enforced import boundaries ([docs/adr/0002-single-package.md](docs/adr/0002-single-package.md)), maintainer tooling under `tooling/`, the CI scripts in `scripts/`, the issue workflow (issue forms, labels, and the board workflows that keep the project board in sync), and the agent workflows described below. The issue workflow and the agent workflows come from the `@agenticool/*` packages; the repository keeps `.agents/policy.json` and the files those packages generate and sync. CONTRIBUTING.md is the guide for people. Read it or any other guide only when the task changes that file or a rule here sends you there.

<!-- agenticool-agents sync: begin checks -->

## Checks

While editing, run only the focused tests for what you touched. Before the first push, run the narrowest set of this repository's checks that covers your change, once. After a fix, rerun the checks that cover what the fix touched, and run more when the fix or a failure shows the change reaches further. Never skip a required check, weaken an assertion, or drop a meaningful behavior test; report pre-existing failures as such. After changing `.agents/policy.json` or a source under `.agents/local/`, run `npx agenticool-agents generate`, then `npx agenticool-agents check`. [Evidence and waiting](.agents/evidence.md) governs retrieval, bounded output, edit inspection, and reuse of successful results.

<!-- agenticool-agents sync: end checks -->

| Changed | Run |
| --- | --- |
| Docs only | `npm run lint:md` |
| `src/`, `apps/`, `tooling/`, `scripts/`, `.github/`, `AGENTS.md`, `ISSUE_TRIAGE.md`, or root configuration | `npm run check` (format, lint with import boundaries, typecheck, generated and synced agent files, every script test, and the unit tests with the 90% coverage gate) |
| `Dockerfile`, `.dockerignore`, `docker/`, or `apps/action/` | `npm run check`, then `npm run test:container` (needs Docker) |
| `.agents/`, `.claude/`, `.codex/`, or the `@agenticool/*` versions | `npm run agents:generate` and `npx agenticool-agents sync` after changing the policy or a version, then `npm run check` |

`npm run format` and `npm run lint:fix` fix what they can in code. Fix Markdown lint problems by hand. CI picks its checks from the changed files, as CONTRIBUTING.md describes. Tests mock GitHub and never call it.

<!-- agenticool-agents sync: begin delivery -->

## Autonomous delivery

- Authority: a delivery request authorizes issue claims, project moves, commits, pushes, ready-for-review PRs, stack links, and retargeting the base of the delivery owner's own stacked PRs after a merge, as the sync in [stack operations](.agents/skills/ac-stack/SKILL.md) does. Filing authorizes issue publication. A manual review of a pull request authorizes one posted review on that PR and nothing else: no edits, no approval, and a change request only for a `REQUEST CHANGES` verdict from a GitHub account other than the PR author. Automatic pre-PR reviews and branch reviews write nothing to GitHub. Merges, deployments, destructive operations, and changes to GitHub repository settings, CI secrets, or agent tool settings require explicit user authorization.
- Before creating or using a worktree, read and follow [Agent worktree isolation](.agents/worktree-isolation.md).
- When a leaf lacks Priority or Size, set Priority to P2 and Size from the scope, as `ISSUE_TRIAGE.md` defines. Missing tracker metadata alone does not block delivery.
- [Leaf delivery](.agents/skills/ac-implement/references/delivery.md) owns the delivery gate, stacking on unmerged prerequisites, review thresholds, exact-SHA approval, reviewer packets, PRs, and handoff results. A review handoff after the final push sends the review packet that leaf delivery defines, taking the base SHA from `git merge-base <base> HEAD`, and a rework handoff adds the existing PR URL. Reviewers follow [Independent code review](.agents/review.md) and stay read-only. Load those procedures for delivery or review rather than copying them into assignments.
- Make your own GitHub calls through REST with `gh api`: issues, PRs, comments, labels, assignees, sub-issues (`repos/<repo>/issues/<n>/sub_issues` and `/parent`), issue dependencies (`/dependencies/blocked_by` and `/dependencies/blocking`), and Projects v2 (`users/<owner>/projectsV2/<n>` or `orgs/<owner>/projectsV2/<n>`, with `/fields` and `/items`). `gh issue`, `gh pr`, `gh project`, and `gh api graphql` use GraphQL, whose hourly limit agents share with Actions tokens. Use GraphQL only when REST lacks the operation, such as reading a PR's closing issues, and switch to REST when it is rate-limited. The board workflows and `npx agenticool-board` keep their GraphQL calls, even when you run them.

<!-- agenticool-agents sync: end delivery -->

<!-- agenticool-agents sync: begin code -->

## Code and comments

- Match the surrounding code. Add no single-use helper and no check, option, or parameter that no acceptance criterion or caller needs, and keep comments short: explain why, never restate the next line.
- Every doc, README, guide, spec, agent instruction, and code comment describes the current state: what exists and how to set it up and run it, never a log of problems and fixes or a timeline. Change history belongs in PR bodies and commit messages. A code comment may keep prior context only to explain an established regression the code must not reintroduce.

<!-- agenticool-agents sync: end code -->

<!-- agenticool-agents sync: begin workflows -->

## Repository agent workflows

Version-controlled agents and skills under `.claude/agents/` and `.claude/skills/` (Claude Code) and `.codex/agents/` and `.agents/skills/` (Codex) encapsulate Prismatic delivery. Routing always names these definitions. Both tools get the same roles, handoffs, and checks; only the packaging differs. The definitions are generated from the shared sources in `@agenticool/agents`, the repository's own sources under `.agents/local/`, and `.agents/policy.json`: edit a local source or the policy, run `npx agenticool-agents generate`, and commit the output, or ask the `ac-agent-config` skill to do all three. The `@agenticool/agents` README has the parity matrix, trust and discovery requirements, known runtime limits, and how to check effective settings.

| Request | Claude Code | Codex | Role it dispatches |
| --- | --- | --- | --- |
| `implement #N`, an issue URL, or a PR URL | `/ac-implement` | `$ac-implement` | `ac-implementer` per leaf or rework (`inline` keeps a small one here); `ac-code-reviewer` for the pre-PR gate |
| Build, link, rebase, or sync stacked branches during delivery | `/ac-stack` | `$ac-stack` | none; the agent that created the worktree runs it |
| File or draft issues | `/ac-create-github-issue` | `$ac-create-github-issue` | none by default; `ac-issue-triager` (read-only) when a batch needs independent judgment |
| File a specification's delivery plan as a root container, epics, and leaves | `/ac-spec-to-issues` | `$ac-spec-to-issues` | `ac-issue-triager` (read-only) for independence groups only |
| Review a pushed branch or PR | `/ac-review-code` | `$ac-review-code` | `ac-code-reviewer` (read-only, reports to you; the skill posts the report to a target PR) |
| Security review, only when a person asks | `/ac-review-security` | `$ac-review-security` | `ac-security-reviewer` (read-only) |
| Write a PR body, issue body, comment, or doc | `/ac-plain-language` | `$ac-plain-language` | none |
| Change, add, or regenerate these agents and skills | `/ac-agent-config` | `$ac-agent-config` | none; edits the policy or local sources, regenerates both tools, verifies |

- Delivery and handoffs: [the ac-implement workflow](.agents/skills/ac-implement/SKILL.md) owns dispatch, its [dependency queue](.agents/skills/ac-implement/references/queue.md) owns containers and the parallel exception, and [leaf delivery](.agents/skills/ac-implement/references/delivery.md) owns the pre-PR reviewer spawn. Only `ac-issue-triager` forms independence groups, under `.agents/independence-groups.md`. No automatic flow spawns `ac-security-reviewer`.
- Model and effort: the packages ship the model and effort for each role, per tool, and the implementation effort rubric, and `.agents/policy.json` may override them. Every dispatcher runs `npx agenticool-agents resolve --tool <claude|codex> --role <role>` and passes the result explicitly when it spawns; it never inherits a session or contributor default. An explicit `model <name>` or `effort <level>` in the request overrides only that setting, for that task and the handoffs it names (`reviewer effort max`), and changes nothing on disk; unsupported values fail. Each agent labels the dispatched `Policy:` line `Requested settings:`, including overrides, and omits model self-identification and runtime-verification commentary. `CLAUDE_CODE_EFFORT_LEVEL` and Codex agent file fields can silently override requested settings.

<!-- agenticool-agents sync: end workflows -->

## Hard rules

- Public repo: never commit secrets, account IDs, personal addresses, domains, state, plans, or populated env files.
- Run `npx agenticool-board` with `--apply`, and `npx agenticool-spec confirm`, `file`, or `resume`, only as the `ac-create-github-issue` and `ac-spec-to-issues` skills direct. The board defaults to a dry run.
- GitHub Actions file, workflow, job, and step names follow the naming convention in [Automation](CONTRIBUTING.md#automation), which `scripts/workflow-names.test.mjs` enforces. Read that section before adding or renaming a workflow. Renaming a required check needs a ruleset change at merge.

<!-- agenticool-agents sync: begin binding -->

## Delivery binding

Issue tracker: GitHub Issues. This marker turns on the GitHub issue flows (`implement #N`, GitHub issue filing), which run through the skills and agents in Repository agent workflows.

Repo `samlevin/prismatic`, trunk `main`, project [Prismatic delivery](https://github.com/users/samlevin/projects/2).

- PR titles use Conventional Commits with a component scope, e.g. `fix(<component>): ...`. Body: `Closes #N`, plus `Parent issue or epic: #P` when one exists.
- Issue states: an agent sets only `In progress`, when it claims the issue before coding, as [leaf delivery](.agents/skills/ac-implement/references/delivery.md#claim) describes. `board-pr-issue-status.yml` moves the closing issue to `In review` when the PR opens. Board automation moves a closed issue to `Done` and a reopened issue in `Done` back to `Ready`. An agent never sets `In review` or `Done`.
- Every request needs an issue before work starts. Search for an existing one first; if none exists, file it with `ac-create-github-issue` (`$ac-create-github-issue` in Codex), then claim it and do the work.
- Issue titles follow `ISSUE_TRIAGE.md`. For issue filing, follow `.agents/issue-creation.md`.

<!-- agenticool-agents sync: end binding -->

<!-- agenticool-agents sync: begin branches -->

## Branch names

Every branch an agent pushes for an issue is named `agent/<issue>-<slug>`. When one leaf is split into stacked layers, layers after the first end in `-part-<n>`. A branch stacked on another issue's PR uses its own issue's name:

- `<issue>` is the number of the leaf issue the PR closes, without `#`.
- `<slug>` is that issue's title in lowercase, with accents dropped and every run of other characters turned into `-`. "Part N" in the title becomes `partN`. The slug is cut to 40 characters at a word boundary, and is `issue` when the title has no ASCII letters or digits.
- Examples: `agent/5-generate-and-enforce-branch-names-from` for #5, and `agent/5-generate-and-enforce-branch-names-from-part-2` for its second stacked layer.

For issue work, never type a branch name by hand. Print it with `npx agenticool-dispatch branch-name <issue>`, adding `--layer <n>` for layer 2 and up. Create the branch with that name, or run `git branch -m <name>` when your tool created the worktree branch under another name. Do this before the first commit. Once a branch is pushed, keep its name, even if the issue title changes later. Nothing in CI checks branch names, so following this rule is up to you.

<!-- agenticool-agents sync: end branches -->

[Pull requests](CONTRIBUTING.md#pull-requests) gives people the branch name rules. Change it when this section changes.
