---
name: review-code
description: "Independent read-only code review of a pushed {{label}} branch or PR against its issue's acceptance criteria and exact base/head SHAs, run by {{prefix}}code-reviewer at the repository policy or an explicit override. Use for \"review #N\", \"review <PR URL>\", or \"review branch <name>\" in {{repository}}. Reports findings to you; never posts, edits, or approves."
argument-hint: "<PR number | PR URL | branch> [model <name>] [effort <level>]"
codex:
  display_name: "{{label}}: Review code"
  short_description: "Read-only review of a pushed {{label}} branch by {{prefix}}code-reviewer"
  default_prompt: "Use ${{prefix}}review-code to review this {{label}} branch."
---
# {{label}} review code

You gather the inputs and dispatch `{{prefix}}code-reviewer`; you do not review the diff yourself, and nothing in this flow writes to GitHub.

## Gather

1. Resolve the target in `{{repository}}`: a PR number or URL (`gh pr view <n> --json headRefName,headRefOid,baseRefName,baseRefOid,closingIssuesReferences,url`) or a branch (`git ls-remote origin <branch>` for the head; base is the merge base with `origin/main` unless the request names one).
2. `git fetch origin <branch>` on the human checkout (read-only; fetching does not change a checkout) so the objects exist locally. The reviewer reads through `git diff` and `git show` in that worktree path.
3. Read the linked issue's acceptance criteria (`gh issue view <N> --json body,comments`). Without an issue, use the request text as the criteria and say so in the packet.
4. Parse overrides: `model <name>` and `effort <level>` apply to the reviewer. A partial override changes only the named setting.

## Dispatch

Run `node scripts/agent-policy.mjs resolve --tool <tool> --role code-reviewer`, adding `--model` or `--effort` only for an override. If it exits non-zero, stop and report its message verbatim. Compose `Policy: tool=<tool> role={{prefix}}code-reviewer model=<model> effort=<effort> (model: <source>, effort: <source>)`.

Packet: `review_mode=requested`, repo, issue URL, acceptance criteria, remote branch, base SHA, head SHA, the worktree path, and the `Policy:` line. Leave out your own opinion of the change.

<!-- claude-only -->
Use the Agent tool with `subagent_type: {{prefix}}code-reviewer` and the resolver's `model` and `effort` passed explicitly.
<!-- /claude-only -->
<!-- codex-only -->
Use `spawn_agent` with `agent_type: {{prefix}}code-reviewer`, `model` and `reasoning_effort` from the resolver's `spawn` object, and `fork_turns: "none"`. Always pass both values; the agent file carries neither. An unknown `agent_type` means the project is not trusted in Codex yet; say so and stop.
<!-- /codex-only -->

## Report

Print the reviewer's verdict, acceptance lines, findings, limits, and its `Policy:` and `Runtime:` lines verbatim. If the runtime model differs from the dispatched one, say so. Posting a review, replying on the PR, approving, or editing code requires a separate explicit request; this skill does none of it.
