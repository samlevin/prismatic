# Action image runtime policy

The Prismatic Action runs in the image the repository `Dockerfile` builds. The release pipeline publishes that image to GHCR, and `action.yml` refers to it by digest, so a consumer's runner pulls a finished image and never builds one. This file lists the rules the image and its entrypoint, `apps/action/main.ts`, follow.

## Image contents

- Every stage starts from `node:24.22.0-trixie-slim`, pinned by the digest of its multi-platform index.
- Git and ast-grep are the only native tools. `docker/binaries.lock` pins each one by version and SHA-256, and `docker/fetch-pinned.sh` refuses a download whose checksum differs. Git is built from its release tarball without Perl, Python, Tcl/Tk, translations, or the optional Rust code. ast-grep comes from its release archive for the target platform. Each build stage also checks that the binary reports the locked version.
- The runtime stage removes npm, npx, corepack, and yarn. Nothing is installed or downloaded when the container starts, and the container smoke test runs every container with `--network none`.
- The image creates the system user and group `prismatic`, uid and gid 10001, with no home directory and no login shell. Code and binaries belong to root, so this user cannot change them.
- The build context is an allowlist in `.dockerignore`, so local files such as credentials and worktrees never reach the build.

## Privilege drop

GitHub requires container actions to start as root, so the workspace mount is accessible. The `Dockerfile` therefore has no `USER` instruction. The entrypoint does the following, in this order:

1. Reads the Action inputs from the `INPUT_*` environment variables.
2. Opens `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY` for appending. They live on a runner-owned mount that `prismatic` may not be allowed to write, so the run keeps these descriptors and never reopens the paths. The open refuses a relative path, a symbolic link, and anything that is not a regular file. It never creates a missing file, because a file created by root on a host mount would belong to root.
3. Clears the supplementary groups, then sets the group and user to `prismatic`.
4. Checks that no user or group ID is still 0 and that root cannot be restored. If either check fails, the run stops before any child process starts.

A process that starts without root keeps its identity, as long as none of its IDs is 0.

The run's workspace is created after the drop, under the container's own `/tmp`, so it belongs to `prismatic` and only that user can open it. `TMPDIR`, `RUNNER_TEMP`, and `GITHUB_WORKSPACE` are never used for it, because on a runner they name host mounts owned by root.

## Child processes

Only the pinned `git` and `ast-grep` binaries run, by absolute path, with `shell: false`, an argument array, a timeout, and a bound on captured output. A child gets an explicit environment and never inherits the entrypoint's, so Action inputs such as the GitHub token do not reach it. Every `git` process gets this environment:

| Variable | Value |
| --- | --- |
| `GIT_CONFIG_NOSYSTEM` | `1` |
| `GIT_CONFIG_GLOBAL` | `/dev/null` |
| `HOME` | an empty directory inside the run's workspace |
| `GIT_TERMINAL_PROMPT` | `0` |
| `GIT_NO_LAZY_FETCH` | `1` |

It also gets these options, before the subcommand:

```text
-c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external=
-c protocol.allow=never -c protocol.https.allow=always
-c submodule.recurse=false -c credential.helper=
```

## Outputs and failures

Each output is written in the runner's multi-line form with a random delimiter, so a value cannot end its entry early and add another output. A failure prints one `::error::` line with secrets masked and line breaks and `%` escaped, writes `result: failed` when `GITHUB_OUTPUT` is open, and exits with status 1.

Until the review pipeline exists, a stub runs after the drop. It creates the workspace, runs `git init --bare` there as the first git process, and reports `result: skipped` with `skip-reason: unsupported-event`.

## Testing

`npm run test:container` builds the image and runs `tests/e2e/container-smoke/` against it. It needs Docker, and the build needs the network. Set `PRISMATIC_SMOKE_IMAGE` to test an image you have already built. The test checks that:

- the image has no `USER`, ships the locked Git and ast-grep versions, has no package manager, and has the `prismatic` user;
- the output files it prepares are not writable by `prismatic`, and outputs written after the drop still reach them;
- the workspace and the repository that the first `git` process created belong to uid 10001, not root.

The unit tests in `apps/action/main.test.ts` and the cases in `tests/security/actionImage.test.ts` cover the same rules without Docker.

## Updating a pinned binary

1. Pick the release and download each artifact the lock lists for it.
2. Compare each file's SHA-256 with the checksum the project publishes: `sha256sums.asc` on kernel.org for Git, and the digests GitHub shows for the ast-grep release assets.
3. Update the version, checksums, and URLs in `docker/binaries.lock`.
4. Run `npm run test:container`.

To move the base image, update the tag and the index digest on the first `FROM` line together.
