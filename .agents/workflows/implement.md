---
name: implement
description: "Deliver a {{label}} GitHub issue or rework a {{label}} PR through its own {{prefix}}implementer. Use for \"implement #N\", \"implement <issue URL>\", \"rework <PR URL>\", or \"deliver this epic\" in {{repository}}. The main thread runs the delivery queue script, dispatches one {{prefix}}implementer per leaf at a time, and records fixed results; the implementer creates the worktree, claims the issue, implements, runs the checks, gets the independent pre-PR review from {{prefix}}code-reviewer, runs stack operations through {{prefix}}stack, and opens the ready-for-review PR. An explicit inline keyword keeps a small leaf or rework in the main thread."
argument-hint: "<#N | issue URL | PR URL> [inline] [parallel] [model <name>] [effort <level>] [reviewer ...]"
codex:
  display_name: "{{label}}: Implement"
  short_description: "Dispatch an {{label}} issue or PR rework to an implementer"
  default_prompt: "Use ${{prefix}}implement to deliver this {{label}} issue."
---
# {{label}} implement

You are the dispatcher. Each leaf and each PR rework goes to its own {{prefix}}implementer, the delivery owner: it creates and owns the worktree, claims the issue, implements, validates, handles its review findings, runs stack operations, and opens the PR. You run the queue script, spawn implementers, record their results, and assess their escalation requests. No orchestrator agent exists.

## Resolve the target

1. Parse the target: `#N`, an issue URL, or a PR URL in `{{repository}}`. Another repository is BLOCKED here. For a PR, read its number, branch, base and head, and the issue it closes through REST; the implementer reads the review comments.
2. Parse `inline`, `parallel`, and overrides from the request. `reviewer model <name>` and `reviewer effort <level>` apply to {{prefix}}code-reviewer. An unprefixed `model <name>` or `effort <level>`, or one with an `implementer` prefix, applies to {{prefix}}implementer. A partial override changes only the named setting. Overrides never modify `.agents/policy.json` or workstation configuration, they end with this task, and every continuation and recovery handoff keeps them.
3. `git fetch origin` (read-only on the human checkout) and record the `origin/main` SHA.
4. Pick a delivery ID once, `<tool>-<issue>-<UTC timestamp>`, and pass it as `--actor` and in every assignment, so the queue recognizes claims this delivery made.
5. Run `node scripts/delivery-queue.mjs <N> --actor <delivery ID>`, adding `--resume <leaf>` only when the request says to resume that leaf. It accepts a container or a single leaf, refetches everything over REST on every run, and prints one ledger line per leaf. [references/queue.md](references/queue.md) defines the states and records.

## Pick the mode

| Target | Mode | Procedure |
| --- | --- | --- |
| Leaf issue | one {{prefix}}implementer | [references/queue.md](references/queue.md), then [references/delivery.md](references/delivery.md) in the implementer |
| PR rework | one {{prefix}}implementer | [references/delivery.md](references/delivery.md), its Rework section, in the implementer |
| Container or epic | one {{prefix}}implementer per leaf, sequential by default | [references/queue.md](references/queue.md) |
| `inline` leaf or rework | this thread | [references/delivery.md](references/delivery.md) |

For a PR rework, dispatch that PR with the ledger line of the leaf it closes, even when the line says `in review`; never pick another leaf with `--next`.

During normal delivery you read the ledger and the implementers' fixed result fields, nothing else: no source, no diffs, no detailed review reports, and no implementation exploration. When a result is BLOCKED or needs a decision, read only the detail you need to explain the blocker to the person and ask for the decision.

`inline` keeps a small leaf or a PR rework in this thread; it never makes a container inline. Inline work runs at the session model and effort, which a skill cannot change in either tool. Resolve the advisory policy with `node scripts/agent-policy.mjs resolve --tool <tool> --capability implementation` and state it in your first message and in your result as `Advisory policy: tool=<tool> capability=implementation model=<model> effort=<effort> (session settings apply)`. Never present it as `Requested settings:`, because no dispatcher requested it. When an override targets inline work, say that this skill cannot apply it and name the tool's own control.

