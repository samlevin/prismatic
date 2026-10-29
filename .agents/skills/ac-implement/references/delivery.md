# Prismatic leaf delivery

This file is the one source for delivering a leaf issue or reworking one of its PRs in `samlevin/prismatic`. The delivery owner follows it: an isolated implementer by default, or the main thread for an explicit `inline` small leaf or rework. Only the owner does each step below. Run autonomously within the assignment; ask only for a material missing decision or authority. Read `.agents/evidence.md` and `.agents/worktree-isolation.md` once before you start, and follow them throughout.

## Inputs

The assignment from implement's Dispatch supplies the target, trunk and base SHAs, ledger line, ownership exclusions, and effort decision, and may add acceptance criteria, accepted decisions, verified prerequisites, validation requirements, and `reviewer` overrides. Confirm the dispatched effort and the same rule/reason in your first progress message. Return BLOCKED when you cannot establish the issue or its acceptance criteria.

## Read

- When the loaded `AGENTS.md` may come from a stale checkout, follow `git show origin/main:AGENTS.md` instead.
- Read what the inputs did not supply through REST: `gh api repos/samlevin/prismatic/issues/<N>` for the body, plus `/comments`, `/parent` (404 when there is none), `/dependencies/blocked_by`, and `/sub_issues`. An issue with native sub-issues is a container: follow [queue.md](queue.md) instead, or return `BLOCKED: container` when you are an isolated implementer.
- Open `AGENTS.md` only when the loaded instructions lack a check command or rule you need, or when the task changes them. Read `.github/pull_request_template.md` when you open the PR.

## Gate

Before claiming, check for one logical outcome, testable acceptance criteria, a validation plan, satisfied dependencies, and size XS, S, or M. Metadata `Ready` alone does not pass the gate. Independent outcomes become native sub-issues through the ac-create-github-issue skill and the original becomes a container; never invent scope or epics. You may build on an unmerged blocker only if its PR is open and ready for review, passes its checks, and has a pre-PR APPROVE: base your branch on its pushed head and record that SHA in the claim. Anything that needs merged, deployed, or applied-infrastructure behavior stays blocked.

## Worktree

Use the fresh fetch already recorded; fetch again only if the base may have moved. Print the branch name with `npx agenticool-dispatch branch-name <issue> --actor agent` (add `--layer <n>` for layer 2 and up).

After `git fetch origin` and before any `git worktree add` or `git switch`, run `git worktree list --porcelain` and find the target branch: a new branch, a resumed claim's branch, or a stacked layer. When another worktree, under either tool's directory, has it checked out, stop and report that worktree's path, and never work around the conflict, as `.agents/worktree-isolation.md` forbids. Rework is not blocked, because it detaches at `origin/<branch>` instead of checking the branch out.

Create the worktree inside the workspace so the sandbox can write to it: `git worktree add -b <branch> .codex/worktrees/<branch-slug> <base-SHA>` from the checkout root, where `<branch-slug>` is the branch name with `/` replaced by `-`. Every later command runs with `exec_command.workdir` set to that worktree. Use default permissions first; escalate only after an observed sandbox denial.

