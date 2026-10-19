---
name: review-code
description: "Independent read-only code review of a {{label}} pull request (open, merged, or closed) or pushed branch at exact base/head SHAs, against the acceptance criteria of the issue the PR closes, run by {{prefix}}code-reviewer at the repository policy or an explicit override. Use for \"review #N\" or \"review N\" (always pull request N, never an issue), \"review <PR URL>\", or \"review branch <name>\" in {{repository}}. Reports the findings to you and posts them as one review on an open PR target through publish-review; never approves or edits."
argument-hint: "<#PR | PR number | PR URL | branch> [model <name>] [effort <level>]"
codex:
  display_name: "{{label}}: Review code"
  short_description: "Review a {{label}} PR or branch with {{prefix}}code-reviewer and post the review to an open PR"
  default_prompt: "Use ${{prefix}}review-code to review this {{label}} pull request or branch."
---
# {{label}} review code

You gather the inputs and dispatch `{{prefix}}code-reviewer`; you do not review the diff yourself. The Publish step is the only write to GitHub: one review on an open PR target.

## Gather

The target is a pull request or a pushed branch in `{{repository}}`, never an issue.

1. Resolve the target.
   - `#N`, a bare number `N`, or a PR URL always names pull request N. Run `gh api repos/{{repository}}/pulls/N --jq '{number, state, merged: (.merged_at != null), headRefName: .head.ref, headRefOid: .head.sha, baseRefName: .base.ref, baseRefOid: .base.sha, url: .html_url}'`. Open, merged, and closed PRs are all valid targets. If the command fails, stop and report that no pull request #N exists in `{{repository}}`. Do not fall back to reading N as an issue or to searching for PRs linked to one.
   - A branch name: `git ls-remote origin <branch>` gives the head; the base is the merge base with `origin/main` unless the request names one.
2. Fetch the objects on the human checkout (read-only; fetching does not change a checkout). The reviewer reads through `git diff` and `git show` in that worktree path.
   - PR: `git fetch origin pull/N/head <baseRefName>`. GitHub keeps `pull/N/head` after the branch is deleted, so this works for merged and closed PRs. The head SHA is `headRefOid`, the base SHA is `git merge-base <baseRefOid> <headRefOid>`, and the remote ref is `pull/N/head`.
   - Deleted base branch: when that fetch fails because `<baseRefName>` no longer exists (a merged or closed stacked PR), run `git fetch origin pull/N/head`, then `git fetch origin <baseRefOid>`. If the base commit still cannot be fetched, run `git fetch origin main`, use `git merge-base origin/main <headRefOid>` as the base SHA, and state in the packet that the base is an `origin/main` fallback for the deleted `<baseRefName>`, so the diff may include that branch's commits.
   - Branch: `git fetch origin <branch>`; the remote ref is the branch.
3. Acceptance criteria. For a PR, list its closing issues with GraphQL, because REST has no closing-issues read: `gh api graphql -f query='query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { closingIssuesReferences(first: 50) { nodes { url } } } } }' -f owner=<owner> -f name=<repo> -F number=N --jq '.data.repository.pullRequest.closingIssuesReferences.nodes[].url'`, where `<owner>/<repo>` is `{{repository}}`. If that call is rate-limited, do not wait: take the issues named by closing keywords (`Closes`, `Fixes`, or `Resolves` `#N`) in the PR body from `gh api repos/{{repository}}/pulls/N --jq .body`, and say in the packet that the list came from the body. Read every closing issue through REST (`gh api repos/<owner>/<repo>/issues/<n> --jq .body` and `gh api 'repos/<owner>/<repo>/issues/<n>/comments?per_page=100' --paginate --jq '.[].body'`, taking owner, repo, and number from its `url`) and combine their acceptance criteria, labeled by issue. For a branch, read only an issue the request names by URL or as "issue N". With no such issue, use the request text as the criteria, set the issue to `none`, and say in the packet that the criteria come from the request.
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

## Publish

A branch target posts nothing. For a PR target, write the reviewer's report verbatim to a new file from `mktemp`, then run `node scripts/agent-policy.mjs publish-review --pr <N> --base <base SHA> --head <head SHA> --report <file>` once, with the base and head SHAs you sent the reviewer, including an `origin/main` fallback base. The command reads the PR again and posts nothing when the PR is merged or closed, when its head or its merge base with `baseRefOid` no longer matches the reviewed pair, or when the report has no readable `Base/Head:` line or names another pair. Otherwise it submits one review pinned to the head commit. The event is `REQUEST_CHANGES` only for a `REQUEST CHANGES` verdict when the `gh api user` login is not the PR author. Every other verdict or identity, including `APPROVE`, gets `COMMENT` with a first line that says why. It never approves. It prints `Posted: <event> <url>`, or `Review not posted: <reason>` and exits non-zero. Never retry with another event, and never post the feedback another way, such as `gh pr review`, `gh pr comment`, or another API call.

## Report

Print the reviewer's verdict, acceptance lines, findings, limits, and its `Requested settings:` line verbatim. End with one line: `Posted: <event> <url>` as the command printed it, `Not posted: <reason>` with the reason after `Review not posted:`, or `Posted: none (branch review)`. Replying on the PR, approving, or editing code requires a separate explicit request.
