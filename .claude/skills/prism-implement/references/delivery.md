# Prismatic leaf delivery

This file is the one procedure for delivering a leaf issue of `samlevin/prismatic`, or reworking one of its PRs. The delivery owner follows it: the main thread running prism-implement by default, or an isolated prism-implementer when the owner delegated the leaf. The owner creates and owns the worktree, claims the issue, implements, runs the checks, gets the pre-PR review, runs stack operations, and opens the ready-for-review PR. No other agent does any of that for it. Run autonomously within the assignment; ask only for a material missing decision or authority. Retrieve evidence as `.agents/evidence.md` describes.

## Inputs

You start from the target (an issue URL, or a PR URL for rework), trunk `main`, and a fresh `origin/main` SHA. A request or handoff may also supply acceptance criteria, accepted decisions, verified prerequisites with their SHAs, the base to build on, validation requirements, and `reviewer` overrides. Reuse what was supplied. Fetch only what is missing or may be stale, and return BLOCKED when you cannot establish the issue or its acceptance criteria.

## Read

- The loaded `AGENTS.md` may come from a stale checkout. Read `git show origin/main:AGENTS.md` and follow that copy: its checks table, review rule, PR title rules, and hard rules.
- Read through REST what the inputs did not supply: `gh api repos/samlevin/prismatic/issues/<N>` for the body, plus `/comments`, `/parent` (404 when there is none), `/dependencies/blocked_by`, and `/sub_issues`. An issue with native sub-issues is a container. The main thread follows [queue.md](queue.md) for it instead of this file; an isolated implementer returns `BLOCKED: container`.
- Read the code you will change with its callers and tests. Read each file in full before you edit it.
- Open `CONTRIBUTING.md` only when the loaded instructions lack a check command or rule you need, or when the task changes them. Read `.github/pull_request_template.md` when you open the PR.

## Gate

Before claiming, check for one logical outcome, testable acceptance criteria, a validation plan, satisfied dependencies, and size XS, S, or M. Metadata `Ready` alone does not pass the gate. Independent outcomes become native sub-issues through the prism-create-github-issue skill, and the original becomes a container; never invent scope or epics. You may build on an unmerged blocker only if its PR is open and ready for review, passes its checks, and has a pre-PR APPROVE: base your branch on its pushed head and record that SHA in the claim. Anything that needs merged, deployed, or applied-infrastructure behavior stays blocked.

## Worktree

