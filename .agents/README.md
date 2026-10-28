# Repository agent workflows

This directory holds the shared sources for the Prismatic delivery workflows that ship with the repository for Claude Code and Codex. Contributors get the same roles, routing, checks, and handoffs in both tools without installing anything into their workstation configuration.

| Path | Purpose |
| --- | --- |
| `policy.json` | The repository binding (namespace prefix, repository, project, tracker documents, feature flags), the model and effort per capability and tool, and the values each tool accepts |
| `roles/*.md` | Source of each agent role (shared text, with `<!-- claude-only -->` and `<!-- codex-only -->` blocks) |
| `workflows/*.md` | Source of each skill, the user-facing entry points |
| `workflows/<name>/` | Supporting references copied into both tools' skills, with placeholders resolved and, in Markdown, only that tool's tool-only blocks |
| `workflows/implement/references/delivery.md` | The one leaf delivery procedure, for the main thread and an isolated implementer alike |
| `workflows/implement/references/queue.md` | The queue script procedure the main thread runs for leaves and containers |
| `workflows/stack.md` | The stack skill, the one source for branch, link, rebase, and sync safety |
| `skills/prism-*/` | Generated Codex skills (`SKILL.md`, `agents/openai.yaml`) |
| `../.codex/agents/prism-*.toml` | Generated Codex custom agents |
| `../.claude/agents/prism-*.md` | Generated Claude Code subagents |
| `../.claude/skills/prism-*/` | Generated Claude Code skills |
| `../scripts/delivery-queue.mjs` | Read-only REST queue ledger and next-leaf selection, with recorded effort decisions |
| `../scripts/agent-policy.mjs` | Resolver (`resolve`), generator (`generate`), drift check (`check`), and manual review publisher (`publish-review`) |
| `worktree-isolation.md` | Shared worktree ownership and setup rules, read before roles or skills use a worktree |
| `review.md` | Shared reviewer packet, initial coverage, and re-review scope, loaded for code review |
| `evidence.md` | Shared retrieval and waiting rules for delivery owners, isolated implementers, and code reviewers |
| `issue-creation.md` | Tool-agnostic issue drafting adapter, read by `prism-create-github-issue` and `prism-spec-to-issues`; points to the classification and filing owners |
| `independence-groups.md` | Shared independence group definition and record format, read by `prism-issue-triager` and `prism-implement`, and by the filing skills only when the triager returns groups |

Edit the sources, run `npm run agents:generate`, and commit the output; `/prism-agents` (Claude Code) or `$prism-agents` (Codex) does the whole loop, including picking the right source file and running the checks. `npm run agents:check` and the test in `scripts/agent-policy.test.mjs` fail when a generated file is stale, so the Claude and Codex versions cannot drift apart. CI runs that check for any change under `.agents/`, `.claude/agents/`, `.claude/skills/`, `.codex/agents/`, or `scripts/agent-policy*` (`scripts/ci-scope.mjs` puts those paths in the repository scope) and fails the pull request; it does not regenerate or commit on your behalf. Generated files carry a header saying so.

## Reuse in another repository

The role and workflow sources name no repository. They carry `{{placeholders}}` (`{{prefix}}`, `{{label}}`, `{{repository}}`, `{{project.*}}`, `{{docs.*}}`) and `{{#infrastructure}}` sections that the generator resolves from `binding` in `policy.json`. Another repository copies `roles/`, `workflows/`, `worktree-isolation.md`, `evidence.md`, `review.md`, `independence-groups.md`, `scripts/agent-policy.mjs` and `scripts/delivery-queue.mjs` with their tests, and `scripts/cli.cjs`, `scripts/github-api.mjs`, `scripts/issue-triage.mjs`, `scripts/issue-pr-status.mjs`, and `scripts/issue-pr-metadata.mjs`, which the workflows, `agent-policy.mjs`, and `delivery-queue.mjs` import, writes its own `policy.json` with its own `binding`, and runs `npm run agents:generate`; its agents and skills come out under its own prefix, and its `agents:check` keeps them current. Text that only makes sense with CI-applied infrastructure (Terrateam, OpenTofu, CDK) is inside `{{#infrastructure}}` sections and drops out when `features.infrastructure` is false.

