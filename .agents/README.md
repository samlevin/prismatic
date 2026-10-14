# Repository agent workflows

This directory holds the shared sources for the delivery workflows that ship with the repository for Claude Code and Codex. The sources are the same files as in [mcc-stats-suite](https://github.com/samlevin/mcc-stats-suite); only `policy.json` differs, and its `binding` block names this repository, its project, its namespace prefix, and which feature sections apply.

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

Edit the sources, run `npm run agents:generate`, and commit the output; `/prism-agents` (Claude Code) or `$prism-agents` (Codex) does the whole loop. `npm run agents:check` and `scripts/agent-policy.test.mjs` fail when a generated file is stale, and CI runs both on every pull request. Generated files carry a header saying so.

To pick up a change made to the sources in mcc-stats-suite, copy `roles/`, `workflows/`, `scripts/agent-policy.mjs`, and `scripts/agent-policy.test.mjs` over, keep this repository's `policy.json`, and regenerate. Sources never name a repository: they use `{{placeholders}}` and `{{#infrastructure}}` sections that the generator resolves from `binding`, and `features.infrastructure` is off here because nothing in this repository applies infrastructure from CI.

## Trust and discovery

Claude Code loads `.claude/agents/` and `.claude/skills/` from the repository root, a nested directory, and a linked worktree, with no trust step. Codex loads `.agents/skills/` everywhere and `.codex/agents/` only after the project is trusted in `~/.codex/config.toml`; until then the skills report an unknown `agent_type` and stop. `/prism-review-security` and `$prism-review-security` run only when a person asks for them by name.

Prerequisites stay yours: the tool itself, `gh` with authentication, the `gh stack` extension for stacked branches, and `npm ci` for the generator and checks. The resolver itself runs without `node_modules`.
