---
name: review-code
description: "Independent read-only code review of a {{label}} pull request (open, merged, or closed) or pushed branch at exact base/head SHAs, against the acceptance criteria of the issue the PR closes, run by {{prefix}}code-reviewer at the repository policy or an explicit override. Use for \"review #N\" or \"review N\" (always pull request N, never an issue), \"review <PR URL>\", or \"review branch <name>\" in {{repository}}. Reports findings to you; never posts, edits, or approves."
argument-hint: "<#PR | PR number | PR URL | branch> [model <name>] [effort <level>]"
codex:
  display_name: "{{label}}: Review code"
  short_description: "Read-only review of a {{label}} PR or branch by {{prefix}}code-reviewer"
  default_prompt: "Use ${{prefix}}review-code to review this {{label}} pull request or branch."
---
# {{label}} review code

You gather the inputs and dispatch `{{prefix}}code-reviewer`; you do not review the diff yourself, and nothing in this flow writes to GitHub.

## Gather

The target is a pull request or a pushed branch in `{{repository}}`, never an issue.

1. Resolve the target.
   - `#N`, a bare number `N`, or a PR URL always names pull request N. Run `gh pr view N --repo {{repository}} --json number,state,headRefName,headRefOid,baseRefName,baseRefOid,closingIssuesReferences,url`. Open, merged, and closed PRs are all valid targets. If the command fails, stop and report that no pull request #N exists in `{{repository}}`. Do not fall back to reading N as an issue or to searching for PRs linked to one.
   - A branch name: `git ls-remote origin <branch>` gives the head; the base is the merge base with `origin/main` unless the request names one.
2. Fetch the objects on the human checkout (read-only; fetching does not change a checkout). The reviewer reads through `git diff` and `git show` in that worktree path.
   - PR: `git fetch origin pull/N/head <baseRefName>`. GitHub keeps `pull/N/head` after the branch is deleted, so this works for merged and closed PRs. The head SHA is `headRefOid`, the base SHA is `git merge-base <baseRefOid> <headRefOid>`, and the remote ref is `pull/N/head`.
   - Deleted base branch: when that fetch fails because `<baseRefName>` no longer exists (a merged or closed stacked PR), run `git fetch origin pull/N/head`, then `git fetch origin <baseRefOid>`. If the base commit still cannot be fetched, run `git fetch origin main`, use `git merge-base origin/main <headRefOid>` as the base SHA, and state in the packet that the base is an `origin/main` fallback for the deleted `<baseRefName>`, so the diff may include that branch's commits.
   - Branch: `git fetch origin <branch>`; the remote ref is the branch.
3. Acceptance criteria. For a PR, read every issue in `closingIssuesReferences` by its `url` (`gh issue view <url> --json body,comments`) and combine their acceptance criteria, labeled by issue. For a branch, read only an issue the request names by URL or as "issue N". With no such issue, use the request text as the criteria, set the issue to `none`, and say in the packet that the criteria come from the request.
4. Parse overrides: `model <name>` and `effort <level>` apply to the reviewer. A partial override changes only the named setting.

## Dispatch

Run `node scripts/agent-policy.mjs resolve --tool <tool> --role code-reviewer`, adding `--model` or `--effort` only for an override. If it exits non-zero, stop and report its message verbatim. Compose `Policy: tool=<tool> role={{prefix}}code-reviewer model=<model> effort=<effort> (model: <source>, effort: <source>)`.

Packet: `review_mode=requested`, repo, the PR URL when the target is a PR, issue URLs (every closing issue, or `none` and the source of the criteria), acceptance criteria, remote ref, base SHA (and whether it is an `origin/main` fallback), head SHA, the worktree path, and the `Policy:` line. Leave out your own opinion of the change.

<!-- claude-only -->
Use the Agent tool with `subagent_type: {{prefix}}code-reviewer` and the resolver's `model` and `effort` passed explicitly.
<!-- /claude-only -->
<!-- codex-only -->
Use `spawn_agent` with `agent_type: {{prefix}}code-reviewer`, `model` and `reasoning_effort` from the resolver's `spawn` object, and `fork_turns: "none"`. Always pass both values; the agent file carries neither. An unknown `agent_type` means the project is not trusted in Codex yet; say so and stop.
<!-- /codex-only -->

## Report

Print the reviewer's verdict, acceptance lines, findings, limits, and its `Policy:` and `Runtime:` lines verbatim. If the runtime model differs from the dispatched one, say so. Posting a review, replying on the PR, approving, or editing code requires a separate explicit request; this skill does none of it.
