---
name: implement
description: "Deliver an {{label}} GitHub issue or rework an {{label}} PR through an isolated {{prefix}}implementer by default. Use for \"implement #N\", \"implement <issue URL>\", \"rework <PR URL>\", or \"deliver this epic\" in {{repository}}. The main thread runs the queue script, dispatches one leaf at a time, and records fixed results. An explicit inline keyword keeps a small leaf or rework in the main thread."
argument-hint: "<#N | issue URL | PR URL> [inline] [parallel] [model <name>] [effort <level>] [reviewer ...]"
codex:
  display_name: "{{label}}: Implement"
  short_description: "Dispatch an isolated issue delivery or PR rework"
  default_prompt: "Use ${{prefix}}implement to deliver this {{label}} issue."
---
# {{label}} implement

You are the dispatcher in this thread. The {{prefix}}implementer is the delivery owner: it creates and owns the worktree, claims the issue, implements, validates, handles its review findings, runs {{prefix}}stack, and opens the ready-for-review PR. No separate orchestrator agent exists.

## Resolve the target

1. Parse `#N`, an issue URL, or a PR URL in `{{repository}}`. Another repository is BLOCKED here. For a PR, read its number, branch, base/head, and closing issue through REST, and dispatch it with its closing leaf's ledger row even when that row says `in review`; never pick a different leaf with `--next`. The implementer reads the review findings.
2. Parse `inline`, `parallel`, and overrides. `reviewer model <name>` and `reviewer effort <level>` target only {{prefix}}code-reviewer. Unprefixed `model <name>` or `effort <level>`, and `implementer` prefixes, target only {{prefix}}implementer. Preserve explicit constraints in every continuation and recovery handoff.
3. Run `git fetch origin` and record the fresh `origin/main` SHA. Read the current procedures from trunk if the checkout may be stale.
4. Run `node scripts/delivery-queue.mjs <issue>` and `--next` as [references/queue.md](references/queue.md) describes, for a single leaf or a container.

## Pick the mode

| Target | Default mode | Procedure |
| --- | --- | --- |
| Leaf issue | isolated {{prefix}}implementer | [references/delivery.md](references/delivery.md) |
| PR rework | isolated {{prefix}}implementer | [references/delivery.md](references/delivery.md), Rework section |
| Container or epic | sequential dependency queue in this thread | [references/queue.md](references/queue.md) |

In isolated and queue mode the main thread reads the queue ledger and fixed result fields only: it runs the queue script, spawns, records results, and assesses compact escalation requests against the rubric. Do not read source or diffs, explore the implementation, or read detailed review reports during normal delivery; for a BLOCKED result or a needed decision, read only enough to explain it and ask the person. The implementer reads its own issue and owns the delivery gate.

The explicit `inline` keyword keeps a small leaf or PR rework here through [references/delivery.md](references/delivery.md). It does not make a container inline. Inline work runs at the session settings, which this skill cannot change, and reports `Advisory policy: tool=<tool> capability=implementation model=<model> effort=<effort> (session settings apply)`, resolved with `node scripts/agent-policy.mjs resolve --tool <tool> --capability implementation`. Say when a requested override cannot change the inline runtime.

## Settings

`.agents/policy.json` (`implementationEffort`) owns the effort rubric: medium by default, the assessment order, blockers, non-triggers, and the stable rules `H1-boundary`, `H2-coupled-design`, and `H3-demonstrated-limit` with their required criteria. Read it before choosing anything above medium; without a qualifying rule, choose medium. Missing inputs are blockers, never reasons to escalate, and automatic escalation stops at high.
An explicit `effort <level>` or `implementer effort <level>` overrides the rubric for this task. Explicit medium prevents automatic escalation; if that prevents delivery, return the concrete blocker. Reviewer settings remain independent.

Resolve each role separately with `node scripts/agent-policy.mjs resolve`, as `AGENTS.md` describes, adding `--model` or `--effort` only for a role's explicit override or qualifying automatic high decision. If the offline resolver fails, report its message verbatim and stop; never substitute values.

