# Repository agent workflows

This directory holds the sources of the delivery agents and skills this repository ships for Claude Code and Codex, and the policy that binds them to this repository.

| Path | Purpose |
| --- | --- |
| `policy.json` | The repository binding (namespace prefix, repository, project, tracker documents, feature flags), the model and effort per capability and tool, and the values each tool accepts |
| `roles/*.md` | Source of each agent role (shared text, with `<!-- claude-only -->` and `<!-- codex-only -->` blocks) |
| `workflows/*.md` | Source of each skill, the user-facing entry points |
| `workflows/<name>/` | Supporting references copied into both tools' skills |
| `skills/prism-*/` | Generated Codex skills (`SKILL.md`, `agents/openai.yaml`) |
| `../.codex/agents/prism-*.toml` | Generated Codex custom agents |
| `../.claude/agents/prism-*.md` | Generated Claude Code subagents |
| `../.claude/skills/prism-*/` | Generated Claude Code skills |
| `../scripts/agent-policy.mjs` | Resolver (`resolve`), generator (`generate`), and drift check (`check`) |
| `issue-creation.md` | Tool-agnostic issue filing adapter, read by `prism-create-github-issue` |
| `spec-slicing.md` | Specification format and ownership rules that `prism-spec-to-issues` files from; changes with that skill |

Edit the sources, run `npm run agents:generate`, and commit the output; `/prism-agents` (Claude Code) or `$prism-agents` (Codex) does the whole loop. Generated files carry a header saying so. `npm run agents:check` and `scripts/agent-policy.test.mjs` fail when a generated file is stale, and CI runs both for any change under `.agents/`, `.claude/`, `.codex/`, or `scripts/`.

Sources never name the repository. They use `{{placeholders}}`, which the generator fills from the `binding` block in `policy.json`, and `{{#infrastructure}}` sections, which it keeps only when `features.infrastructure` is on. It is off because nothing in this repository applies infrastructure from CI.

## Trust and discovery

Claude Code loads `.claude/agents/` and `.claude/skills/` from the repository root, a nested directory, and a linked worktree, with no trust step. Codex loads `.agents/skills/` everywhere, but `.codex/agents/` only after the project is trusted in `~/.codex/config.toml`; until then the skills report an unknown `agent_type` and stop. `/prism-review-security` and `$prism-review-security` run only when a person asks for them by name.

You need the tool itself, `gh` with authentication, the `gh stack` extension for stacked branches, and `npm ci` for the generator and checks. The resolver runs without `node_modules`.

## Requested settings in reports

Dispatchers compose the `Policy:` line from the resolver output, with the source of each value, so an explicit override shows up. When the implement workflow dispatches `prism-implementer` or `prism-orchestrator`, it appends `; handoff overrides: <role-prefixed overrides or none>` for that role's own handoffs. The roles and skills define which `Requested settings:` lines each report carries; AGENTS.md has the rule.