## Agents and skills

Both tools support both packaging forms, and the repository uses both, each for what it does well.

Skills carry the entry points in the thread a person is talking to. `prism-implement` dispatches a leaf or PR rework to one `prism-implementer` by default. The main thread runs `delivery-queue.mjs`, starts implementers sequentially, records fixed results, and assesses compact escalation requests. It reads source, diffs, or detailed review reports only when needed to explain a blocker requiring a person. An explicit `inline` keyword keeps a small leaf or rework here. `prism-create-github-issue` drafts, classifies, and files issues inline. `prism-spec-to-issues` validates a plan offline, gets independent triage, and files after confirmation. There is no separate dispatcher, orchestrator, or stack manager agent.

Agents are for work that needs a fresh context or a hard boundary. An agent definition carries the role boundary (read-only reviewer, implementer that may write and push), an isolated context, a tool allowlist in Claude Code and a permission profile in Codex, and the slot where the model and effort policy applies. The repository defines four roles:

- `prism-code-reviewer`: the independent, read-only pre-PR gate and requested reviews. A reviewer must not share the implementer's context or self-assessment, so it is always a separate agent.
- `prism-security-reviewer`: explicitly requested read-only security review.
- `prism-issue-triager`: independent classification, decomposition, and dependency judgment, when an ad hoc filing batch needs it, and for every spec delivery plan.
- `prism-implementer`: the default isolated delivery owner for one leaf or PR rework. It creates the worktree, claims, implements, validates, handles review findings, runs stacks, and opens the PR. It never delegates to another implementer.

Skills are also the entry points and the policy adapter. A skill is what a person invokes (`/prism-implement`, `$prism-implement`), it runs in the main thread where it can ask a question, and it is the only place that can apply the repository policy at spawn time. That last point decides the split for Codex: a Codex agent file that sets `model` or `model_reasoning_effort` takes precedence over every spawn-time value, so a pinned agent file would defeat prompt overrides. The generated Codex agents therefore carry neither field, and the skills pass the resolved values to `spawn_agent` on every dispatch. Codex also loads repository skills in an untrusted project but loads project agents only after trust, so a skill is the right place to tell the contributor that the agents are missing. In Claude Code the per-invocation `model` and `effort` parameters already override frontmatter, so the generated Claude agents pin the policy and the skills still pass the resolved values explicitly for the same reason: a dispatch must never depend on a session or contributor default.

A skill cannot change the session model in either tool, so inline work runs at whatever model and effort the session has. `prism-implement` applies the implementation policy through explicit implementer spawn settings. Only explicit inline delivery reports it as `Advisory policy:`. Claude Code skill frontmatter can pin a model for the turn that loads the skill; `prism-create-github-issue` and `prism-spec-to-issues` use that for their filing flows, while `prism-implement` does not, because a delivery spans many turns and both tools should behave alike.

## Parity matrix

