# Independent code review

The delivery and requested-review skills use this shared packet and review procedure. Read `.agents/evidence.md` once for retrieval and reuse rules. Reviewers stay read-only and never run project code, including tests.

## Assignment packet

Supply repo, review mode, target issue or request, remote branch, worktree path with the objects, exact immediate base/head SHAs, and the resolved `Policy:` line. Include:

- Acceptance criteria for this layer and accepted decisions, with `none` when there are none.
- A changed-file summary naming behavior and relevant callers or tests, including which output is generated. This is a navigation aid, not a substitute for the diff.
- Relevant validation commands, results, tested revision or input scope, and local log paths when needed. Say which checks were not run or whose results are unavailable.
- Verified prerequisites and their SHAs when applicable, or `none`.

Keep the packet factual and bounded. Reference repository procedures by path instead of copying them or the conversation. Reuse supplied facts. Retrieve only missing or stale context, including issue comments when a decision is unresolved. Do not reconstruct the task from issue history or treat the owner's summary as a review verdict. Return BLOCKED if required criteria or commit identities cannot be established.

## Initial review

Read `git diff --stat` first, then per-file diffs. Inspect generated changes, lockfile changes, snapshots, and fixtures when correctness depends on them. Make one complete pass over the full in-scope base/head diff, every acceptance criterion, relevant callers and contracts, and tests added, changed, or exercising changed behavior. Read tests for what they assert and what they miss. Follow relevant history when needed to establish behavior. Check correctness and edge cases, compatibility, security basics, performance regressions, maintainability, and meaningful test coverage. Early stack layers need only meet their supplied layer criteria.

Docs and comments describe the current state. Report change-history prose unless a comment explains an established regression that must not recur. Report a code comment that only restates the code it sits on, and a check, helper, option, or parameter the change adds that no acceptance criterion or caller needs. Name the location and the smaller alternative: delete the comment, inline the helper, or drop the check, option, or parameter. A comment that explains why, or that guards against an established regression, is not such a finding. Report every concrete, evidenced defect and consequential coverage gap in the first round, with severity, location, problem, and fix. Permitted style is not a blocker. Never invent product decisions.

## Re-review

The packet also supplies the previous base/head SHAs, the complete previous report, and updated changed-file and validation summaries. Reuse the earlier review evidence for unchanged scope. Inspect every prior finding and the subsequent changes with `git diff <previous head>..<head>`, or `git range-diff <previous base>..<previous head> <base>..<head>` when the base moved. Read the current affected callers and tests and confirm each finding is fixed or still open.

Expand review when subsequent changes affect additional behavior or invalidate earlier evidence, including changes introduced by a moved base. Inspect that broader affected scope fully. A narrow fix does not require another complete pass over unchanged scope. Report new defects in the subsequent changes or expanded scope. A newly found acceptance-blocking defect in otherwise unchanged scope is marked `missed earlier`. List earlier findings under `Previous findings` and new ones under `Findings`.

Approval is valid only for the exact reviewed base/head pair. Any change to either needs review of the new pair before opening the PR. Reuse earlier evidence only when the packet provides the previous report and identities; otherwise perform a complete initial review.
