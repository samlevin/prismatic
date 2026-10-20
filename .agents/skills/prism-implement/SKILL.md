---
name: prism-implement
description: "Deliver a Prismatic GitHub issue or rework a Prismatic PR in the current thread. Use for \"implement #N\", \"implement <issue URL>\", \"rework <PR URL>\", or \"deliver this epic\" in samlevin/prismatic. The invoking thread owns the delivery: it creates the worktree, claims the issue, implements, runs the checks, gets the independent pre-PR review from prism-code-reviewer, runs stack operations through prism-stack, and opens the ready-for-review PR. A container runs as a dependency queue in the same thread, one leaf at a time unless parallel delivery is requested. One isolated prism-implementer is an explicit exception, never the default."
---
<!-- Generated from .agents/workflows/implement.md by scripts/agent-policy.mjs. Edit the source and run `npm run agents:generate`. -->

# Prismatic implement

You are the delivery owner. This thread does the work: it creates and owns the worktree, claims the issue, implements, validates, gets the independent pre-PR review, runs stack operations, and opens the PR. You spawn only the agents this skill and its procedures name, and only for the reasons they give.

## Resolve the target

1. Parse the target: `#N`, an issue URL, or a PR URL in `samlevin/prismatic`. Another repository is BLOCKED here.
2. Parse `isolated`, `parallel`, and overrides from the request. `reviewer model <name>` and `reviewer effort <level>` apply to prism-code-reviewer. An unprefixed `model <name>` or `effort <level>`, or one with an `implementer` prefix, applies to an isolated prism-implementer when you spawn one. A partial override changes only the named setting. Overrides never modify `.agents/policy.json` or workstation configuration, and they end with this task.
3. `git fetch origin` (read-only on the human checkout) and record the `origin/main` SHA.
4. For an issue, read it through REST: `gh api repos/samlevin/prismatic/issues/<N> --jq '{title, body, state, labels: [.labels[].name], id, pull_request}'` (a non-null `pull_request` means N is a PR, not an issue), its project item from `gh api 'users/samlevin/projectsV2/2/items?per_page=100' --paginate --jq '.[] | select(.content.id == ID)'` (ID is the issue's REST `id`), and its native sub-issues from `gh api 'repos/samlevin/prismatic/issues/<N>/sub_issues?per_page=100' --paginate --jq '.[].number'`. Any sub-issue means container; none means leaf. A PR URL means rework of that PR's branch.
5. For a leaf, read its blocked-by issues through REST with `gh api 'repos/samlevin/prismatic/issues/<N>/dependencies/blocked_by?per_page=100' --paginate --jq '.[] | {number, state}'`. For each open one, list the PRs that close it with GraphQL, because REST has no closing-PR read: `gh api graphql -f query='query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number headRefName } } } } }' -f owner=<owner> -f name=<repo> -F number=<B> --jq '.data.repository.issue.closedByPullRequestsReferences.nodes[]'`, where `<owner>/<repo>` is `samlevin/prismatic`. If that call is rate-limited, do not wait: find open PRs whose body names `#<B>` after a closing keyword from `gh api 'repos/samlevin/prismatic/pulls?state=open&per_page=100' --paginate --jq '.[] | {number, head: .head.ref, body}'`.

## Pick the mode

| Target | Mode | Procedure |
| --- | --- | --- |
| Leaf issue | this thread | [references/delivery.md](references/delivery.md) |
| PR rework | this thread | [references/delivery.md](references/delivery.md), its Rework section |
| Container or epic | dependency queue in this thread, sequential by default | [references/queue.md](references/queue.md) |

Read the procedure for the mode and follow it. It holds every gate, safety rule, and result field. The facts you gathered above are its inputs; reuse them instead of fetching them again.

## Settings

This skill runs at the session model and effort. A skill cannot change them in either tool, and you spawn no agent only to enforce a model choice. Resolve the advisory policy with `node scripts/agent-policy.mjs resolve --tool <tool> --capability implementation` (`<tool>` is `claude` or `codex`) and state it in your first message and in your result as `Advisory policy: tool=<tool> capability=implementation model=<model> effort=<effort> (session settings apply)`. Never present it as `Requested settings:`, because no dispatcher requested it. When an override targets the inline work, say that this skill cannot apply it and name the tool's own control.

In Codex, start the session with `codex -m <model> -c model_reasoning_effort=<effort>`.

Each role you spawn keeps its own policy: resolve it with `node scripts/agent-policy.mjs resolve --tool <tool> --role <role>`, adding `--model` or `--effort` only for an override that targets that role. The resolver prints JSON with the final `model`, `effort`, their `source`, and a `spawn` object. If it exits non-zero, stop and report its message verbatim; it refuses models and efforts the repository does not list, and nothing substitutes another value.

## Check gh stack

Stack operations run only through the prism-stack skill and the `gh stack` extension, whose first step is the extension check. When that check fails in this thread, do no branch, stack, or PR work. Run `gh --version` and tell the user:

> `gh stack` is not installed (`<first line of gh --version>`). Run `! gh extension install github/gh-stack` here, then tell me when it finishes.

Claude Code and Codex both run the same `!` line as a local shell command. Wait for the user to confirm; do not rely on reading the install output. Then run `gh stack --help` again. Continue only when it exits zero, and otherwise give the prompt again. Never run `gh extension install` yourself.

When an isolated implementer returns `BLOCKED: gh stack not installed`, give the same prompt and run the same check. After the check passes, continue that same agent with `gh stack is installed; run the check again and resume.`, so its claim and worktree carry forward.

## Isolated implementer exception

By default you deliver the work yourself. You may hand one leaf or one rework to one isolated prism-implementer when the request says `isolated`, or when the leaf is large enough that its exploration would crowd this conversation; say which reason applies. The queue's parallel exception in [references/queue.md](references/queue.md) is the only case where more than one runs at a time. An isolated implementer spawns only prism-code-reviewer, never another implementer, and returns a compact result.

Resolve its settings with `--role implementer`, then send a bounded assignment: target URL, trunk `main` and the fresh `origin/main` SHA, the base to build on, acceptance criteria, accepted decisions, verified prerequisites and their SHAs, the project item ID, validation requirements, the project binding (project 2, owner `samlevin`), the `Owned by other running leaves:` field when the queue's parallel exception applies, the result fields from the Result section of [references/delivery.md](references/delivery.md), and its `Policy:` line: `Policy: tool=<tool> role=prism-implementer model=<model> effort=<effort> (model: <source>, effort: <source>); handoff overrides: <reviewer overrides or none>`. Reference repository docs by path; do not paste them or this conversation.

Use `spawn_agent` with `agent_type`, `model`, and `reasoning_effort` copied from the resolver's `spawn` object and `fork_turns: "none"`, so the child gets only the assignment and none of this conversation. Always pass `model` and `reasoning_effort`: the repository agent files deliberately omit them, so an omitted value would silently fall back to the contributor's `[agents]` defaults or the session model, and the built-in guidance to leave `model` unset does not apply here. If `spawn_agent` reports an unknown `agent_type`, the project is not trusted in Codex yet; say so and stop (see `.agents/README.md`). Wait with the agent tools, never with shell loops. Send one concrete correction to the same agent rather than spawning another.

Record the implementer's READY FOR REVIEW or BLOCKED result before any dependent work.

## Report

Return the result the procedure defines, with your `Advisory policy:` line and every `Requested settings:` line verbatim, including an isolated implementer's. Those lines record what each role was requested with; do not call them verified or add remarks about which model ran. Then list what still depends on merge, deploy, or human verification.
