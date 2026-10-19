# ADR 0003: A pinned ast-grep binary for symbol indexing and rule matches

Status: accepted

## Context

The review needs symbol definitions and skeletons of changed source files to choose context, and later the evidence engine needs structural rule matches. Both run on pull request content, which an attacker controls, inside the Action container on every run. Whatever parses that content must be pinned, must not execute repository code, and must not need anything installed at run time.

The alternatives considered:

- Native `tree-sitter` bindings for Node.js. Each grammar is a native addon that must be compiled for the image's platform and Node.js version, so every added language adds a native build to the image and to its supply chain.
- Language servers or compilers for each language. They read project configuration, can run plugins, and are far larger than the job needs.
- Regular expressions alone. They cannot find where a declaration ends, so they cannot produce skeletons.

## Decision

The image ships one pinned `ast-grep` binary, and `SymbolIndexTool` runs it as `ast-grep scan --json` with vendored rule files for each language. `docker/binaries.lock` records its version and the SHA-256 of the release archive for each platform. The build refuses an archive with a different checksum or a binary that reports a different version.

The binary runs like `git`: by absolute path, with no shell, with an argument array and an explicit environment, with a timeout, and with bounded output, after the entrypoint has dropped root (`docker/runtime-policy.md`). It reads only eligible blobs that the run has written as regular files to its own temporary directory. Rules come only from files vendored in this repository. The reviewed repository cannot supply any.

ast-grep reports matches, not syntax trees. Facts that need a tree, such as local control flow, come from the `typescript` compiler API for JavaScript and TypeScript and from `web-tree-sitter` WebAssembly grammars for Python and Go. Those run inside Node.js and need no native build.

## Consequences

- One binary and one checksum per platform cover every supported language. Adding a language means adding vendored rule files and their tests, not a native build.
- Languages without validated rules fall back to a lexical scan, and the review discloses the fallback.
- An ast-grep upgrade is a change to `docker/binaries.lock`. The container smoke test checks the version the image ships.
- The image is built for `linux/amd64` and `linux/arm64`. Another platform needs its own lock entry.