| Component | Claude Code | Codex | Checked by |
| --- | --- | --- | --- |
| Leaf and PR rework delivery (isolated, default) | `prism-implementer` through the Agent tool; worktree under `.claude/worktrees/`; independent reviewer | `prism-implementer` through `spawn_agent` with `fork_turns: "none"`; worktree under `.codex/worktrees/`; independent reviewer | same source and `references/delivery.md`; routing tests |
| Container queue (main thread, sequential) | `/prism-implement` with `references/queue.md` | `$prism-implement` with `references/queue.md` | same source; routing tests |
| Explicit inline implementation (small leaf or rework) | `/prism-implement inline`, session settings | `$prism-implement inline`, session settings | same source; routing tests |
| Stack operations | `/prism-stack`, loaded by the worktree's creator with the Skill tool | `$prism-stack`, loaded by the worktree's creator | same source; routing tests |
| Issue creation | `.claude/skills/prism-create-github-issue` (pins `sonnet`/`medium` for the turn) | `.agents/skills/prism-create-github-issue` | same source; routing tests |
| Spec delivery plan | `/prism-spec-to-issues` | `$prism-spec-to-issues` | same source; offline fixtures; confirmation and resume tests |
| Issue triage (when filing needs it) | `.claude/agents/prism-issue-triager.md` (`Read, Grep, Glob, Bash`) | `.codex/agents/prism-issue-triager.toml` (`:read-only`) | same source |
| Code review | `prism-code-reviewer` (`Bash, Read, Grep, Glob`, `isolation: worktree`) | `prism-code-reviewer` (`:read-only`) | same source; routing tests |
| Security review | `prism-security-reviewer` (adds `WebFetch, WebSearch`) | `prism-security-reviewer` (`:read-only`) | same source; routing tests |
| Entry points | `/prism-implement`, `/prism-stack`, `/prism-review-code`, `/prism-review-security`, `/prism-plain-language`, `/prism-agents` | `$prism-implement`, `$prism-stack`, `$prism-review-code`, `$prism-review-security`, `$prism-plain-language`, `$prism-agents` | same source; manifests generated |
| Policy resolution | `node scripts/agent-policy.mjs resolve --tool claude ...` | `... --tool codex ...` | `scripts/agent-policy.test.mjs` |

