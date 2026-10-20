# {{label}} delivery queue

The main thread running {{prefix}}implement follows this file for a container or epic, meaning any issue with native sub-issues, and for a single leaf, in `{{repository}}` and the [{{project.name}}]({{project.url}}) project. You run the queue script, dispatch one {{prefix}}implementer per leaf, and record fixed results. No separate orchestrator agent exists. Retrieve evidence as `.agents/evidence.md` describes.

## Read the ledger

Run `node scripts/delivery-queue.mjs <N> --actor <delivery ID>`. The read-only script refetches over REST on every run: native sub-issues recursively, blocked-by edges, claim and effort comments, project Status and Size, PRs, and `agent/*` branches. It caches field IDs only within one run. A nested issue with children is a container too: it gets no branch, no PR, and no acceptance criteria, and its own leaves join the ledger. It orders the leaves so every blocker comes before the leaves it blocks, breaking ties by issue number, and prints one line per leaf: state, effort decision, base, branch and head, PR, project state, Size, claim, and blocker.

Each leaf gets one state:

- `done`: closed, or its closing PR merged.
- `in review`: an open PR already closes it. Record the PR and skip the leaf.
- `owned elsewhere`: another agent or person claimed it and did not release the claim. Ask the person before taking it over.
- `resume`: the request said to resume it (`--resume <leaf>`), or its claim names this delivery's ID and a worktree that `git worktree list` shows here. The implementer reuses that worktree and the pushed branch, keeping the branch's name; a stacked branch follows the rework and resume rule of the {{prefix}}stack skill. Any other unreleased claim is `owned elsewhere`, including one whose worktree is missing here, because it may live on another machine or in the other tool.
- `waiting`: a blocker is unmet. A blocker is met when it is closed, or when its open PR qualifies for stacking under the [Gate](delivery.md#gate); then the line's base is that PR's branch and head. Two or more stackable prerequisites need a stacking decision from the person.
- `ready`: no unmet blocker. The implementer still runs the gate before it claims.

A dependency cycle, an inaccessible child or blocker, a link to another repository, or a malformed record shows as `waiting` with a `BLOCKED:` blocker on that leaf only; the other lines still print, and the script exits non-zero.

## Records

The implementer's one claim comment carries both records, each on its own line, with single-line JSON:

```html
<!-- {{prefix}}claim {"agent":"<delivery ID>","branch":"<branch>","worktree":"<worktree path>"} -->
<!-- {{prefix}}effort {"effort":"medium","rule":"default","evidence":"issue/spec","reason":"The written plan resolves the design."} -->
```

A release comment posts the claim record again with `"released":true`. A user override records `"rule":"user override"` with the selected effort and the explicit constraint as evidence and reason; it holds for every later run. An initial high decision, or a later escalation, also records the unresolved `question` and a `criteria` object whose keys are the matching rule's `requires` list in `.agents/policy.json`, each set to `true`; a later escalation adds `"later":true`:

```html
<!-- {{prefix}}effort {"effort":"high","rule":"H3-demonstrated-limit","later":true,"question":"<unresolved correctness question>","evidence":"<failing case or finding>","reason":"<why medium with the plan is insufficient>","criteria":{"mediumAttempt":true,"reproducibleFailureOrFinding":true,"designRevisionRequired":true,"unresolvedReasoning":true}} -->
```

You post the later-escalation record yourself, once, with `gh api -X POST repos/{{repository}}/issues/<N>/comments -F body=@<file>`, keeping a one-line explanation with it. It is a decision record, not a second claim. Reruns and recovery reuse it; never post it again. The script counts it toward the one-transition limit, falls back to medium for any decision missing a required key, and blocks the leaf on a second later escalation. It never infers a rule from labels or Size.

## Deliver

Delivery is sequential by default. Run `--next`: it returns a `resume` leaf before any `ready` leaf, and when the earliest remaining leaf is `owned elsewhere` it returns that leaf and its claim instead of skipping it, so you ask the person first. Print the announcement line it prints, dispatch that leaf to one {{prefix}}implementer as the {{prefix}}implement skill describes, and record its fixed result before you start the next leaf. Rerun the script after every result and when you resume.

When a leaf ends BLOCKED and the implementer released its claim, add it to `--skip <leaf,...>` for the rest of this delivery so `--next` moves on, and keep the blocked results in a file outside tracked paths rather than in this conversation. Retry that leaf only when new evidence resolves its blocker. An L leaf, or one that fails the gate, gets planning or decomposition through the {{prefix}}create-github-issue skill within the accepted scope, or a recorded blocker. Never relax the gate.

## Parallel exception

Leaves run at the same time only when all of these hold:

- The request asks for parallel delivery.
- Each leaf is `ready`, passes the gate, and is sized M, a substantial task rather than a narrow edit.
- The leaves sit in different groups of a valid independence record on their immediate parent, as `.agents/issue-creation.md` defines it. Never infer, form, or widen groups yourself, even when the request asks.
- Their implementation notes name no overlapping files or shared contracts.

Then each concurrent leaf goes to its own {{prefix}}implementer, with its own worktree and branch, based on trunk or its own prerequisite and never on a leaf in another group. Each assignment carries an `Owned by other running leaves:` field: the issue numbers of the other leaves running at the same time, and the files and shared contracts their implementation notes name. At most one leaf per group runs at a time, and the next leaf in a group starts only after the previous one's PR is open or its blocker is recorded. You dispatch no other leaf while they run. A leaf the record does not list runs alone. When any condition fails, deliver sequentially and say why. Before any early return, wait for every running implementer and record each result.

<!-- claude-only -->
Start each concurrent leaf's Agent call with `run_in_background: true` without waiting for the others, and act on each result as its notification arrives, so one group never waits on another.
<!-- /claude-only -->
<!-- codex-only -->
Spawn every concurrent leaf's implementer before you wait, then wait for their results with the agent tools; never poll with shell loops.
<!-- /codex-only -->

## Report

Return READY FOR REVIEW or BLOCKED with the final ledger from a fresh run and, for each leaf you dispatched, its fixed result fields with its `Requested settings:` lines verbatim. List acceptance criteria that still depend on merge, deploy, or human verification. No narrative.
