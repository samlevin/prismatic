---
name: prism-agents
description: "Maintain the Prismatic repository agent workflows: change a role's model or effort, edit a role or skill, add or remove a role or skill, update the supported model list, then regenerate, verify, and stage the Claude Code and Codex output. Use for 'regenerate the agents', 'change the implementer model', 'add an agent role', or any edit under .agents/, .claude/agents, .claude/skills, or .codex/agents in samlevin/prismatic."
---
<!-- Generated from @agenticool/agents/sources/workflows/agents.md by agenticool-agents. Edit the source and run `npx agenticool-agents generate`. -->

# Prismatic maintain agents

Read and follow `.agents/worktree-isolation.md` before using a worktree.

The Claude Code and Codex definitions are generated. Never edit a generated file; every one carries a `Generated from ...` header and `npx agenticool-agents check` rejects hand edits. Work in the branch and worktree you already have; this skill does not create issues, branches, or PRs.

## Pick the source

| Change | Edit |
| --- | --- |
| The repository the workflows bind to: namespace prefix, label, repository, project, tracker documents, feature flags | `.agents/policy.json` (`binding`) |
| Model or effort for a capability, or which models and efforts a tool accepts | `.agents/policy.json` (`capabilities`, `supported`) |
| An agent's instructions, tools, isolation, color, or Codex permissions | `.agents/roles/<role>.md` (frontmatter `claude:` and `codex:` keys, body shared) |
| A skill's instructions, description, argument hint, or invocation policy | `.agents/workflows/<name>.md` |
| A reference a skill ships | `.agents/workflows/<name>/references/*.md` (Markdown references may carry tool-only blocks) |
| The leaf delivery procedure or the container queue | `.agents/workflows/implement/references/delivery.md` or `queue.md`; the `implement` skill and the `implementer` role only point to them |
| A rule several roles and skills share | its one source: `.agents/evidence.md` (retrieval and waiting), `.agents/review.md` (review packets and scope), `.agents/worktree-isolation.md` (worktrees), `.agents/issue-creation.md` (drafting and pointers to the classification and filing owners), `.agents/independence-groups.md` (independence groups), or `.agents/workflows/stack.md` (stacks); everything else references it instead of restating it |
| A new role | add `.agents/roles/<role>.md` and a `roles` entry in `policy.json` mapping it to a capability |
| A new skill | add `.agents/workflows/<name>.md` |
| Remove a role or skill | delete the source (and the `roles` entry); `generate` removes the generated output |

Sources never name the repository. Write `{{prefix}}`, `{{label}}`, `{{repository}}`, `{{project.owner}}`, `{{project.number}}`, `{{project.name}}`, `{{project.url}}`, `{{docs.triage}}`, `{{docs.workflow}}`, or `{{docs.guides}}` and the generator fills them from `binding`; an unknown placeholder fails generation. Wrap text that applies only when a feature flag is on in `{{#infrastructure}}` ... `{{/infrastructure}}`. To show a placeholder literally, as this paragraph does, write `\{{` in the source. Text that applies to one tool goes in a `<!-- claude-only -->` ... `<!-- /claude-only -->` or `<!-- codex-only -->` ... `<!-- /codex-only -->` block; everything else is shared and must read correctly in both tools. Do not add `model` or `model_reasoning_effort` to a Codex agent; the policy is applied at spawn time on purpose. Names get the `prism-` prefix from the generator, so write `name: implementer`, not `name: prism-implementer`. Keep `.agents/README.md` current when the policy table or the file layout changes; its policy table is a copy of `policy.json`. Role and skill text describes how the workflow runs, not how it changed; put the history in the PR.

Before adding a Codex model to `supported`, confirm it exists in `codex debug models`. Before adding a Claude model, confirm it is one of the documented aliases or a `claude-*` ID.

## Regenerate and verify

Run, from the repository root:

```console
npx agenticool-agents generate
npx agenticool-agents check
npm run format:check
```

`generate` prints every file it owns. If `check` or a test fails after generating, the source is wrong (a role without a policy entry, an unsupported model or effort in `policy.json`, a mismatched `name`), and its message says which. Fix the source and rerun; never patch the output.

## Stage and report

Stage the sources and the generated output together (`git add .agents .claude .codex`); a commit with one and not the other fails `npx agenticool-agents check` in CI. Report the sources you changed, the generated files that changed (`git status --short .claude .codex .agents/skills`), and the check results. Leave committing, pushing, and PRs to the flow you are already in.
