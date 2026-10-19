# Prismatic

Prismatic is a pull request review agent, built as one npm package. Its modules under `src/` are empty so far. This repository also holds the tooling that delivers it: GitHub issue forms and labels, Node scripts that keep the [Prismatic delivery](https://github.com/users/samlevin/projects/2) board in sync, CI checks, and delivery agents for Claude Code and Codex.

## Layout

| Path | Contents |
| --- | --- |
| `.github/` | Issue forms, the PR template, `labels.json`, and the `ci-*` and `tracker-*` workflows |
| `scripts/` | Board automation, branch naming, CI scope selection, the agent definition generator, and their tests |
| `.agents/` | Sources and policy for the delivery agents and skills; see [.agents/README.md](.agents/README.md) |
| `.claude/`, `.codex/` | Agent definitions generated from `.agents/` |
| `src/` | Product modules, one directory each, with import boundaries that lint enforces; see [docs/adr/0002-single-package.md](docs/adr/0002-single-package.md) |
| `apps/action/` | The Docker Action entrypoint, which drops root before any child process starts |
| `Dockerfile`, `docker/` | The Action image, its pinned Git and ast-grep binaries, and its runtime policy; see [docker/runtime-policy.md](docker/runtime-policy.md) |
| `tests/` | Cross-cutting suites: `security/` for hostile inputs, `e2e/` for the container smoke test |
| `tooling/` | The coverage gate and the import boundary lint rule, with their tests |
| `docs/adr/` | Architecture decision records |
| `packages/` | npm workspaces, none yet |

## Setup

Install the Node version pinned in `.tool-versions`: with [asdf](https://asdf-vm.com/), run `asdf plugin add nodejs` and then `asdf install`; otherwise install that version any way you like. Then run `npm ci` and `npm run check`. Nothing in `npm run check` needs AWS, Docker, or any other service. Only the container smoke test needs Docker. Working on issues also needs the [GitHub CLI](https://cli.github.com/) with authentication.

## Checks

`npm run check` runs the format check, lint of JavaScript, TypeScript, and Markdown, the strict TypeScript check, the generated agent definition check, every script test, and the Vitest unit tests. `npm test` fails when unit test coverage drops below 90% for statements, branches, functions, or lines; `tooling/CoverageGate.ts` reads the summary Vitest writes to `coverage/`. `npm run build` compiles `src/` and `apps/` to `dist/`. `npm run test:container` builds the Action image and runs the container smoke test in `tests/e2e/` against it. It needs Docker, and the build needs the network. `npm run format` and `npm run lint:fix` fix what they can in code. Fix Markdown lint problems by hand.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers issues, triage, branches, pull requests, and the automation. [AGENTS.md](AGENTS.md) holds the rules for coding agents.