<!-- claude-only -->
In Claude Code, set the session model with `/model`, or start the session with `claude --model <model>`.
<!-- /claude-only -->
<!-- codex-only -->
In Codex, start the session with `codex -m <model> -c model_reasoning_effort=<effort>`.
<!-- /codex-only -->

## Effort

Most leaves run the implementer at medium, because the issue or spec supplies acceptance criteria, boundaries, decisions, and validation. A clear plan across several files still runs at medium. `implementationEffort` in `.agents/policy.json` holds the rubric and its stable rule IDs: `H1-boundary`, `H2-coupled-design`, and `H3-demonstrated-limit`.

Assess in this order: reuse the issue and spec decisions; name a concrete unresolved correctness question; inspect only the evidence that question needs; check whether an existing pattern, a focused test, or a smaller reviewable step resolves it; then apply the rubric. Never investigate broadly only to choose effort. Missing acceptance criteria, product decisions, credentials, prerequisites, or reproducible evidence are blockers, and higher effort never substitutes for them.

High is allowed without a user override only when a rule matches and the assessment records the evidence and why medium with the written plan is insufficient:

- `H1-boundary`: the change must design or prove a new security, immutable-evidence, persistent-data, or compatibility guarantee across components, and the issue or spec leaves the mechanism unresolved. Name the guarantee and a concrete failure scenario. Applying an established, specified pattern does not qualify.
- `H2-coupled-design`: an algorithm, state machine, concurrency protocol, or migration has interacting correctness constraints the supplied design does not resolve. Name the competing constraints and why existing patterns, focused tests, or a reviewable decomposition do not resolve them.
- `H3-demonstrated-limit`: a medium attempt produced a reproducible correctness failure or a substantive review finding that requires revising the underlying design. Cite the failing case or finding, the attempted approach, and the unresolved reasoning problem. The retry and two-round review limits still apply.

Labels (risk, severity, area), shared-contract changes, Size, file count, multiple consumers, and unfamiliar code never select high on their own; they can only prompt an assessment. Routine fixes, mechanical consumer updates, and work whose issue or spec already resolves the design stay at medium. When the evidence does not establish a rule, choose medium. Automatic escalation stops at high.

An explicit `effort <level>` or `implementer effort <level>` overrides the rubric for this task. An explicit medium prevents automatic escalation; if it then prevents delivery, report the concrete blocker instead of raising effort. Reviewer settings stay independent of the implementer's.

The queue prints the announcement for the leaf `--next` selects. Before every dispatch, print it: `Implementation effort: medium (default)` for ordinary delivery, and before every dispatch or redispatch above medium `Implementation effort: medium -> <selected effort>; issue: #N; rule: <H1/H2/H3 or user override>; evidence: <specific reference and unresolved problem>; reason: <why medium is insufficient>`. It is an announcement, not an approval request, and reporting a choice never changes runtime effort.

## Settings

Resolve each role separately with `node scripts/agent-policy.mjs resolve --tool <tool> --role <role>` (`<tool>` is `claude` or `codex`), adding `--model` or `--effort` only for an override that targets that role or a qualifying high decision for the implementer. The resolver prints JSON with the final `model`, `effort`, their `source`, and a `spawn` object. If it exits non-zero, stop and report its message verbatim; it refuses models and efforts the repository does not list, and nothing substitutes another value. Never let a spawn inherit this thread's settings: an implementer at medium still sends its reviewer the reviewer's own resolved effort.

## Check gh stack

Stack operations run only through the {{prefix}}stack skill and the `gh stack` extension, whose first step is the extension check. When an implementer returns `BLOCKED: gh stack not installed`, or the check fails in this thread during inline work, do no branch, stack, or PR work here. Run `gh --version` and tell the user:

> `gh stack` is not installed (`<first line of gh --version>`). Run `! gh extension install github/gh-stack` here, then tell me when it finishes.

