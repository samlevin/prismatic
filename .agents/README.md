# Repository agent workflows

This directory holds the sources of the delivery agents and skills this repository ships for Claude Code and Codex, and the policy that binds them to this repository.

| Path | Purpose |
| --- | --- |
| `policy.json` | The repository binding (namespace prefix, repository, project, tracker documents, feature flags), the model and effort per capability and tool, the values each tool accepts, and the implementation effort rubric |
| `roles/*.md` | Source of each agent role (shared text, with `<!-- claude-only -->` and `<!-- codex-only -->` blocks) |
| `workflows/*.md` | Source of each skill, the user-facing entry points |
| `workflows/<name>/` | Supporting references copied into both tools' skills, with placeholders resolved and, in Markdown, only that tool's tool-only blocks |
| `includes/*.md` | Text several roles, skills, and skill references carry word for word, such as the review packet, inserted wherever one of them writes `{{> name}}`; an include cannot contain another |
| `workflows/implement/references/delivery.md` | The one leaf delivery procedure, for an isolated implementer and an inline leaf alike |
| `workflows/implement/references/queue.md` | The dependency queue the main thread runs from `scripts/delivery-queue.mjs`, with the claim and effort record formats |
| `workflows/stack.md` | The `prism-stack` skill, the one source for branch, link, rebase, push, and sync safety |
| `skills/prism-*/` | Generated Codex skills (`SKILL.md`, `agents/openai.yaml`) |
| `../.codex/agents/prism-*.toml` | Generated Codex custom agents |
| `../.claude/agents/prism-*.md` | Generated Claude Code subagents |
| `../.claude/skills/prism-*/` | Generated Claude Code skills |
| `../scripts/agent-policy.mjs` | Resolver (`resolve`), implementer dispatch checked against the effort rubric (`dispatch`), generator (`generate`), drift check (`check`), and `publish-review`, which posts a `prism-review-code` report as one review on an open PR |
| `../scripts/delivery-queue.mjs` | Read-only REST ledger of a leaf or container: dependency order, states, claims, stack readiness, and the `--next` leaf |
| `../scripts/spec-to-issues.mjs` | Offline pre-flight of a specification's delivery plan: drafts, validation, triager edges, and the printed tree |
| `evidence.md` | Retrieval and waiting rules for delivery owners, isolated implementers, and code reviewers |
| `review.md` | The independent code review procedure: initial review and re-review scope |
| `worktree-isolation.md` | Who creates, owns, and may touch each agent worktree |
| `issue-creation.md` | Tool-agnostic issue drafting rules, with pointers to the classification and filing owners |
| `independence-groups.md` | The independence group definition and record format |
| `../specs/TEMPLATE.md` | Specification template; its delivery plan section is what `prism-spec-to-issues` files |

Edit the sources, run `npm run agents:generate`, and commit the output; `/prism-agents` (Claude Code) or `$prism-agents` (Codex) does the whole loop. Generated files carry a header saying so. `npm run agents:check` and `scripts/agent-policy.test.mjs` fail when a generated file is stale, and CI runs both for any change under `.agents/`, `.claude/`, `.codex/`, or `scripts/`.

Sources never name the repository. They use `{{placeholders}}`, which the generator fills from the `binding` block in `policy.json`, and `{{#infrastructure}}` sections, which it keeps only when `features.infrastructure` is on. It is off because nothing in this repository applies infrastructure from CI.

## Skills and agents

Skills carry the work that runs in the thread a person talks to. `prism-implement` makes that thread a dispatcher: it reads the `scripts/delivery-queue.mjs` ledger, hands each leaf or PR rework to one isolated `prism-implementer`, and records its fixed result, so the main conversation never holds a leaf's exploration. An explicit `inline` keeps a small leaf or rework in the thread. `prism-create-github-issue` drafts, classifies, and files issues in the thread.

Agents are for work that needs a fresh context or a hard boundary:

- `prism-code-reviewer`: the independent read-only pre-PR gate and requested reviews. It never shares the delivery owner's context or self-assessment.
- `prism-security-reviewer`: read-only security review, only when a person asks.
- `prism-issue-triager`: independent classification, decomposition, blocked-by edges, and independence groups, when a filing batch needs it and for every specification plan.
- `prism-implementer`: the default delivery owner for one leaf or rework, at medium effort unless the rubric in `policy.json` records a reason for high. It never spawns another implementer.

The test suite renders every role, workflow, and Markdown reference for both tools and requires every shared line in both renderings. Its routing tests also check behavior: each source names the same agents and skills in both tools, `prism-implement` dispatches a leaf and a rework to an isolated implementer unless the request says `inline`, a container runs through the queue, the queue stays sequential unless parallel delivery is requested, the delivery owner runs `prism-stack` itself, pre-PR review stays mandatory on the paths `AGENTS.md` lists, issue filing classifies inline unless it needs independent judgment, and only the four roles above resolve and generate.

## Trust and discovery

Claude Code loads `.claude/agents/` and `.claude/skills/` from the repository root, a nested directory, and a linked worktree, with no trust step. Codex loads `.agents/skills/` everywhere, but `.codex/agents/` only after the project is trusted in `~/.codex/config.toml`; until then the skills report an unknown `agent_type` and stop. Until then, only `inline` delivery and stack operations start, and a delivery that needs the pre-PR reviewer stops at that gate. `/prism-review-security` and `$prism-review-security` run only when a person asks for them by name.

You need the tool itself, `gh` with authentication, the `gh stack` extension (`github/gh-stack`) for stacked branches, and `npm ci` for the generator and checks. When a delivery needs a stack and the extension is missing, `prism-implement` asks you to run `! gh extension install github/gh-stack` and waits for you; no agent installs it. The resolver runs without `node_modules`.

## Requested settings in reports

Dispatchers compose the `Policy:` line from the resolver output, with the source of each value, so an explicit override shows up. When `prism-implement` spawns an isolated `prism-implementer`, it appends `; handoff overrides: <reviewer overrides or none>` for that implementer's own handoffs. A skill cannot change the session model in either tool, and no skill spawns an agent only to enforce the policy. Claude Code skill frontmatter can pin a model for the turn that loads the skill, and `prism-create-github-issue` and `prism-spec-to-issues` use that; `prism-implement` does not, because a delivery spans many turns. So inline `prism-implement` work in both tools and the Codex filing skills report `Advisory policy: ...` instead. The roles and skills define which settings lines each report carries; AGENTS.md has the rule.
