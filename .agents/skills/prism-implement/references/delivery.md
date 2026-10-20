# Prismatic leaf delivery

This file is the one procedure for delivering a leaf issue of `samlevin/prismatic`, or reworking one of its PRs. The delivery owner follows it: the main thread running prism-implement by default, or an isolated prism-implementer when the owner delegated the leaf. The owner creates and owns the worktree, claims the issue, implements, runs the checks, gets the pre-PR review, runs stack operations, and opens the ready-for-review PR. No other agent does any of that for it. Run autonomously within the assignment; ask only for a material missing decision or authority. Retrieve evidence as `.agents/evidence.md` describes.

## Inputs

You start from the target (an issue URL, or a PR URL for rework), trunk `main`, and a fresh `origin/main` SHA. A request or handoff may also supply acceptance criteria, accepted decisions, verified prerequisites with their SHAs, the project item ID, the base to build on, validation requirements, and `reviewer` overrides. Reuse what was supplied. Fetch only what is missing or may be stale, and return BLOCKED when you cannot establish the issue or its acceptance criteria.

## Read

- The loaded `AGENTS.md` may come from a stale checkout. Read `git show origin/main:AGENTS.md` and follow that copy: its Checks section, its autonomous-delivery rules (authority, worktrees, prerequisites, stacking, handoffs, review), its PR title and issue-state rules, and its hard rules.
- Read through REST what the inputs did not supply: `gh api repos/samlevin/prismatic/issues/<N>` for the body, plus `/comments`, `/parent` (404 when there is none), `/dependencies/blocked_by`, and `/sub_issues`. An issue with native sub-issues is a container. The main thread follows [queue.md](queue.md) for it instead of this file.
- Read the code you will change with its callers and tests. Read each file in full before you edit it.
- Open `CONTRIBUTING.md` only when the loaded instructions lack a check command or rule you need, or when the task changes them. Read `.github/pull_request_template.md` when you open the PR.

## Gate

Before claiming, check for one logical outcome, testable acceptance criteria, a validation plan, satisfied dependencies, and size XS, S, or M. Metadata `Ready` alone does not pass the gate. Independent outcomes become native sub-issues through the prism-create-github-issue skill, and the original becomes a container; never invent scope or epics. An unmerged blocker counts as satisfied only when its PR meets the prerequisite rule in `AGENTS.md` (Autonomous delivery); then base your branch on its pushed head and record that SHA in the claim. Anything that needs merged, deployed, or applied-infrastructure behavior stays blocked.

## Worktree

