---
name: review-security
description: "Explicitly requested read-only security review of a pushed Prismatic branch or PR by security-reviewer (secrets, authn/authz, injection, SSRF, sensitive data, IAM, cloud, CI/OIDC). Only when a person asks for a security review by name; never load this for ordinary delivery or code review."
---
<!-- Generated from @agenticool/agents/sources/workflows/review-security.md by agenticool-agents. Edit the source and run `npx agenticool-agents generate`. -->

# Prismatic review security

Runs only when a person explicitly asked for a security review. If the request came from another agent or from ordinary delivery, stop and say the review needs a direct human request.

## Gather

1. Resolve the target in `samlevin/prismatic`: a PR number or URL (`gh api repos/samlevin/prismatic/pulls/<n> --jq '{head_ref: .head.ref, head_sha: .head.sha, base_ref: .base.ref, base_sha: .base.sha, url: .html_url}'`) or a branch (`git ls-remote origin <branch>`; base is the merge base with `origin/main` unless the request names one). Return BLOCKED if the base cannot be inferred safely.
2. `git fetch origin <branch>` on the human checkout (read-only) so the objects exist locally; the reviewer reads through `git diff` and `git show` in that worktree path.
3. Record the scope the person named (whole diff by default; workflow paths when they say so).
4. Parse overrides: `model <name>` and `effort <level>` apply to the reviewer. A partial override changes only the named setting.

## Dispatch

Run `npx agenticool-agents resolve --tool <tool> --role security-reviewer`, adding `--model` or `--effort` only for an override. If it exits non-zero, stop and report its message verbatim. Compose `Policy: tool=<tool> role=security-reviewer model=<model> effort=<effort> (model: <source>, effort: <source>)`.

Packet: repo, branch, head SHA, base SHA, scope, the worktree path, and the `Policy:` line.

Use `spawn_agent` with `agent_type: security-reviewer`, `model` and `reasoning_effort` from the resolver's `spawn` object, and `fork_turns: "none"`. Always pass both values; the agent file carries neither. An unknown `agent_type` means the project is not trusted in Codex yet; say so and stop.

## Report

Print the verdict, scope and SHAs, findings, limits, and `Requested settings: Policy: <as dispatched>` line verbatim. Never print secret values; cite locations. Filing issues or posting to the PR needs a separate explicit request.