Claude Code and Codex both run the same `!` line as a local shell command. Wait for the user to confirm; do not rely on reading the install output. Then run `gh stack --help` again. Continue only when it exits zero, and otherwise give the prompt again. Never run `gh extension install` yourself. After the check passes, continue that same agent with `gh stack is installed; run the check again and resume.`, so its claim and worktree carry forward.

## Dispatch

Send one bounded assignment: the issue number and URL (or the PR URL), trunk `main` and the fresh `origin/main` SHA, the base branch and SHA from the leaf's ledger line, the ledger line itself, the delivery ID, `Owned by other running leaves: none` or the value the queue's parallel exception sets, the effort decision (effort, rule, evidence, reason) and any explicit constraints, the project binding (project {{project.number}}, owner `{{project.owner}}`), the result fields from the Result section of [references/delivery.md](references/delivery.md), and its `Policy:` line: `Policy: tool=<tool> role={{prefix}}implementer model=<model> effort=<effort> (model: <source>, effort: <source>); decision: <rule>; evidence: <reference>; reason: <reason>; handoff overrides: <reviewer overrides or none>`. The implementer reads its own issue for acceptance criteria and accepted decisions. Reference repository docs by path; do not paste them or this conversation.

<!-- claude-only -->
Use the Agent tool with `subagent_type: {{prefix}}implementer` and `model` and `effort` copied from the resolver output, so the dispatch never inherits the session defaults. The agent file sets `isolation: worktree`, so it starts in its own linked worktree. Send a person's correction to the same implementer with SendMessage; it keeps its effort.
<!-- /claude-only -->
<!-- codex-only -->
Use `spawn_agent` with `agent_type`, `model`, and `reasoning_effort` copied from the resolver's `spawn` object and `fork_turns: "none"`, so the child gets only the assignment and none of this conversation. Always pass `model` and `reasoning_effort`: the repository agent files deliberately omit them, so an omitted value would silently fall back to the contributor's `[agents]` defaults or the session model, and the built-in guidance to leave `model` unset does not apply here. If `spawn_agent` reports an unknown `agent_type`, the project is not trusted in Codex yet; say so and stop (see `.agents/README.md`). Wait with the agent tools, never with shell loops. Send a person's correction to the same implementer through the agent tools' continue mechanism; it keeps its effort.
<!-- /codex-only -->

The implementer spawns only {{prefix}}code-reviewer, never another implementer, and handles its own review findings. Ordinary corrections continue in the same agent at its existing effort. Start a new implementer only when the original is unavailable, or when the escalation below requires a replacement. A recovery handoff carries the branch, head SHA, PR URL, open findings, and explicit constraints, at the original's effort. Never create duplicate or parallel ownership of a leaf.

Record the implementer's fixed result before any dependent work, then rerun the queue script instead of keeping queue state in this conversation.

## Later escalation

An implementer that finds a qualifying problem after starting at medium returns `Status: ESCALATION REQUEST` with the rule, evidence, reason, branch and head, completed checks, and open work. Check it against the rubric from that request alone; an explicit medium constraint refuses it. Approve at most one automatic medium-to-high transition per leaf delivery. Print the announcement, then post exactly one later-escalation record as [references/queue.md](references/queue.md) shows, before changing runtime settings. Continue the same agent only if the runtime supports an explicit effort change on continuation. Otherwise end the old agent's ownership and start one replacement at high, resolved with `--effort high`, with the recovery handoff above. This is the only added replacement: it never allows an implementer beneath an implementer, parallel ownership, duplicate work, extra retries, or extra review rounds. If the runtime cannot apply high, report that and never claim an upgrade happened.

## Report

Return the queue's final ledger and each implementer's fixed result fields, with every `Requested settings:` line verbatim, and your `Advisory policy:` line for inline work. Those lines record what each role was requested with; do not call them verified or add remarks about which model ran. Then list what still depends on merge, deploy, or human verification.
