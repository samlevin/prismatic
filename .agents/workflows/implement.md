---
name: implement
description: "Deliver an {{label}} GitHub issue or rework an {{label}} PR with the repository's namespaced agents. Use for \"implement #N\", \"implement <issue URL>\", \"rework <PR URL>\", or \"deliver this epic\" in {{repository}}. Routes a container to {{prefix}}orchestrator (serial, one leaf at a time) and a leaf or PR to {{prefix}}implementer, applying the repository model/effort policy or an explicit prompt override."
argument-hint: "<#N | issue URL | PR URL> [model <name>] [effort <level>] [reviewer|stack ...]"
codex:
  display_name: "{{label}}: Implement"
  short_description: "Deliver an {{label}} issue or rework a PR through the repository agents"
  default_prompt: "Use ${{prefix}}implement to deliver this {{label}} issue."
---
# {{label}} implement

You are the dispatcher. You never implement, review, or fix code yourself in this flow; the namespaced agents do, and only one implementation runs at a time.

## Resolve the target

1. Parse the target: `#N`, an issue URL, or a PR URL in `{{repository}}`. Another repository is BLOCKED here.
2. Parse overrides from the request. `model <name>` and `effort <level>` apply to the role this skill dispatches. A role prefix targets a handoff instead: `reviewer model opus`, `reviewer effort max`, `implementer effort xhigh` (for a container), `stack model sonnet`. A partial override changes only the named setting; the other stays at the repository policy. Overrides never modify `.agents/policy.json` or workstation configuration, and they end with this task.
3. `git fetch origin` (read-only on the human checkout) and record the `origin/main` SHA.
4. For an issue, read it with `gh issue view <N> --json title,body,state,labels,projectItems` and its native sub-issues through GraphQL `subIssues(first: 100)` (paginate). Any sub-issue means container; none means leaf. A PR URL means rework of that PR's branch.

## Route and resolve the policy

| Target | Role | Resolver |
| --- | --- | --- |
| Container or epic | `{{prefix}}orchestrator` | `node scripts/agent-policy.mjs resolve --tool <tool> --role orchestrator` |
| Leaf issue or PR rework | `{{prefix}}implementer` | `node scripts/agent-policy.mjs resolve --tool <tool> --role implementer` |

Run the resolver with `--model` or `--effort` only for an override that targets that role (`<tool>` is `claude` or `codex`). It prints JSON with the final `model`, `effort`, their `source`, and a `spawn` object. If it exits non-zero, stop and report its message verbatim; it refuses models and efforts the repository does not list, and nothing substitutes another value. Compose the `Policy:` line: `Policy: tool=<tool> role=<role> model=<model> effort=<effort> (model: <source>, effort: <source>); handoff overrides: <role-prefixed overrides or none>`.

## Dispatch, one at a time

Send a compact packet: target URL, trunk `main` and the fresh `origin/main` SHA, accepted decisions from the request and issue comments, validation requirements, the project binding (project {{project.number}}, owner `{{project.owner}}`), and the `Policy:` line. Reference repository docs by path; do not paste them. Pre-PR review happens inside the implementer; it needs no instruction from you.

<!-- claude-only -->
Use the Agent tool with `subagent_type` set to the role name and `model` and `effort` copied from the resolver output, so the dispatch never inherits the session defaults. Wait for the result; do not spawn a second implementation while one is running. Continue the same agent with SendMessage for one concrete correction.
<!-- /claude-only -->
<!-- codex-only -->
Use `spawn_agent` with `agent_type`, `model`, and `reasoning_effort` copied from the resolver's `spawn` object and `fork_turns: "none"`. Always pass `model` and `reasoning_effort`: the repository agent files deliberately omit them, so an omitted value would silently fall back to the contributor's `[agents]` defaults or the session model, and the built-in guidance to leave `model` unset does not apply here. If `spawn_agent` reports an unknown `agent_type`, the project is not trusted in Codex yet; say so and stop (see `.agents/README.md`). Wait with the agent tools, never with shell loops. Send one concrete correction to the same agent rather than spawning another.
<!-- /codex-only -->

Never: merge, enable auto-merge, deploy, apply infrastructure, change settings, invoke {{prefix}}security-reviewer, mark issues Done, or wait for or poll remote CI.

## Report

Relay the agent's READY FOR REVIEW or BLOCKED result verbatim, including its `Policy:` and `Runtime:` lines. If the reported runtime model differs from the dispatched one, say so plainly instead of treating the run as compliant. Then list what still depends on merge, deploy, or human verification.