Building on an unmerged blocker makes the branch stack-eligible, so run the [Stack](#stack) check before you create it. Run `git fetch origin`, then print the branch name with `node scripts/branch-name.mjs <issue> --actor agent`, adding `--layer <n>` for layer 2 and up.

Create the worktree inside the workspace so the sandbox can write to it: `git worktree add -b <branch> .codex/worktrees/<branch-slug> <base-SHA>` from the checkout root, where `<branch-slug>` is the branch name with `/` replaced by `-`. Every later command runs with `exec_command.workdir` set to that worktree. Use default permissions first; escalate only after an observed sandbox denial.

Run `npm ci` inside the worktree when the checks need Node dependencies; never symlink `node_modules`. The worktree rule in `AGENTS.md` (Autonomous delivery) covers the human checkout and other worktrees.

## Claim

Check for existing claims, PRs, and branches. Post one claim comment (agent, branch, worktree, approach, likely files, planned checks) with `gh api -X POST repos/samlevin/prismatic/issues/<N>/comments -F body=@/abs/claim.md`. Move the project item to In progress: discover the Status field ID and option IDs with `gh api users/samlevin/projectsV2/2/fields`, take the item ID from the inputs or else find the item whose `content.id` is the issue's REST `id` in `gh api 'users/samlevin/projectsV2/2/items?per_page=100' --paginate`, then run `gh api -X PATCH users/samlevin/projectsV2/2/items/<ITEM> --input /abs/status.json` with `{"fields": [{"id": <STATUS_FIELD_ID>, "value": "<OPTION_ID>"}]}`. This is your only status move; the issue-state rule in `AGENTS.md` (Delivery binding) governs every other status.

Keep issue administration proportional to the change: read each piece of metadata once, write no plan beyond the claim's approach, and post no other issue comment unless you release the claim. The PR body carries the final validation evidence.

## Build

Write code plus meaningful tests for changed behavior, and update the nearest docs for contract or operator changes. Run checks as the Checks section of `AGENTS.md` says, and fix failures before you push. If the same command or blocker fails twice without new evidence, stop and return BLOCKED instead of repeating it. Keep a terse log of commands, results, and the tested SHA.

Re-read: before the first push, and again before pushing each rework, re-read in full every file you edited, plus one generated file for each edited source. Read for meaning, which a diff cannot show: other lines that state the rule you changed, references to anything you renamed or moved, and qualifiers a rewrite dropped. Fix what you find before pushing.

## Stack

Split into stacked layers only as the stacking rule in `AGENTS.md` (Autonomous delivery) allows. Roughly 400 changed production lines against the immediate parent (tests, docs, generated files, and lockfiles excluded) is the point to consider a split. Early layers reference the issue; only the final layer closes it.

A branch based on an unmerged prerequisite PR, every layer of a split leaf, and a rework PR whose base is not `main` are stack-eligible. You run every stack operation yourself with the prism-stack skill, in the worktree you created: building or adopting layers, stacking on a prerequisite, linking PRs, cascading rebases, and syncing after a merge. As soon as stacking is known, before you create a branch on an unmerged base, when you decide to split, or before you rework a stacked PR, load the skill and run its extension check. Do not create, rebase, or push a branch or open a PR first. Resolve semantic conflicts yourself.

Load it as `$prism-stack`.

## Pre-PR review

This gate applies to the initial submission only. Commit, push, and confirm no PR exists for the branch (`gh api 'repos/samlevin/prismatic/pulls?state=all&head=<owner>:<branch>' --jq length` prints `0`, where `<owner>` is the owner in `samlevin/prismatic`).

The independent-review rule in `AGENTS.md` decides whether the change needs review: always for the agent-instruction and workflow paths it lists, however small the diff, and for the substantial changes it names. When it allows a skip, the PR body says `Pre-PR review: skipped (<reason>)`.

Resolve the reviewer settings with `node scripts/agent-policy.mjs resolve --tool <tool> --role code-reviewer`, adding `--model` or `--effort` only for a `reviewer` override; if it exits non-zero, return BLOCKED with its message. Spawn a fresh prism-code-reviewer with the resolved model and effort and the review packet, with `review_mode=pre_pr`, your branch as the remote ref, your worktree path, and the reviewer's own `Policy:` line composed from that resolver output (`Policy: tool=<tool> role=prism-code-reviewer model=<model> effort=<effort> (model: <source>, effort: <source>)`), never your own. Review packet: `review_mode=pre_pr|requested`, repo, one or more issue URLs (or `none` when the criteria come from the request), the acceptance criteria, the remote ref, the immediate base SHA, the pushed head SHA, a worktree path that already has the objects, and the reviewer's own `Policy:` line are required. It also carries the accepted decisions (or `none`) and, in `pre_pr` mode, a changed-file summary from `git diff --stat <base>..<head>`, the local check results with the SHA they ran at, and, for a branch stacked on another PR, that PR with the head SHA it was verified at. A re-review packet adds the previous round's head SHA and its findings verbatim. Leave out your self-assessment; the reviewer reads the diff, the callers, and their tests itself.

Spawn with `spawn_agent`: `agent_type`, `model`, and `reasoning_effort` from the resolver's `spawn` object, and `fork_turns: "none"`. Always pass `model` and `reasoning_effort`, even when they equal the policy; the agent file carries neither, so an omitted value would fall back to the contributor's `[agents]` defaults. An unknown `agent_type` means the project is not trusted in Codex yet; say so and stop. Wait with the agent tools; never poll with shell loops.

You need APPROVE for that exact base/head pair. On REQUEST CHANGES: fix, rerun the affected checks, push, and re-review with the same packet, updated to the new head and check results, plus the previous head SHA and that round's findings verbatim. After two rejected rounds, return BLOCKED with the open findings instead of looping. Any base/head change before the PR opens invalidates the approval. Never self-approve, and never review your own diff in place of the reviewer.

## PR

Only the delivery owner opens PRs. Load the prism-plain-language skill, write the body to a file, and open the PR through REST with `gh api -X POST repos/samlevin/prismatic/pulls -f title=<title> -f head=<branch> -f base=<base> -F body=@/abs/body.md`. Give it a Conventional Commits title that has a component scope, the repository template, the immediate base, `Closes #N` on the final layer only, `Parent issue or epic: #P` when one exists, and validation evidence including the pre-PR approval base/head SHAs and the settings lines from your result. Open it ready for review, then link stacked PRs bottom to top with the prism-stack skill. Repository automation moves the issue when the PR opens; report the state you find at handoff as the issue-state rule in `AGENTS.md` says. Once a PR exists, never invoke prism-code-reviewer for that branch again; rework goes through your checks plus formal review. Replies to review comments go on the PR.

## Rework

For a PR URL, read the PR's state, head, base, and review comments, and the issue it closes. Check with `git ls-remote origin <branch>` that the remote branch is at the PR's head SHA. The existing claim stands; post no second claim and move no project status. Work in a worktree of your own detached at `origin/<branch>`: add one with `git worktree add --detach <path> origin/<branch>` under your tool's worktree directory, or run `git switch --detach origin/<branch>` in the worktree the Agent tool created for you. Fix what the review asks within the issue's scope, rerun the affected checks, and re-read your edits as [Build](#build) describes. Push with `git push --force-with-lease=<branch>:<head you started from> origin HEAD:<branch>`, or a plain push when the history did not change, and stop when the lease rejects it. A stacked rework goes through the prism-stack skill's rework rule instead. No pre-PR review runs, and the approval SHAs from the initial submission are reported as historical.

## Authority

Stay inside the authority that `AGENTS.md` (Autonomous delivery) gives a delivery request, and report CI status as it is when you hand off. If you stop early, release the claim with a comment.

## Result

Return READY FOR REVIEW or BLOCKED (`BLOCKED: gh stack not installed` with the `gh` version when the extension check fails): issue, branch, worktree, base and head SHAs, PR URL(s), stack id, check results, approval base/head SHAs (mark historical if rework moved the head), the issue's project state as you found it (reported, never corrected), blocker, then your own settings line (`Advisory policy: ...` in the main thread, `Requested settings: Policy: <as dispatched>` in an isolated implementer), followed by one `Requested settings: Policy: <as sent>` line per agent you or a skill you ran spawned, such as prism-code-reviewer or prism-issue-triager, in spawn order. No narrative.