"Same source" means the Claude and Codex files are rendered from one Markdown file; only the tool-only blocks differ (how to spawn, how to load a skill, how the worktree is created, and the Claude reviewer's optional detached checkout). The test suite renders every role, workflow, and Markdown reference for both tools and requires every shared line in both renderings. "Routing tests" in `scripts/agent-policy.test.mjs` also check behavior: each source names the same agents, skills, and references in both tools; `prism-implement` dispatches a leaf and rework to an implementer by default and runs the read-only queue script for containers; the queue stays sequential unless a person asks for parallel delivery; the delivery owner loads `prism-stack` itself; the pre-PR review stays mandatory on its paths; issue filing classifies inline unless it needs independent judgment; and only the four roles above resolve and generate, so no generated file names an `orchestrator` or `stack-manager` agent.

[Agent worktree isolation](worktree-isolation.md) owns the setup and ownership rules for every role and skill. The worktree's creator runs every mutation in it, stack operations included.

## Model and effort policy

| Capability | Claude Code | Codex |
| --- | --- | --- |
| Issue creation (main thread) | `sonnet` / `medium` | `gpt-6.1-sol` / `medium` |
| Issue triage | `haiku` / `low` | `gpt-6-luna` / `low` |
| Implementation (binding for an implementer, advisory for explicit inline) | `claude-opus-5-5` / `medium` | `gpt-6.1-sol` / `medium` |
| Code review | `opus` / `high` | `gpt-6.1-sol` / `high` |
| Security review | `opus` / `max` | `gpt-6-astra` / `high` |

`policy.json` is the source; this table is a copy for readers. `supported` in the same file lists the models and effort levels each tool accepts. Update it when a tool adds or retires a model (`codex debug models` prints the Codex catalog; Claude Code aliases are `haiku`, `sonnet`, `opus`, and `fable`, or a full `claude-*` ID).

Most leaves use medium. `policy.json` holds stable rubric IDs: `H1-boundary` for an unresolved new cross-component guarantee, `H2-coupled-design` for interacting correctness constraints the supplied design does not resolve, and `H3-demonstrated-limit` for a reproducible medium correctness failure or substantive finding requiring design revision. The assessment names the unresolved question, evidence, and why medium with the written plan is insufficient. Labels, Size, infrastructure, contracts, and routine fixes never select high alone. Explicit medium prevents escalation; missing decisions or prerequisites stay blockers. The implement workflow owns announcements, confirmation, and the one-transition recovery procedure. Reviewer settings stay independent at high.

### Precedence

1. An explicit `model <name>` or `effort <level>` in the request wins, for the role the skill dispatches. A role prefix targets a handoff: `reviewer effort max`, `implementer model opus`, `triager effort medium`. In `prism-implement`, an unprefixed override targets an isolated implementer; inline work runs at the session settings, and the skill says so instead of applying the override.
2. Otherwise the repository policy applies.
3. A partial override changes only the named setting; the other stays at the policy value (`source` in the resolver output says which).
4. Overrides last for the task and the handoffs they name. Nothing rewrites `policy.json`, `~/.claude`, or `~/.codex`.

The resolver refuses a model or effort the repository does not list and prints why; the dispatcher stops and reports that message. Nothing substitutes another value. This matters because the runtimes do not fail on their own: Claude Code maps an unsupported effort to the highest supported level below it, and Codex falls back to `[agents]` defaults or the parent when a spawn field is missing.

### Reports

Each dispatched role reports `Requested settings: Policy: <as dispatched>`. The policy line records the requested model and effort and whether each came from policy or an explicit override. Caller workflows retain that label when relaying results, including a container's per-leaf rows and issue triage results. Inline work reports `Advisory policy: ...` instead, because nothing dispatched it and it runs at the session settings. These values describe the dispatch request, not what the runtime ran: `CLAUDE_CODE_EFFORT_LEVEL` and a Codex agent file field override them silently (see [Known limitations](#known-limitations)). Use the effective-model verification row below when that matters. Routine reports omit model self-identification, runtime-verification fields, and automatic verification warnings or discussions; `AGENTS.md` states this once for every role and skill.

For example, an inline Codex delivery reports `Advisory policy: tool=codex capability=implementation model=gpt-6.1-sol effort=medium (session settings apply)`, and an isolated Codex implementer reports `Requested settings: Policy: tool=codex role=implementer model=gpt-6.1-sol effort=medium (model: policy, effort: policy); decision: default; evidence: ticket/spec; reason: The written plan resolves the design.`. A code review requested with `model gpt-6-sol effort xhigh` reports `Requested settings: Policy: tool=codex role=code-reviewer model=gpt-6-sol effort=xhigh (model: override, effort: override)`.

### Vendor differences and adapters

| Concern | Claude Code | Codex |
| --- | --- | --- |
| Where the policy is applied | agent frontmatter (`model`, `effort`) plus explicit Agent tool parameters | explicit `spawn_agent` parameters only; agent files omit both fields on purpose |
| Precedence in the runtime | per-invocation parameter > frontmatter > `CLAUDE_CODE_SUBAGENT_MODEL` > session model; `CLAUDE_CODE_EFFORT_LEVEL` beats every effort source | agent file field > spawn value > `[agents].default_subagent_*` > parent |
| Main-thread skill model | skill frontmatter can pin it for the turn that loads the skill (used by `prism-create-github-issue` and `prism-spec-to-issues`); otherwise set the session with `/model` or `claude --model <model> --effort <effort>` | not possible; start the session with `codex -m <model> -c model_reasoning_effort=<effort>` |
| Built-in guidance | none against overrides | the `spawn_agent` description says not to set `model` unless the user asks; the skills override that because the repository policy is the user's standing request |
| Effective-model verification (operator check) | the Agent tool call shows the parameters, and the subagent's system prompt names its model | the child cannot read its model reliably; verify with `sqlite3 ~/.codex/state_5.sqlite "select agent_role, model, reasoning_effort from threads order by rowid desc limit 5"` (Codex 0.162 schema) or the thread view |

## Discovery, trust, and versions

The per-invocation `effort` parameter needs Claude Code 2.1.292 or later; Codex needs a release with `spawn_agent` (subagent workflows are on by default in current releases).

Claude Code loads `.claude/agents/` and `.claude/skills/` by walking up from the working directory to the repository root, so they load from the root, a nested directory, and a linked worktree. No trust step gates them. A project agent with the same name as a personal agent replaces the personal one, and a personal skill shadows a project skill of the same name. `/prism-review-security` has `disable-model-invocation: true`, so only a person can start it.

Codex loads `.agents/skills/` from every directory between the working directory and the repository root, in trusted and untrusted projects alike. It loads `.codex/agents/` only when the project is trusted (`trust_level = "trusted"` for the repository path in `~/.codex/config.toml`, which Codex writes when you accept the trust prompt). A linked worktree inherits the main checkout's trust. Until the project is trusted, `spawn_agent` reports an unknown `agent_type` for `prism-*`, and the skills say so instead of continuing. Inline delivery and stack operations need no agent, so they start without trust, but a delivery that needs the pre-PR reviewer stops at that gate. Codex lists skills that share a name side by side rather than picking one. `$prism-review-security` has `allow_implicit_invocation: false`, so Codex never picks it on its own.

Every identifier here starts with `prism-` so that it cannot collide with a contributor's own agents and skills in either tool.

Trusting the folder activates the agent definitions. Nothing here installs, copies, symlinks, or registers agent definitions outside the checkout, and a session in another repository does not see them. Ordinary prerequisites stay yours: the tool itself, `gh` with authentication, the `gh stack` extension for stacked branches, and `npm ci` for the checks (the resolver itself runs without `node_modules`).

## Manual review publication

`prism-review-code` posts the reviewer's report to an open target pull request after `prism-code-reviewer` returns. The reviewer itself stays read-only, and the skill posts through `node scripts/agent-policy.mjs publish-review`, so both tools follow one rule. That command reads the pull request again and posts nothing when the pull request is merged or closed, or when its head moved or the merge base of its current base and head is no longer the reviewed base. It compares the `gh api user` login with the PR creator's login and submits one review pinned to the reviewed head commit. The event is `REQUEST_CHANGES` only for a `REQUEST CHANGES` verdict from a different account, because GitHub rejects a change request or an approval from a pull request's own author. Every other case, including an identity it cannot establish, is a `COMMENT` review whose body says why when the event differs from the verdict. It never approves. Branch reviews and the implementer's pre-PR reviews post nothing. `scripts/agent-policy.test.mjs` covers each case against mocked `gh` responses.

## Known limitations

- Codex skills cannot change the session model, so the issue-creation policy for Codex is advisory for the main thread and binding only for a spawned triager.
- `prism-implement` cannot change the session model in either tool. The implementation policy binds only an isolated implementer; inline delivery runs at the session settings and reports the policy as advisory.
- Inline delivery keeps exploration in the main conversation and requires an explicit `inline` request for a small leaf or rework. The default main thread stays thin and records only ledger and fixed result fields.
- If a Codex runtime refuses main -> implementer -> reviewer depth, the main thread starts the reviewer, reads verdict/blocker lines, and passes a complete findings file to the implementer. Exact-SHA approval and the two-round limit still apply.
- Token metrics are available only when a tool exposes them. PR usage records name unavailable input, cached input, output, and reasoning metrics for parent, implementer, and reviewer and make no savings claim.
- Claude Code honors `CLAUDE_CODE_EFFORT_LEVEL` above everything, including the repository policy and a prompt override. Leave it unset when you want the repository defaults.
- Reports carry requested settings, never verified ones. Codex cannot verify a child's model from inside the child; the thread table or thread view is the ground truth.
- Prompt overrides are read from natural language by the dispatching skill; the resolver validates the values but cannot see the request.
- Codex approval rules belong to each contributor. The repository ships no exec policy, so a contributor's own rules decide which `git` and `gh` commands run without a prompt.
