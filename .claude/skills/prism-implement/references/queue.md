# Prismatic container queue

The main thread running prism-implement follows this file for a container or epic, meaning any issue with native sub-issues, in `samlevin/prismatic` and the [Prismatic delivery](https://github.com/users/samlevin/projects/2) project. You build an explicit dependency queue and deliver its leaves yourself, one at a time, each through [delivery.md](delivery.md). No separate orchestrator agent exists. Retrieve evidence as `.agents/evidence.md` describes.

## Build the queue

1. Fetch through REST with `--paginate`: the container's body and comments; every native sub-issue, recursively (`gh api 'repos/samlevin/prismatic/issues/<n>/sub_issues?per_page=100'`); each leaf's native blocked-by edges (`/dependencies/blocked_by?per_page=100`) and comments, for claims; the project's `users/samlevin/projectsV2/2/fields` and `items?per_page=100&fields=<field IDs>`; and `repos/samlevin/prismatic/pulls?state=all&per_page=100`. List branches with `git ls-remote origin 'refs/heads/agent/*'`.
2. A nested issue with children is a container too: it gets no branch, no PR, and no acceptance criteria, and its own leaves join the queue. Record an inaccessible child as BLOCKED; never drop one silently.
3. Detect cycles in the blocked-by edges. Every leaf on a cycle is BLOCKED with the cycle named; leaves outside it still run.
4. Order the leaves so that every blocker comes before the leaves it blocks, breaking ties by issue number.
5. Give each leaf one state in the queue ledger, a table you keep in this thread and return at the end:
   - `done`: closed, or its closing PR merged.
   - `in review`: an open PR already closes it. Record the PR and skip the leaf.
   - `owned elsewhere`: another agent or person claimed it and did not release the claim. Record the claim and skip the leaf. Ask the person before taking it over.
   - `resume`: an earlier run of this delivery claimed it, no PR exists yet, and either the request says to resume that leaf or its claim names a worktree that `git worktree list` shows and that this delivery created. Reuse that worktree and the pushed branch, keeping the branch's name; a stacked branch follows the rework and resume rule of the prism-stack skill. Any other unreleased claim is `owned elsewhere`, including one whose worktree is missing here, because it may live on another machine or in the other tool.
   - `waiting`: a blocker is unmet. A blocker is met when it is closed, or when its PR qualifies for stacking under the [Gate](delivery.md#gate).
   - `ready`: no unmet blocker. It still has to pass the gate before you claim it.

## Deliver

Delivery is sequential by default. Take the first `ready` leaf, deliver it through [delivery.md](delivery.md), and record its result, an open PR or a recorded blocker, in the ledger before you start the next leaf. After each result, recompute the `waiting` leaves, because a new ready-for-review PR can let a dependent leaf stack on it. An L leaf, or one that fails the gate, gets planning or decomposition through the prism-create-github-issue skill within the accepted scope, or a recorded blocker. Never create an epic implicitly, and never relax a gate. When a leaf ends BLOCKED, try one concrete correction if one exists; otherwise record the blocker and move on.

When one leaf's exploration would crowd out the rest of the queue, you may hand that leaf to one isolated prism-implementer as the prism-implement skill describes, and wait for its result before you continue.

## Parallel exception

Leaves run at the same time only when all of these hold:

- The request asks for parallel delivery.
- Each leaf is `ready`, passes the gate, and is sized M, a substantial task rather than a narrow edit.
- The leaves sit in different groups of a valid independence record on their immediate parent, as `.agents/issue-creation.md` defines it. Never infer, form, or widen groups yourself, even when the request asks.
- Their implementation notes name no overlapping files or shared contracts.

Then each concurrent leaf goes to its own isolated prism-implementer, with its own worktree and branch, based on trunk or its own prerequisite and never on a leaf in another group. Each assignment carries an `Owned by other running leaves:` field: the issue numbers of the other leaves running at the same time, and the files and shared contracts their implementation notes name. At most one leaf per group runs at a time, and the next leaf in a group starts only after the previous one's PR is open or its blocker is recorded. You deliver no leaf yourself while they run. A leaf the record does not list runs alone. When any condition fails, deliver sequentially and say why. Before any early return, wait for every running implementer and record each result.

Start each concurrent leaf's Agent call with `run_in_background: true` without waiting for the others, and act on each result as its notification arrives, so one group never waits on another.

## Report

Return READY FOR REVIEW or BLOCKED with one ledger row per leaf: issue, independence group or `none`, state, branch/base, PR URL(s), local checks, pre-PR approval base/head SHAs, stack id, project state as read, its settings lines, and blocker. Relay an isolated implementer's `Requested settings:` lines verbatim in its row. End with your `Advisory policy:` line, and list acceptance criteria that still depend on merge, deploy, or human verification. No narrative.
