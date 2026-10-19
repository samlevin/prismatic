# ADR 0002: One npm package with lint-enforced module boundaries

Status: accepted

## Context

Prismatic ships as one deployable: a Docker Action whose entrypoint and command line interface share one composition root. An earlier draft split the code into 17 npm workspaces, one per module. For a single deployable that split bought nothing. It cost TypeScript project references, a package manifest and configuration per module, and slower CI.

The modules still need firm import rules. The review pipeline must not reach the GitHub or OpenAI SDKs directly, and pure modules must not touch the filesystem or spawn processes.

## Decision

The product is the root npm package. Each module is a directory under `src/`, and the entrypoints live under `apps/`. The root `package.json` provides the `lint`, `typecheck`, `test`, and `build` scripts. The repository's existing `packages/*` workspace entry holds no product code.

An ESLint rule, `boundaries/imports` in `tooling/eslint/importBoundaries.ts`, enforces the import rules on every production file under `src/` and `apps/`. Tests beside the source (`*.test.ts`) are exempt. A violation fails `npm run lint`, and so fails CI.

| Kind | Modules | May import |
| --- | --- | --- |
| shared | `shared` | nothing else in `src/` |
| core | `core` | `shared` |
| domain | `evidence`, `context`, `rules`, `rounds`, `cache`, `prompts`, `state`, `findings`, `presentation`, `observability`, `config` | `shared`, `core`, and other domain modules |
| adapter | `github`, `repository`, `model` | `shared`, `core`, and domain modules |
| pipeline | `pipeline` | `shared`, `core`, and domain modules; adapters only through `core/ports.ts` |
| apps | `apps/<app>` | every module, including adapters and ports together |

A file may always import from its own module. The rule also enforces these:

- Only adapters import SDKs or the Node.js built-ins that reach the filesystem, processes, the network, or the module loader (`fs`, `child_process`, `net`, `http`, `https`, `module`, `vm`, `worker_threads`, and similar). Any third-party package counts as an SDK unless the rule's `packages` option lists it as a pure library. Built-ins without I/O, such as `node:crypto` and `node:path`, are open to every module.
- Production code never imports anything outside `src/` and `apps/`, so `experiments/`, `evals/`, `tests/`, and `tooling/` stay out of the shipped code.
- A directory under `src/` that the rule does not classify fails lint, and so does an import of one. A new module needs an entry in `sourceModules` first.
- A dynamic `import()` or `require()` with a computed specifier fails, because the rule cannot check it.
- The rule's `exceptions` option allows one exact specifier in one exact file, for cases such as a bootstrap descriptor or privilege operation in `apps/action/main.ts`. The list is empty today.

The import rules cover type-only imports too. Adapters do not import each other; one adapter that needs another goes through a port.

## Consequences

- One `package-lock.json`, one `tsconfig.json`, and one test run cover the product.
- Moving a file between modules changes which rules apply to it, and lint reports the result straight away.
- The rule resolves relative paths only. Path aliases and Node.js subpath imports (`#name`) count as packages and fail outside adapters, so production code uses relative imports.
- `tooling/eslint/fixtures/boundaries/` holds deliberate violations. `tooling/eslint/importBoundaries.test.ts` lints them with the repository configuration and expects the errors.
