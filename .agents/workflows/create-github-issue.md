---
name: create-github-issue
description: Plan and file {{label}} GitHub issues, native sub-issues, and explicitly requested epics using the repository's issue forms, labels, and {{label}} delivery project fields, with independent {{prefix}}issue-triager metadata. Use for create/file/open/draft issue requests in {{repository}}. Does not implement or open PRs.
argument-hint: "[what to file] [triager model <name>] [triager effort <level>]"
capability: issue-creation
codex:
  display_name: "{{label}}: Create GitHub issue"
  short_description: "File typed {{label}} issues with independent triage"
  default_prompt: "Use ${{prefix}}create-github-issue to file this as an {{label}} issue."
---
# {{label}} create GitHub issues

## Resolve

Repository `{{repository}}`, project [{{project.name}}]({{project.url}}) (number {{project.number}}, owner `{{project.owner}}`). Read `.agents/issue-creation.md` and the matching `.github/ISSUE_TEMPLATE/*.yml`; `AGENTS.md` is already loaded. Read `{{docs.triage}}` only for a classification question. Discover labels (`gh label list`), project fields and options (`gh project field-list {{project.number}} --owner {{project.owner}} --format json`), and native issue types once per batch, and reuse the results. Repository commands run read-only against the human checkout; do not modify it.

<!-- claude-only -->
This skill pins the main-thread model and effort for the turn from `.agents/policy.json` (`issue-creation`). A `model` or `effort` override in the request applies to this turn by naming it (`/model`, `--model`, `--effort`), not through this skill.
<!-- /claude-only -->
<!-- codex-only -->
Codex skills cannot set the session model. The repository policy for `issue-creation` is `node scripts/agent-policy.mjs resolve --tool codex --capability issue-creation`; state it in your first message. Start Codex with `codex -m <model> -c model_reasoning_effort=<effort>` to run the session at that policy, or at an explicit override.
<!-- /codex-only -->

## Plan

Search for duplicates first (`gh issue list --search`). Well-scoped requests go straight to drafting. For broad ones, plan only outcomes, boundaries, acceptance criteria, and prerequisites, and ask only about material unknowns. Keep supplied decisions. Never invent impact, repro steps, tests, or architecture.

- Leaf = one logical feature, bug, or change. It uses `task.yml` or `bug.yml` with acceptance criteria and validation.
- Multiple independent outcomes become native sub-issues under a `container.yml` parent: What/Why/How, no acceptance criteria, no branch or PR. It closes when its children close. Containers may nest.
- Epic only when explicitly requested, with `epic.yml`. `epic` is its sole work-category label; severity, package, area, and risk labels may stay. Use `Parent epic` in a child body only when the immediate parent is an epic; otherwise `Parent issue`.
- Size never creates an epic. Titles are plain, with no `[Type]:` prefix; strip one if a template adds it.

## Triage

Resolve the triager settings with `node scripts/agent-policy.mjs resolve --tool <tool> --role issue-triager`, adding `--model` or `--effort` only for a `triager` override in the request. If it exits non-zero, stop and report its message. Spawn one `{{prefix}}issue-triager` for the batch with the resolved model and effort. Send only the drafts (ref, title, body), accepted decisions, the discovered label and option lists, and the `Policy:` line (`Policy: tool=<tool> role={{prefix}}issue-triager model=<model> effort=<effort> (model: <source>, effort: <source>)`). Do not send the transcript or your intended verdict. Apply its severity, Priority, Size, and labels. On SPLIT_REQUIRED, split and re-triage only the affected drafts. There is no second pass otherwise. Never triage yourself in place of the triager.

<!-- claude-only -->
Spawn with the Agent tool: `subagent_type: {{prefix}}issue-triager`, passing `model` and `effort` from the resolver explicitly.
<!-- /claude-only -->
<!-- codex-only -->
Spawn with `spawn_agent`: `agent_type: {{prefix}}issue-triager`, `model` and `reasoning_effort` from the resolver's `spawn` object, `fork_turns: "none"`. Always pass both values; the agent file carries neither. An unknown `agent_type` means the project is not trusted in Codex yet; say so and stop.
<!-- /codex-only -->

## Publish

"Draft", "suggest", or "plan" means show the drafts and write nothing. "Create", "file", or "open" authorizes publishing the requested issues and necessary sub-issues, nothing more: no implementation, credentials, or tracker configuration. Load the {{prefix}}write-prose skill before writing bodies. Preflight template fields, labels, options, and project access. A missing item is a blocker; do not create configuration as a side effect.

Order: parents, then children, then native parent links, then blocked-by edges (the blocker goes in `--blocked-by`; reject cycles), then project add with Priority, Size, and Status, then the adapter's post-create commands (`node scripts/issue-triage.mjs --apply --issue N` per new issue and `node scripts/issue-containers.mjs --apply --issue N` per new top-level container, after the batch's relationships are complete). Milestone and assignee only when requested or required by policy. Record each URL as it succeeds. On an ambiguous failure, search before retrying and repair rather than duplicate. CLI and API mechanics: [references/github-operations.md](references/github-operations.md), read only when needed.

## Verify and return

Read back bodies, labels, parent and dependency direction, project membership, and fields. Return URLs, the hierarchy, dependencies, the triager's `Policy:` line, and any partial result or uncertainty, compactly.
