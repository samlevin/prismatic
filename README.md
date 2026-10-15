# Prismatic

Prismatic has no product code yet. This repository holds the tooling that will deliver it: GitHub issue forms and labels, Node scripts that keep the [Prismatic delivery](https://github.com/users/samlevin/projects/2) board in sync, CI checks, and delivery agents for Claude Code and Codex.

## Layout

| Path | Contents |
| --- | --- |
| `.github/` | Issue forms, the PR template, `labels.json`, and the `ci-*` and `tracker-*` workflows |
| `scripts/` | Board automation, branch naming, CI scope selection, the agent definition generator, and their tests |
| `.agents/` | Sources and policy for the delivery agents and skills; see [.agents/README.md](.agents/README.md) |
| `.claude/`, `.codex/` | Agent definitions generated from `.agents/` |
| `packages/` | npm workspaces, none yet |

## Setup

Install the Node version in `.tool-versions`, then run `npm ci`. Working on issues also needs the [GitHub CLI](https://cli.github.com/) with authentication.

## Checks

`npm run check` runs the format check, lint, the generated agent definition check, and every script test. `npm run format` and `npm run lint:fix` fix what they can.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers issues, triage, branches, pull requests, and the automation. [AGENTS.md](AGENTS.md) holds the rules for coding agents.