Run `npm ci` inside the worktree when the checks need Node dependencies. Rework uses a detached worktree instead, as [Rework](#rework) describes.

## Claim

Reuse current metadata and verified prerequisites from issue intake or the queue. For a small fix, the issue criteria, a brief approach, and planned checks are enough. Check once for existing claims, PRs, and branches; an existing claim owned by this delivery stands on resume or rework. Post one useful claim comment (agent, branch, worktree, approach, likely files, planned checks, effort/rule/evidence/reason, and the machine-readable `claim` and `effort` records in [queue.md](queue.md)) with `gh api repos/samlevin/prismatic/issues/<N>/comments -F body=@<file>`. Do not add status-only comments or repeat the claim. Then move the project item to In progress once through REST under `users/samlevin/projectsV2/2`, reusing current IDs: read the Status field and option IDs from `gh api <project>/fields`, page `gh api -X GET <project>/items -f per_page=100 --paginate` for the item whose `content.number` is the issue and whose `content.repository_url` ends in `/repos/samlevin/prismatic`, and run `gh api -X PATCH <project>/items/<item> --input <file>` with `{"fields":[{"id":<field>,"value":"<option>"}]}` in the file. In progress is the only project status you ever set.

## Build

Write code plus meaningful tests for changed behavior, and update the nearest docs for contract or operator changes, keeping docs and comments to the current state as the `AGENTS.md` hard rules require.

While editing, run focused tests for changed behavior. Before the first push, run every required scope-appropriate check from `AGENTS.md` and fix failures. After fixes, rerun affected checks and broaden validation when changed scope, dependencies, configuration, or new evidence warrants it. Meaningful behavioral tests and required checks remain mandatory: never skip them or weaken assertions, and report pre-existing failures as such. If the same command or blocker fails twice without new evidence, stop and return BLOCKED. Inspect edits before each push as `.agents/evidence.md` describes. Keep a terse record of commands, results, and tested revision for the review packet and PR.

## Escalation

When a medium attempt exposes a qualifying unresolved correctness problem under the rubric in `.agents/policy.json`, stop implementation and send the parent a compact escalation request: stable rule ID, evidence, why medium with the written plan is insufficient, branch/head, completed checks, and open work. Never raise your own effort or spawn another implementer; the parent decides under implement's Later escalation.

## Stack

Split into stacked layers only when each layer is reviewable on its own. Consider one at roughly 400 changed production lines against the immediate parent (tests, docs, generated files, and lockfiles excluded); line count alone does not require it. Early layers reference the issue; only the final layer closes it. Run every stack operation yourself with the ac-stack skill, in the worktree you created: building or adopting layers, stacking on a prerequisite, linking PRs, cascading rebases, and syncing after a merge. Resolve semantic conflicts yourself. When the skill finds the `gh stack` extension missing, an isolated implementer returns `BLOCKED: gh stack not installed` as [Result](#result) describes, and inline delivery asks the person to install it.

Load it as `$ac-stack`.

## Pre-PR review

This gate applies to the initial submission only. Commit, push, and confirm no PR exists for the branch (`gh api 'repos/samlevin/prismatic/pulls?state=all&head=<owner>:<branch>'` returns none).

Independent review is required for changes across components, shared contracts, security boundaries, and other substantial behavior changes. It is always required, however small the diff, for changes to agent instructions (`.agents/`, `.claude/`, `.codex/`, and `AGENTS.md`), `.github/workflows/`, or anything else that changes how prod or shared resources are planned, applied, locked, deployed, or gated. Outside those paths, a localized low-risk change, documentation, or a mechanical edit may skip it, and the PR body then says `Pre-PR review: skipped (<reason>)`.

Resolve the reviewer settings with `npx agenticool-agents resolve --tool <tool> --role ac-code-reviewer`, adding `--model` or `--effort` only for a `reviewer` override; if it exits non-zero, return BLOCKED with its message. Spawn a fresh ac-code-reviewer with the resolved model and effort and the review packet, with `review_mode=pre_pr`, your branch as the remote ref, your worktree path, and its resolved `Policy:` line (`Policy: tool=<tool> role=ac-code-reviewer model=<model> effort=<effort> (model: <source>, effort: <source>)`). Review packet: `review_mode=pre_pr|requested`, repo, the URL of every issue that supplies criteria (or `none` when the criteria come from the request), the acceptance criteria for this layer, the remote ref (a branch, or `pull/<N>/head` for a requested PR review), the immediate base SHA, the pushed head SHA, a worktree path that already has the objects, and the reviewer's own resolved `Policy:` line are required. It also carries the accepted decisions, a changed-file summary, the relevant validation results, and verified prerequisites when applicable, each with an explicit `none` or unavailable result, plus the remaining fields from `.agents/review.md`. A re-review packet adds the previous round's base and head SHAs and its complete report; `.agents/review.md` sets its scope. Leave out your self-assessment.

Spawn with `spawn_agent`: `agent_type`, `model`, and `reasoning_effort` from the resolver's `spawn` object, and `fork_turns: "none"`. Always pass both settings, as implement's Dispatch explains, and stop on an unknown `agent_type`.

If Codex refuses nested reviewer depth, send the packet path to the main thread for implement's review-depth fallback and handle every finding in the report it returns. You need APPROVE for that exact base/head pair. On REQUEST CHANGES: fix, rerun the affected gates, push, and re-review with the re-review packet `.agents/review.md` defines. After two rejected rounds, return BLOCKED with the open findings instead of looping. Any base/head change before the PR opens invalidates the approval. Never self-approve, and never review your own diff in place of the reviewer.

## PR

Only the delivery owner opens PRs. Load the ac-plain-language skill, write the body to a file, and open the PR ready for review through REST: `gh api repos/samlevin/prismatic/pulls -f title='<title>' -f head=<branch> -f base=<base branch> -F body=@<file>`. Follow the `AGENTS.md` title and body rules (`Closes #N` on the final layer only) and the repository template. Include the immediate base, validation evidence with `Pre-PR review: APPROVE; base=<full SHA>; head=<full SHA>`, the effort decision with explicit constraints, the settings lines from your result, and the usage the tool exposes for parent, implementer, and reviewer separately (input, cached input, output, and reasoning tokens, naming unavailable metrics), without savings claims or inline comparisons. Then link stacked PRs bottom-to-top with the ac-stack skill. Leave the issue's status alone: automation moves it to In review when the PR opens, and if that skips or fails, report the state you read. Once a PR exists, never invoke ac-code-reviewer for that branch again; rework goes through your checks plus formal review, and replies to review comments go on the PR.

## Rework

For a PR URL, read the PR's state, head, base, review comments, and closing issue, and check with `git ls-remote origin <branch>` that the branch is at the PR head. Work detached at `origin/<branch>`: `git worktree add --detach <path> origin/<branch>` under your tool's worktree directory in the main thread, or `git switch --detach origin/<branch>` in an isolated implementer's worktree. The branch is yours under the ac-stack skill's rework and resume rule, and the existing claim stands: post no second claim and move no project status. Fix what the review asks within the issue's scope, rerun the affected gates, and inspect your edits as [Build](#build) describes. Push with `git push --force-with-lease=<branch>:<head you started from> origin HEAD:<branch>`, or a plain push when history did not change, and stop if the lease rejects it. Rebase onto a moved parent with the ac-stack skill's detached-HEAD rework commands. No pre-PR review runs; reply to review comments on the PR and report the initial approval SHAs as historical.

## Never

Never: merge, enable auto-merge, set an issue's status to In review or Done, deploy, apply infrastructure, change repository or workstation settings, invoke ac-security-reviewer, or wait for, poll, or rerun remote CI. Report CI status as-is and hand off. If you stop early, release the claim with a comment, except for `BLOCKED: gh stack not installed`: keep the claim, branch, worktree, and uncommitted work, and resume from the stack step when continued.

## Result

Return READY FOR REVIEW or BLOCKED with these fixed fields and no narrative. Details go in the PR body. Include the project state as read, never corrected, and retain every requested settings line in spawn order.

```text
Status: READY FOR REVIEW | BLOCKED | ESCALATION REQUEST
Issue: #N
PR: <URL or none>
Branch: <name>
Worktree: <path>
Base: <branch> <SHA>
Head: <SHA>
Stack: <id or none>
Effort: <level>; rule=<default|user override|stable rule ID>; evidence=<reference>; reason=<reason>
Check: <command> | <PASS|FAIL|not run>  (one line per check)
Review: <APPROVE|REQUEST CHANGES|BLOCKED|skipped|historical>; base=<SHA>; head=<SHA>
Project: <state as read>
Blocker: <none or concrete blocker; escalation also names open work; `gh stack not installed` also gives the `gh --version` output>
Requested settings: Policy: <as dispatched, including decision provenance>
Requested settings: Policy: <as sent to each reviewer, in spawn order>
```

Inline delivery substitutes its `Advisory policy:` line for its own requested settings. A review-depth fallback retains the main thread's reviewer settings too. An escalation request includes completed checks and open work before ownership ends; no overlapping replacement work is allowed.
