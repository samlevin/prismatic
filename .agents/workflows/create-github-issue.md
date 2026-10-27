---
name: create-github-issue
description: Plan and file {{label}} GitHub issues, native sub-issues, and explicitly requested epics using the repository's issue forms, labels, and {{label}} delivery project fields. Classifies inline by default and asks {{prefix}}issue-triager for independent triage when a batch needs independent classification, decomposition, or dependency judgment. Use for create/file/open/draft issue requests in {{repository}}. Does not implement or open PRs.
argument-hint: "[what to file] [triager model <name>] [triager effort <level>]"
capability: issue-creation
codex:
  display_name: "{{label}}: Create GitHub issue"
  short_description: "File typed {{label}} issues with independent triage"
  default_prompt: "Use ${{prefix}}create-github-issue to file this as one {{label}} issue."
---
# {{label}} create GitHub issues

## Resolve

Repository `{{repository}}`, project [{{project.name}}]({{project.url}}) (number {{project.number}}, owner `{{project.owner}}`). Read `.agents/issue-creation.md` and the matching `.github/ISSUE_TEMPLATE/*.yml`; `AGENTS.md` is already loaded. Read `{{docs.triage}}` when you classify drafts, which is the default. Discover labels (`gh api repos/{{repository}}/labels --paginate`), project fields and options (`gh api users/{{project.owner}}/projectsV2/{{project.number}}/fields --paginate`), and native issue types (`gh api orgs/<owner>/issue-types` when the repository owner is an organization; a user-owned repository has none) once per batch, and reuse the results. Every GitHub call you make in this skill is REST through `gh api`; the repository scripts it runs keep their own calls. Repository commands run read-only against the human checkout; do not modify it.

<!-- claude-only -->
This skill pins the main-thread model and effort for the turn from `.agents/policy.json` (`issue-creation`). A `model` or `effort` override in the request applies to this turn by naming it (`/model`, `--model`, `--effort`), not through this skill.
<!-- /claude-only -->
<!-- codex-only -->
Codex skills cannot set the session model. The repository policy for `issue-creation` is `node scripts/agent-policy.mjs resolve --tool codex --capability issue-creation`; state its model and effort in your first message as `Advisory policy: ...`, not as requested settings, because nothing dispatched this session and it runs whatever model Codex started with. Start Codex with `codex -m <model> -c model_reasoning_effort=<effort>` to run the session at that policy, or at an explicit override.
<!-- /codex-only -->

## Plan

For a small fix, use the supplied outcome, criteria, and validation directly; no separate planning document is needed. Reuse current discovery results and verified prerequisites, and retrieve only missing or stale metadata. Search for duplicates first (`gh api -X GET search/issues -f q='repo:{{repository}} is:issue <terms>'`). Well-scoped requests go straight to drafting. For broad ones, plan only outcomes, boundaries, acceptance criteria, and prerequisites, and ask only about material unknowns. Keep supplied decisions. Never invent impact, repro steps, tests, or architecture. Shape leaves, containers, and epics, and pick each one's template, by `{{docs.triage}}`. Strip a `[Type]:` title prefix if a template adds one.

## Triage

Classify inline by default: set severity, Priority, Size, labels, and LEAF or CONTAINER for each draft by `{{docs.triage}}`.

Spawn one `{{prefix}}issue-triager` for the batch instead when the filing needs independent judgment:

- Classification: the request asks for independent triage, or a draft's severity, Size, or leaf-or-container scope stays uncertain after you read `{{docs.triage}}`.
- Decomposition: a draft may hold more than one logical outcome, or the batch creates a container or epic.
- Dependency judgment: the batch files two or more leaves, which need blocked-by edges wherever they share files or contracts or build on each other, whether or not they share a container; a new container or epic has two or more leaf children, which need independence groups; or the batch adds blocked-by edges among its new issues.

A filing with a single leaf and no other dependency judgment still classifies inline.

Resolve the triager settings with `node scripts/agent-policy.mjs resolve --tool <tool> --role issue-triager`, adding `--model` or `--effort` only for a `triager` override in the request. If it exits non-zero, stop and report its message. Send only the drafts (ref, title, body, parent ref, and planned blocked-by refs), accepted decisions, the discovered label and option lists, which reason above applies, and the `Policy:` line (`Policy: tool=<tool> role=issue-triager model=<model> effort=<effort> (model: <source>, effort: <source>)`). Do not send the transcript or your intended verdict. Apply its severity, Priority, Size, labels, `EDGES` line, and independence groups: every returned edge joins the planned blocked-by edges, and each draft's Dependencies section names its blockers. Once you spawn it, never override its verdict with your own. On SPLIT_REQUIRED, split and re-triage only the affected drafts, plus their sibling leaves when the split changes a new container's leaves. There is no second pass otherwise. Only the triager forms independence groups.

<!-- claude-only -->
Spawn with the Agent tool: `subagent_type: {{prefix}}issue-triager`, passing `model` and `effort` from the resolver explicitly.
<!-- /claude-only -->
<!-- codex-only -->
Spawn with `spawn_agent`: `agent_type: {{prefix}}issue-triager`, `model` and `reasoning_effort` from the resolver's `spawn` object, `fork_turns: "none"`. Always pass both values; the agent file carries neither. An unknown `agent_type` means the project is not trusted in Codex yet; say so and stop.
<!-- /codex-only -->

## Publish

"Draft", "suggest", or "plan" means show the drafts and write nothing. "Create", "file", or "open" authorizes publishing the requested issues and necessary sub-issues, nothing more: no implementation, credentials, or tracker configuration. Load the {{prefix}}plain-language skill before writing bodies. Preflight template fields, labels, options, and project access. A missing item is a blocker; do not create configuration as a side effect.

Order: parents, then children, then native parent links, then blocked-by edges, planned and triager-returned alike (the waiting issue's `dependencies/blocked_by` gets the blocker's `id`; reject cycles), then the independence record in each new container or epic body for which the triager returned groups (read `.agents/independence-groups.md` for the format only when the triager returned groups; leave the rest of the body unchanged), then Priority and Size on each issue's project item (never Status: triage sets it), then the post-create commands (`node scripts/issue-triage.mjs --apply --issue N` per new issue and `node scripts/issue-containers.mjs --apply --issue N` per new top-level container, after the batch's relationships are complete). Add each new issue to the project only with `scripts/issue-project-membership.mjs`, never with a direct `POST` to the project's items, and set fields on the item it prints. When the membership workflow already added the issue, the script prints that existing item. If the script fails or prints no item, keep the issue, skip its fields and post-create commands, and report it as unfinished. Milestone and assignee only when requested or required by policy. Record each URL as it succeeds. On an ambiguous failure, search before retrying and repair rather than duplicate. REST mechanics: [references/github-operations.md](references/github-operations.md), read only when needed.

## Verify and return

Read back bodies, independence records, labels, parent and dependency direction, project membership, and fields. Return URLs, the hierarchy with each blocked-by edge and the triager's reason for the edges it returned, independence groups, either `Triage: inline` or the triager's `Requested settings: Policy: <as dispatched>` line verbatim with the reason you spawned it, and any partial result or uncertainty, compactly.