Before ordinary dispatch print `Implementation effort: medium (default)`. Before every dispatch or redispatch above medium print `Implementation effort: medium -> <selected effort>; issue: #N; rule: <full stable rule ID or user override>; evidence: <specific reference and unresolved problem>; reason: <why medium is insufficient>`. This is an announcement, not an approval request, and never changes runtime effort. The implementer confirms its dispatched effort and the same rule/reason in its first progress message.

Retain effort, rule, evidence, and reason in the ledger, assignment, fixed result, PR body, and `Requested settings:` provenance. Decisions are recorded on the issue as [Effort records](references/queue.md#effort-records) describes.

## Dispatch and continuation

Send one bounded assignment: issue number and URL (or PR URL), trunk `main` and fresh SHA, actual base branch and SHA, the leaf's ledger line with its `dispatch` metadata, any verified prerequisite SHAs, `Owned by other running leaves: none` or the queue's ownership value, effort decision and explicit constraints, project {{project.number}} owner `{{project.owner}}`, the fixed result format in [references/delivery.md](references/delivery.md#result), and `Policy: tool=<tool> role=implementer model=<model> effort=<effort> (model: <source>, effort: <source>); decision: <rule>; evidence: <reference>; reason: <reason>; handoff overrides: <reviewer overrides or none>`. Reference repository instructions by path rather than copying them or this conversation.

<!-- claude-only -->
Use the Agent tool with `subagent_type: {{prefix}}implementer`, `model` and `effort` explicitly copied from the implementer's resolver output. The role's `isolation: worktree` creates its linked worktree. Send a person's correction to the same implementer with SendMessage at its existing effort.
<!-- /claude-only -->
<!-- codex-only -->
Use `spawn_agent` with `agent_type`, `model`, and `reasoning_effort` explicitly copied from the implementer's resolver `spawn` object and `fork_turns: "none"`. Always pass both settings: agent files omit them, so an omitted value falls back to the contributor's `[agents]` defaults. An unknown `agent_type` means the project is not trusted in Codex yet; report it and stop. Send a person's correction through the tool's continue mechanism (`followup_task` for an idle agent) to the same implementer at its existing effort.
<!-- /codex-only -->

The implementer never spawns another implementer. Replace it only when it is unavailable, with a bounded recovery handoff carrying branch, head SHA, PR URL, open findings, explicit constraints, and the same effort, or under [Later escalation](#later-escalation). Never create duplicate or parallel ownership. Wait as `.agents/evidence.md` describes, and record each result before dependent work.

When an implementer returns `BLOCKED: gh stack not installed`, keep its claim, branch, and worktree and dispatch no replacement. Relay its `gh --version` output and ask the person to run `! gh extension install github/gh-stack`; never install it yourself. After they confirm, a passing `gh stack --help >/dev/null` lets the same implementer continue at its existing effort from the stack step; on failure, show the output and ask again.

## Later escalation

Validate a medium implementer's escalation request against the rubric, keep explicit medium constraints, and print the announcement before changing runtime settings. After approval and before redispatch, the parent posts exactly one later-escalation record (`later:true`, `question`, `criteria`) as [Effort records](references/queue.md#effort-records) defines. Allow at most one automatic medium-to-high transition per leaf delivery. Continue the same agent only if the runtime can change its effort; otherwise end the old agent's ownership and create one replacement at high with `--effort high` through the resolver, explicit spawn settings, and the bounded recovery handoff. That replacement adds no parallel ownership, duplicate work, or review rounds, and the retry and two-round limits stay. If the runtime cannot apply high, say so and never claim an upgrade.

## Review depth fallback

If Codex refuses main -> implementer -> reviewer depth, the implementer sends the factual review packet path here. The main thread spawns the reviewer with its own resolved `model`, `reasoning_effort`, and `fork_turns: "none"`, reads only the verdict and blocker lines, saves the complete report outside tracked paths, and passes its file path to the implementer, which handles the findings under the exact-SHA approval and two-round limit. Read a detailed report only to explain a blocker requiring a person's decision.

## Report

Relay the fixed result fields, including every `Requested settings:` line verbatim, and keep queue state in the queue script's output, not the conversation.
