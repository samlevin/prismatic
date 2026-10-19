# Adversarial fixture corpus

Each scenario in `scenarios.ts` is a small Git history that a malicious pull request author could control, the GitHub payloads the pull request would deliver, and what a correct reviewer must never do with it. Security tests in `tests/security/` and the unit tests of any module that reads files, spawns a process, or parses untrusted input draw their cases from here.

The corpus is TypeScript data, not committed repositories. Credential-shaped values in `credentials.ts` come from a fixed-seed generator at run time, so the repository holds no token-shaped literal and every build produces the same values. None of them was ever a real credential.

## Scenarios

| ID | What it holds |
| --- | --- |
| `symlink-chains` | Symlinks that chain into an ignored `.env`, escape the repository, point at host files, loop, and stand in for a nested `.gitignore`. |
| `tracked-ignored-files` | Files committed even though `.gitignore` matches them, including a source file the pull request changes. |
| `gitignore-hides-change` | A pull request that changes `src/auth.ts` and adds an ignore rule for it in the same commit. |
| `gitattributes-change` | A rewritten `.gitattributes` that attaches filter, diff, and merge drivers. |
| `hostile-names` | Tree entries named `..` and `.git`, backslash and drive-letter names, a Unicode normalization collision, bidirectional and zero-width characters, and NUL bytes in the changed-files payload. |
| `binary-and-oversized` | A binary file with a `.ts` extension, a source file just over 256 KiB, and an image. |
| `lfs-pointer` | A Git LFS pointer committed under a source extension. |
| `submodule` | Gitlinks with a `.gitmodules` whose URL and update command would run a program. |
| `git-config-and-filters` | Committed Git configuration, hooks, a `.git/config` tree entry, and an embedded bare repository. |
| `shell-metacharacters` | File names that run a command in a shell, expand as a glob, or read as a Git option. |
| `prompt-injection` | Instructions aimed at the reviewer in code comments, the pull request body, and thread replies, with tracking images, script links, forged state markers, commands, and mentions. |
| `credentials` | A credential-shaped and a benign sample of every §5.5 detector row, a credential on an unchanged line, an access key ID alone and paired, a private key under a test path, and a token pasted into the body and a reply. |
| `non-default-base` | A pull request into `release/1.x`, whose configuration and rules differ from `main`, with a head that rewrites both. |
| `diverged-head` | A base branch that moved after the pull request branched, so a two-dot diff from the base tip is wrong. |

`types.ts` lists the acceptance items in `corpusCoverageItems`, and a test fails when no scenario covers one of them. Each scenario's `expectations` name the paths at the pull request head that a reviewer must never read, and the canary strings planted in commands the repository tries to get run.

## Building the repositories

```sh
node tooling/scripts/buildSecurityFixtures.ts /tmp/prismatic-security-corpus
```

The output directory must not exist or must be empty. For each scenario the builder writes `<id>/repo.git`, a bare repository with loose objects and refs, including `refs/pull/<n>/head`, and `<id>/payloads/` with the `pull_request` event, the changed-files list, the compare response with the merge-base, review comments, and issue comments. `manifest.json` lists every scenario's commit IDs.

The builder encodes Git objects itself with a fixed author, committer, and clock, so the same scenarios always produce the same object IDs and the same bytes. It does not run Git, which lets a fixture hold trees Git would refuse to create, such as an entry named `..`. Git reads the output like any other bare repository. Nothing in the corpus checks out a working tree, and nothing should: several scenarios exist to show what a checkout would run.

## Running a scenario

`evals/SecurityScenarioRunner.ts` mounts one revision, the pull request head by default, at `/repo` in an instrumented in-memory filesystem, next to a few host files such as `/etc/passwd`. It also supplies a process runner that records requests and never starts a process. The code under test receives both, and the runner then checks what it did:

- `assertNeverReads(paths)` fails when the code read, or tried to read, the contents of any listed path. That covers filesystem reads, directly or through a symlink, and Git reads in the mounted revision under any name Git resolves to it: a ref, the commit ID or an abbreviation of it, a suffixed form such as `<rev>~0` or `<rev>^{commit}`, or the ID of a tree or blob in it. A `<rev>:<path>` argument or input line, a blob ID, and a `--batch-command` `contents` line read that path. A content command such as `git diff`, `git grep`, `git archive`, or `git log -p` reads what its pathspecs cover, with or without `--`, and the whole tree when it has no positive pathspec; `:(exclude)` pathspecs leave paths out. A Git command not known to print only names or history is taken to read the whole revision it names. `lstat`, `readlink`, `readdir`, and Git commands limited to names (`--name-only`, `--batch-check`, `ls-tree`, `rev-parse`, `log` without a patch) do not count, but `git show <rev>:<path>` and searches such as `-S` always do. The environment hands the subject the mounted revision's commit ID as `revision`.
- `assertNeverExecutes()` fails when the code asked for a shell, an executable other than `git` or `ast-grep`, a working directory, `--git-dir`, `-C`, `HOME`, or `GIT_CONFIG_*` location inside the repository tree, a `PATH`, `GIT_EXEC_PATH`, `LD_LIBRARY_PATH`, or `DYLD_*` entry inside it, `LD_PRELOAD` or `DYLD_INSERT_LIBRARIES`, a repository name in an option position before `--`, a Git option or setting that runs a program or loads configuration (`--ext-diff`, `filter.*.clean`, `core.hooksPath`, `alias.*`, `include.path`, `protocol.allow` other than `never`, `GIT_SSH_COMMAND`, `GIT_SEQUENCE_EDITOR`, and similar, including settings passed through `GIT_CONFIG_PARAMETERS`), or a planted canary anywhere but a path argument. The §5.3 invocation passes.

The subject runs once, on the first assertion. A subject that rejects hostile input by throwing is fine. The assertions still judge what it touched before it stopped.