Building on an unmerged blocker makes the branch stack-eligible, so run the [Stack](#stack) check before you create it. Run `git fetch origin`, then print the branch name with `node scripts/branch-name.mjs <issue> --actor agent`, adding `--layer <n>` for layer 2 and up.

In the main thread, create the worktree from the checkout root with `git worktree add -b <branch> .claude/worktrees/<branch-slug> <base-SHA>`, where `<branch-slug>` is the branch name with `/` replaced by `-`. Run every later command in that worktree, never in the human checkout. An isolated implementer starts in the linked worktree the Agent tool created under `.claude/worktrees/` and runs `git switch -c <branch> <base-SHA>` there.

Run `npm ci` inside the worktree when the checks need Node dependencies; never symlink `node_modules`. Never edit, stage, stash, reset, check out, install, or build in the human checkout, and never move a branch it has checked out.

## Claim

Check for existing claims, PRs, and branches. Post one claim comment (agent, branch, worktree, approach, likely files, planned checks) with `gh api -X POST repos/samlevin/prismatic/issues/<N>/comments -F body=@/abs/claim.md`. Move the project item to In progress: discover the Status field ID and option IDs with `gh api users/samlevin/projectsV2/2/fields`, find the item whose `content.id` is the issue's REST `id` in `gh api 'users/samlevin/projectsV2/2/items?per_page=100' --paginate`, then run `gh api -X PATCH users/samlevin/projectsV2/2/items/<ITEM> --input /abs/status.json` with `{"fields": [{"id": <STATUS_FIELD_ID>, "value": "<OPTION_ID>"}]}`. In progress is the only project status you ever set: never set In review or Done.

## Build

Write code plus meaningful tests for changed behavior, and update the nearest docs for contract or operator changes. While iterating, run only the focused tests for what you touched. Run the scope-appropriate local gates from the `AGENTS.md` checks table once before the first push and fix failures; after later fixes, rerun only the affected gates. Never skip tests or weaken assertions; report pre-existing failures as such. If the same command or blocker fails twice without new evidence, stop and return BLOCKED instead of repeating it. Keep a terse log of commands, results, and the tested SHA.

Re-read: before the first push, and again before pushing each rework, re-read in full every file you edited, plus one generated file for each edited source. Read for meaning, which a diff cannot show: other lines that state the rule you changed, references to anything you renamed or moved, and qualifiers a rewrite dropped. Fix what you find before pushing.

## Stack

Split into stacked layers only when each layer is reviewable on its own; line count alone does not require a stack. Roughly 400 changed production lines against the immediate parent (tests, docs, generated files, and lockfiles excluded) is the point to consider one. Early layers reference the issue; only the final layer closes it.

A branch based on an unmerged prerequisite PR, every layer of a split leaf, and a rework PR whose base is not `main` are stack-eligible. You run every stack operation yourself with the prism-stack skill, in the worktree you created: building or adopting layers, stacking on a prerequisite, linking PRs, cascading rebases, and syncing after a merge. As soon as stacking is known, before you create a branch on an unmerged base, when you decide to split, or before you rework a stacked PR, load the skill and run its extension check. Do not create, rebase, or push a branch or open a PR first. Resolve semantic conflicts yourself.

Load it with the Skill tool (`prism-stack`).

## Pre-PR review

This gate applies to the initial submission only. Commit, push, and confirm no PR exists for the branch (`gh api 'repos/samlevin/prismatic/pulls?state=all&head=<owner>:<branch>' --jq length` prints `0`, where `<owner>` is the owner in `samlevin/prismatic`).

The independent-review rule in `AGENTS.md` decides whether the change needs review: always for the agent-instruction and workflow paths it lists, however small the diff, and for the substantial changes it names. When it allows a skip, the PR body says `Pre-PR review: skipped (<reason>)`.

Resolve the reviewer settings with `node scripts/agent-policy.mjs resolve --tool <tool> --role code-reviewer`, adding `--model` or `--effort` only for a `reviewer` override; if it exits non-zero, return BLOCKED with its message. Spawn a fresh prism-code-reviewer with the resolved model and effort and a packet containing: repo, issue URL, acceptance criteria, accepted decisions, remote branch, immediate base SHA, pushed head SHA, your worktree path, `review_mode=pre_pr`, and the reviewer's own `Policy:` line composed from that resolver output (`Policy: tool=<tool> role=prism-code-reviewer model=<model> effort=<effort> (model: <source>, effort: <source>)`), never your own. Leave out your self-assessment; the reviewer reads the diff, the issue, and the callers itself.

Spawn with the Agent tool: `subagent_type` from the resolver's `spawn.subagent_type`, and pass its `model` and `effort` explicitly so the dispatch never inherits a session default.

You need APPROVE for that exact base/head pair. On REQUEST CHANGES: fix, rerun the affected gates, push, and re-review with the same packet plus the previous head SHA and that round's findings verbatim. After two rejected rounds, return BLOCKED with the open findings instead of looping. Any base/head change before the PR opens invalidates the approval. Never self-approve, and never review your own diff in place of the reviewer.

## PR

Only the delivery owner opens PRs. Load the prism-plain-language skill, write the body to a file, and open the PR through REST with `gh api -X POST repos/samlevin/prismatic/pulls -f title=<title> -f head=<branch> -f base=<base> -F body=@/abs/body.md`. Give it a Conventional Commits title that has a component scope, the repository template, the immediate base, `Closes #N` on the final layer only, `Parent issue or epic: #P` when one exists, and validation evidence including the pre-PR approval base/head SHAs and the settings lines from your result. Open it ready for review, then link stacked PRs bottom to top with the prism-stack skill. Never move the issue to In review: repository automation does that when the PR opens. If the issue is not In review when you hand off, because the automation has not run, skipped the issue, or failed, report the state you see and leave it unchanged. Once a PR exists, never invoke prism-code-reviewer for that branch again; rework goes through your checks plus formal review. Replies to review comments go on the PR.

## Rework

For a PR URL, read the PR's state, head, base, and review comments, and the issue it closes. Check with `git ls-remote origin <branch>` that the remote branch is at the PR's head SHA. The existing claim stands; post no second claim and move no project status. Work in a worktree of your own detached at `origin/<branch>`: add one with `git worktree add --detach <path> origin/<branch>` under your tool's worktree directory, or run `git switch --detach origin/<branch>` in the worktree the Agent tool created for you. Fix what the review asks within the issue's scope, rerun the affected gates, and re-read your edits as [Build](#build) describes. Push with `git push --force-with-lease=<branch>:<head you started from> origin HEAD:<branch>`, or a plain push when the history did not change, and stop when the lease rejects it. A stacked rework goes through the prism-stack skill's rework rule instead. No pre-PR review runs, and the approval SHAs from the initial submission are reported as historical.

## Never

Never: merge, enable auto-merge, deploy, apply infrastructure, change repository or workstation settings, invoke prism-security-reviewer, or wait for, poll, or rerun remote CI. Report CI status as-is and hand off. If you stop early, release the claim with a comment.

## Result

Return READY FOR REVIEW or BLOCKED (`BLOCKED: gh stack not installed` with the `gh` version when the extension check fails): issue, branch, worktree, base and head SHAs, PR URL(s), stack id, check results, approval base/head SHAs (mark historical if rework moved the head), the issue's project state as you found it (reported, never corrected), blocker, then your own settings line (`Advisory policy: ...` in the main thread, `Requested settings: Policy: <as dispatched>` in an isolated implementer), followed by one `Requested settings: Policy: <as sent>` line per prism-code-reviewer you spawned, in spawn order. No narrative.
