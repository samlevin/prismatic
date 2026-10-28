# Prismatic container queue

The main thread running prism-implement follows this file for a container, single leaf, or PR rework in `samlevin/prismatic`. It runs the queue script, dispatches one prism-implementer per leaf, and records fixed results. No separate orchestrator agent exists. Read `.agents/evidence.md` once before starting.

## Build the queue

Run `npx agenticool-delivery queue <issue>` and `--next`. The read-only script refetches recursive native sub-issues, blocked-by edges, project items, PRs, `agent/*` branches, and claims over REST on every run. Detect cycles in the blocked-by edges and record inaccessible children and cross-repository children or blockers as BLOCKED. Order blockers before dependents, with ties by issue number. A nested container has no delivery branch or PR; its leaves join the ledger.

The script prints one ledger line per leaf with state, effort, rule, evidence, reason, branch/head, PR, project state, size, and claim. Its `dispatch` JSON object holds the exact base branch/SHA, dependency edges, prerequisite PRs with stacking eligibility, the validated independence groups (`groups`, each `<container>/gN`, one per valid record that names the leaf), declared ownership, and compatible parallel candidates. In Implementation notes, `Files:` lists backticked paths and `Contracts:` or `Provides:` names comma-separated shared contracts, or `none`. Multiple unmerged prerequisite branches need a stacking decision. States apply in this order:

- `done`: closed, or its closing PR merged.
- `in review`: an open PR closes it. Record and skip it.
- `owned elsewhere`: an unreleased claim this delivery did not create, including a claim whose worktree is missing here, because it may live elsewhere. Ask the person before taking it over. `--next` reports the earliest owned leaf and its claim instead of skipping to later ready work.
- `resume`: requested with `--resume <issue>`, or the claim names this delivery's agent (`--actor <delivery-agent>`, never another delivery's identity) and a worktree this delivery created that `git worktree list` shows here. Reuse its pushed branch and name under prism-stack, in the old worktree when it exists; after it disappeared, check out the existing branch with `git worktree add <path> <branch>`, or `git worktree add --track -b <branch> <path> origin/<branch>` when only the remote exists. Any other claim is `owned elsewhere`.
- `waiting`: a blocker is unmet. Closed blockers count as met; an open blocker PR must meet [delivery.md](delivery.md#gate)'s stacking rule. Cycles and inaccessible dependencies stay BLOCKED.
- `ready`: no unmet blocker. The implementer still runs the gate before claiming.

`--next` selects a `resume` leaf before `ready` leaves. Claim records use `<!-- prism-claim {"agent":"<delivery-agent>","branch":"<branch>","worktree":"<path>"} -->`; release uses the same agent with `"released":true`. Legacy claim comments are recognized too. PRs record approval as `Pre-PR review: APPROVE; base=<full SHA>; head=<full SHA>`; the older `Pre-PR review: APPROVE for base..head` form, with optional Markdown around the pair, is accepted too. Stacking needs the approval head to match the current PR head and a REST compare showing the approval base is an ancestor of it; the PR's base-branch tip may advance. Passing checks without that do not permit stacking.

## Effort records

The implementer includes the initial decision with its one claim comment; a missing record means medium. A default decision is:

```html
<!-- prism-effort {"effort":"medium","rule":"default","evidence":"ticket/spec","reason":"The written plan resolves the design."} -->
```

A user override uses `rule:"user override"`, the actual selected `effort`, and its explicit constraint as `evidence` and `reason`. Every qualifying high record, initial or later, has the unresolved `question` and the matching policy rule's required `criteria` keys set to true; without them the queue reads it as medium.

For an approved later escalation, the parent posts exactly one new decision comment before redispatch, with the explanation beside the record. It is exempt from the no-repeat-claim rule and never repeats the claim, and its record adds `later:true`:

```html
<!-- prism-effort {"effort":"high","rule":"H3-demonstrated-limit","later":true,"question":"How can concurrent writes preserve the specified ordering?","evidence":"Reproducible case race-1 and the medium attempt","reason":"The attempt requires revising the ordering design.","criteria":{"mediumAttempt":true,"reproducibleFailureOrFinding":true,"designRevisionRequired":true,"unresolvedReasoning":true}} -->
```

Post with `gh api repos/samlevin/prismatic/issues/<N>/comments -F body=@<file>`. Reruns and recovery reuse the record, preserving high and the one-transition count. A malformed claim or effort record blocks only its leaf; the script still prints the other rows.

## Deliver

Delivery is sequential by default: dispatch the `--next` resume or ready leaf to one prism-implementer, record its result before you start the next leaf, and rerun the script after each result and when resuming. After a recorded BLOCKED result and claim release, rerun the full ledger rather than blindly using `--next`, and select the next resume or ready row excluding issues recorded BLOCKED in this delivery's saved fixed-result file outside tracked paths; retry one only when new evidence resolves its blocker. `BLOCKED: gh stack not installed` keeps its claim and continues in the same implementer, as prism-implement describes. An earlier `owned elsewhere` row still requires the person's decision and is never silently skipped. An L leaf or failed gate is decomposed as [delivery.md](delivery.md#gate) describes or recorded as blocked; never relax gates.

The main thread reads the ledger and fixed result fields under prism-implement's mode rules. Do not read source, diffs, or detailed review reports.

## Parallel exception

Leaves run at the same time only when all of these hold:

- The person explicitly asked for parallel delivery.
- Each leaf is `ready`, passes the gate, and is a substantial task sized M.
- A container in the delivered tree records independence groups, the record is valid under `.agents/independence-groups.md`, and it puts the leaves in different groups. Never infer, form, extend, or merge groups yourself.
- For leaves of different phase epics, the person asked for parallel delivery of the plan's root container.
- The leaves' implementation notes name no overlapping files or shared contracts.

Use only the script's parallel candidates; missing ownership notes keep delivery sequential. Each concurrent leaf goes to its own isolated prism-implementer, worktree, and branch, based on trunk or its own prerequisite and never on a leaf from another group. Each concurrent assignment carries an `Owned by other running leaves:` field: the issue numbers of the other leaves running at the same time, and the files and shared contracts their implementation notes name. At most one leaf per group runs at a time, counting every group in each running leaf's `groups`, and new leaves start only as the tool-specific rule below allows. A leaf that no valid group names runs alone. An implementer that must change a file or shared contract another running leaf owns returns BLOCKED, and you deliver that leaf after the other leaf's PR opens. When any condition fails, deliver sequentially and say why.

Start each concurrent leaf's implementer with `run_in_background: true`. Record each result as its notification arrives. Once a leaf's result is recorded, the next ready leaf in that group may start while leaves in other groups still run, if it passes every condition above against each leaf still running and its `Owned by other running leaves:` field names them. Before any early return, wait for every running implementer and record each result.

## Report

Return one fresh ledger row per leaf with the fixed result from [delivery.md](delivery.md#result), effort decision, and every `Requested settings:` line verbatim. No narrative.
