---
name: prism-implement
description: "Deliver an Prismatic GitHub issue or rework an Prismatic PR with the repository's namespaced agents. Use for \"implement #N\", \"implement <issue URL>\", \"rework <PR URL>\", or \"deliver this epic\" in samlevin/prismatic. Routes a container to prism-orchestrator (serial, one leaf at a time) and a leaf or PR to prism-implementer, applying the repository model/effort policy or an explicit prompt override."
---
<!-- Generated from .agents/workflows/implement.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# Prismatic implement

You are the dispatcher. You never implement, review, or fix code yourself in this flow; the namespaced agents do, and only one implementation runs at a time.

## Resolve the target

1. Parse the target: `#N`, an issue URL, or a PR URL in `samlevin/prismatic`. Another repository is BLOCKED here.
2. Parse overrides from the request. `model <name>` and `effort <level>` apply to the role this skill dispatches. A role prefix targets a handoff instead: `reviewer model opus`, `reviewer effort max`, `implementer effort xhigh` (for a container), `stack model sonnet`. A partial override changes only the named setting; the other stays at the repository policy. Overrides never modify `.agents/policy.json` or workstation configuration, and they end with this task.
3. `git fetch origin` (read-only on the human checkout) and record the `origin/main` SHA.
4. For an issue, read it through REST: `gh api repos/samlevin/prismatic/issues/<N> --jq '{title, body, state, labels: [.labels[].name], id, pull_request}'` (a non-null `pull_request` means N is a PR, not an issue), its project item from `gh api 'users/samlevin/projectsV2/2/items?per_page=100' --paginate --jq '.[] | select(.content.id == ID)'` (ID is the issue's REST `id`), and its native sub-issues from `gh api 'repos/samlevin/prismatic/issues/<N>/sub_issues?per_page=100' --paginate --jq '.[].number'`. Any sub-issue means container; none means leaf. A PR URL means rework of that PR's branch.
5. For a leaf, read its blocked-by issues through REST with `gh api 'repos/samlevin/prismatic/issues/<N>/dependencies/blocked_by?per_page=100' --paginate --jq '.[] | {number, state}'`. For each open one, list the PRs that close it with GraphQL, because REST has no closing-PR read: `gh api graphql -f query='query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number headRefName } } } } }' -f owner=<owner> -f name=<repo> -F number=<B> --jq '.data.repository.issue.closedByPullRequestsReferences.nodes[]'`, where `<owner>/<repo>` is `samlevin/prismatic`. If that call is rate-limited, do not wait: find open PRs whose body names `#<B>` after a closing keyword from `gh api 'repos/samlevin/prismatic/pulls?state=open&per_page=100' --paginate --jq '.[] | {number, head: .head.ref, body}'`.

## Route and resolve the policy

| Target | Role | Resolver |
| --- | --- | --- |
| Container or epic | `prism-orchestrator` | `node scripts/agent-policy.mjs resolve --tool <tool> --role orchestrator` |
| Leaf issue or PR rework | `prism-implementer` | `node scripts/agent-policy.mjs resolve --tool <tool> --role implementer` |

Run the resolver with `--model` or `--effort` only for an override that targets that role (`<tool>` is `claude` or `codex`). It prints JSON with the final `model`, `effort`, their `source`, and a `spawn` object. If it exits non-zero, stop and report its message verbatim; it refuses models and efforts the repository does not list, and nothing substitutes another value. Compose the `Policy:` line: `Policy: tool=<tool> role=<role> model=<model> effort=<effort> (model: <source>, effort: <source>); handoff overrides: <role-prefixed overrides or none>`.

## Check gh stack

A target is stack-eligible when an open blocked-by issue has an open PR, when the request says to stack it, or when a rework PR's base is not `main`. Stacked PRs are built, linked, and cascaded only by prism-stack-manager with the `gh stack` extension. Before you dispatch a stack-eligible target, run `gh stack --help`. If it exits non-zero, dispatch nothing. Run `gh --version` and tell the user:

> `gh stack` is not installed (`<first line of gh --version>`). Run `! gh extension install github/gh-stack` here, then tell me when it finishes.

Claude Code and Codex both run the same `!` line as a local shell command. Wait for the user to confirm; do not rely on reading the install output. Then run `gh stack --help` again. Continue only when it exits zero, and otherwise give the prompt again. Never run `gh extension install` yourself.

When a dispatched agent returns `BLOCKED: gh stack not installed`, give the same prompt and run the same check. After the check passes, continue that same agent with `gh stack is installed; run the check again and resume.`, so its claim and worktree carry forward.

## Dispatch, one at a time

Send a compact packet: target URL, trunk `main` and the fresh `origin/main` SHA, accepted decisions from the request and issue comments, validation requirements, the project binding (project 2, owner `samlevin`), and the `Policy:` line. Reference repository docs by path; do not paste them. Pre-PR review happens inside the implementer; it needs no instruction from you.

Use `spawn_agent` with `agent_type`, `model`, and `reasoning_effort` copied from the resolver's `spawn` object and `fork_turns: "none"`. Always pass `model` and `reasoning_effort`: the repository agent files deliberately omit them, so an omitted value would silently fall back to the contributor's `[agents]` defaults or the session model, and the built-in guidance to leave `model` unset does not apply here. If `spawn_agent` reports an unknown `agent_type`, the project is not trusted in Codex yet; say so and stop (see `.agents/README.md`). Wait with the agent tools, never with shell loops. Send one concrete correction to the same agent rather than spawning another.

Never: merge, enable auto-merge, deploy, apply infrastructure, change settings, invoke prism-security-reviewer, mark issues Done, or wait for or poll remote CI.

## Report

Relay the agent's READY FOR REVIEW or BLOCKED result verbatim, including every `Requested settings:` line. Those lines record the model and effort each role was requested with; do not call them verified or add remarks about which model ran. Then list what still depends on merge, deploy, or human verification.
