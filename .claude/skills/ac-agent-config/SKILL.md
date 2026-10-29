---
name: ac-agent-config
description: "Maintain the Prismatic repository agent workflows: change a role's model or effort, edit, add, or remove a repository-only role or skill, update the supported model list, then regenerate, verify, and stage the Claude Code and Codex output. Use for 'regenerate the agents', 'change the implementer model', 'add an agent role', or any edit under .agents/, .claude/agents, .claude/skills, or .codex/agents in samlevin/prismatic."
argument-hint: "[what to change, or 'regenerate']"
---
<!-- Generated from @agenticool/agents/sources/workflows/ac-agent-config.md by agenticool-agents. Edit the source and run `npx agenticool-agents generate`. -->

# Prismatic maintain agents

Read and follow `.agents/worktree-isolation.md` before using a worktree.

The Claude Code and Codex definitions are generated. Never edit a generated file; every one carries a `Generated from ...` header and `npx agenticool-agents check` rejects hand edits. Work in the branch and worktree you already have; this skill does not create issues, branches, or PRs.

## Pick the source

The shared roles, skills, references, and rules come from the `@agenticool/agents` package. This repository never holds their sources: change them upstream in `@agenticool/agents`, then update the dependency and regenerate. The repository edits only `.agents/policy.json` and its own local sources.

| Change | Edit |
| --- | --- |
| The project the workflows bind to, the display label, board documents, feature flags | `.agents/policy.json` (`binding`); the repository itself comes from the `origin` remote |
| Model or effort for a capability, or which models and efforts a tool accepts | `.agents/policy.json` (`capabilities`, `supported`), which override the defaults the packages ship in `@agenticool/core` |
| Which capability a role resolves to | `.agents/policy.json` (`roles`) |
| A shared role, skill, skill reference, or shared rule (`.agents/evidence.md`, `.agents/review.md`, and the other generated `.agents/*.md` files) | upstream in `@agenticool/agents`; never in this repository |
| A role only this repository has: its instructions, tools, isolation, color, or Codex permissions | `.agents/local/roles/<role>.md` (frontmatter `claude:` and `codex:` keys, body shared) and a `roles` entry in `policy.json` mapping it to a capability |
| A skill only this repository has: its instructions, description, argument hint, or invocation policy | `.agents/local/workflows/<name>.md`, with its references in `.agents/local/workflows/<name>/references/*.md` |
| Remove a local role or skill | delete the source (and the `roles` entry); `generate` removes the generated output |

Shared roles and skills carry the fixed `ac-` prefix. A local source keeps the name you give it, and a local name that starts with `ac-` fails generation.

Local sources never name the repository. Write `{{label}}`, `{{repository}}`, `{{project.owner}}`, `{{project.number}}`, `{{project.name}}`, `{{project.url}}`, `{{project.restPath}}`, `{{docs.triage}}`, `{{docs.workflow}}`, `{{docs.guides}}`, or `{{infrastructure.accountChecks}}` and the generator fills them from `binding`; an unknown placeholder fails generation. Wrap text that applies only when a feature flag is on in `{{#infrastructure}}` ... `{{/infrastructure}}`, and text that needs a non-empty value, such as a list, in a section named after its placeholder, such as `{{#infrastructure.accountChecks}}` ... `{{/infrastructure.accountChecks}}`; sections may nest. To show a placeholder literally, as this paragraph does, write `\{{` in the source. Text that applies to one tool goes in a `<!-- claude-only -->` ... `<!-- /claude-only -->` or `<!-- codex-only -->` ... `<!-- /codex-only -->` block; everything else is shared and must read correctly in both tools. Do not add `model` or `model_reasoning_effort` to a Codex agent; the policy is applied at spawn time on purpose. A source's `name` is the agent or skill name. Role and skill text describes how the workflow runs, not how it changed; put the history in the PR.

Before adding a Codex model to `supported`, confirm it exists in `codex debug models`. Before adding a Claude model, confirm it is one of the documented aliases or a `claude-*` ID.

## Regenerate and verify

Run, from the repository root:

```console
npx agenticool-agents generate
npx agenticool-agents sync
npx agenticool-agents check
npm run format:check
```

`generate` renders every shared and local source and prints every file it owns; `sync` rewrites the synced repository files (`AGENTS.md` sections, board files, the `.gitignore` block, and with `browserMcp` the `.mcp.json` and `.codex/config.toml` MCP entries) and prints their paths; `check` writes nothing and fails on any generated or synced file that is missing, stale, or hand-edited. If `check` or a test fails after generating, the source or the policy is wrong (a role without a policy entry, an unsupported model or effort in `policy.json`, a mismatched `name`), and its message says which. Fix the local source or the policy and rerun; never patch the output.

## Stage and report

Stage the policy, the local sources, the generated output, and the synced files together (`git add .agents .claude .codex .github AGENTS.md .gitignore ISSUE_TRIAGE.md`, plus `.mcp.json` with `browserMcp`; stage every path `sync` printed); a commit with one and not the other fails `npx agenticool-agents check` in CI. Report the policy keys and local sources you changed, the generated files that changed (`git status --short .claude .codex .agents/skills`), and the check results. Leave committing, pushing, and PRs to the flow you are already in.
