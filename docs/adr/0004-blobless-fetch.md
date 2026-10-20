# ADR 0004: Blobless fetch with exact blob acquisition

Status: accepted

## Context

The review reads pull request content without ever checking it out. Spec §5.3 and §5.4 describe a two-stage blobless fetch: stage A fetches the trusted base tip with `--depth=1 --filter=blob:none`, and stage B fetches the PR head, the merge-base, the last reviewed head and the findings' baseline commits the same way. Blobs then arrive only for paths that pass metadata admission. The draft named `git backfill --sparse --no-include-edges <sha>^!` as the acquisition command and required `GIT_NO_LAZY_FETCH=1` on every Git process, so that a read outside the acquired scope fails instead of downloading. P0.8 (#141) is the go/no-go gate for that contract: if the pinned Git cannot acquire exactly the intended objects, the strategy changes before any production slice builds on it, and the repository is never fetched in full to get past the gate.

The spike lives in `experiments/fetch/`. `experiments/fetch/run-in-image.sh` runs it inside the Action image, with the pinned Git 2.56.0 from `docker/binaries.lock`, as the unprivileged user (uid 10001). Every Git process gets the §5.3 environment and `-c` options. Fixture remotes are generated bare repositories served over `file://` with `uploadpack.allowFilter` and `uploadpack.allowAnySHA1InWant`, the settings GitHub behaves like. The GitHub sandbox run fetches this public repository anonymously over HTTPS, pull request #236, with the normative options only. Each recorded step lists every object in the store before and after it, so the results record the ID, type and size of every object a recorded step acquired. Three parts of the run have no step records: the `history-cost` preparations, which keep only per-run counts, the preparation in `lazy-fetch-disabled`, and the commit fetches that set up the `backfill` clients. `experiments/fetch/results/2026-10-19.json` holds the run this ADR cites. Every check in it passed.

## Findings

### `git backfill` cannot run under `GIT_NO_LAZY_FETCH=1`

`git backfill` downloads blobs through Git's lazy-fetch path, and `GIT_NO_LAZY_FETCH=1` switches that path off. With the variable set, backfill fails with `lazy fetching disabled` and `could not fetch <oid> from promisor remote`, and acquires nothing. The draft contract cannot be met as written.

With lazy fetch enabled for the backfill process alone, the rest of the draft held:

- Sparse mode works in a bare store once `HEAD` names the commit and `info/sparse-checkout` holds non-cone patterns. It needs no worktree.
- With the parent commit present, `--no-include-edges` acquired only the two head blobs in scope. Without it, the parent's version of `src/f3.ts` arrived too.
- Rooted patterns with `*`, `?`, `[`, `]`, `!`, `#` and trailing spaces escaped matched the eight literal names and none of their five decoys. A name containing a newline cannot be written as a pattern line and is refused.

### Exact blob IDs are an ordinary fetch

The command Git's own lazy fetch sends also works as a deliberate fetch:

```sh
git -c fetch.negotiationAlgorithm=noop fetch --no-tags --no-write-fetch-head \
  --recurse-submodules=no --filter=blob:none --stdin origin
```

with one planned blob ID per input line. This is not a lazy fetch, so it runs with `GIT_NO_LAZY_FETCH=1`. In every scenario, on the fixtures and on GitHub, the fetch of the admitted blobs acquired exactly the planned IDs. A blob ID the server does not have fails the fetch with `not our ref` and acquires nothing.

The noop negotiator is required. Once a local ref names a commit, as it does after stage B stores the PR ref, the default negotiator advertises that commit, and the server leaves out every blob reachable from it. The fetch then fails with `did not send all necessary objects` and acquires nothing. Without local refs the default negotiator happens to work, which is why this is easy to miss.

### Metadata needs no blobs

- `git ls-tree -r -z` and `git diff --raw --no-renames --no-abbrev -z` ran on the blobless store without acquiring anything. A rename appears as a delete and an add.
- `git ls-tree -l` prints `BAD` for a blob the store lacks, so blob sizes must come from the remote. Git 2.56's `remote-object-info` sized a blob on the fixture server without fetching it, but GitHub refuses it with `object-info capability is not enabled on the server`. Sizes keep coming from the REST tree API, as §5.4 says.
- Of the fixture's changed names, the one that is not valid UTF-8 and the one with a newline were reported by byte length and hex prefix and never reached admission.

### Reads outside the scope fail

After acquisition, `git cat-file`, `git diff -p` and `git grep` on a path outside the admitted scope each failed and acquired nothing. `git grep` over the admitted paths worked. On GitHub, `cat-file` of an unacquired blob failed the same way.

### GitHub sandbox

For pull request #236 (head `543e549a`, merge-base `27978a5d`), the 23 changed paths gave 22 eligible files. The fetched `refs/pull/236/head` resolved to the head SHA the API reported. Stage B acquired exactly the 23 planned blobs, 74,414 bytes. The whole GitHub run, ancestry checks included, downloaded 119,374 bytes of pack data.

### Admission and probes

Metadata excluded, before any blob was requested: a file ignored at every revision, a file hidden by an ignore rule the PR adds (also reported as hidden-reviewable), a 300 KiB file over the 256 KiB cap, `generated/`, a Markdown file, a symlink and a submodule. Ignore rules were evaluated by acquiring only the `.gitignore` blobs, writing them as regular files to a scratch repository, and running `git check-ignore --no-index`. The content probe then rejected a binary file and a Git LFS pointer, both with `.ts` names. LFS targets were never requested.

### Ancestry without blobs

| Case | Result | Deepen steps | Blobs acquired |
| --- | --- | --- | --- |
| Prior head five commits below head, both fetched at depth 1 | `ancestor` | 3 of 2 commits | 0 |
| Force-pushed head, prior head on the discarded branch | `rewritten`, once the history was complete | 2 of 4 commits | 0 |
| Prior head the server does not have | `unknown` | 0 | 0 |
| Same as the first row with a bound of one 1-commit step | `unknown` | 1 | 0 |
| GitHub: prior head three commits below head | `ancestor` | 1 of 25 commits | 0 |

A shallow store cannot prove a negative, so `rewritten` needs the complete history of both commits. Within the 200-commit cap that is only possible for short histories. Anything else is `unknown`, which never counts as reviewed. Completeness is checked per commit: no commit `git rev-list <head> <prior>` lists may be a shallow boundary. `git rev-parse --is-shallow-repository` is the wrong test, because the depth-1 base tip in the same store keeps the whole store shallow. The fixture clients hold that base tip, and the `rewritten` case was proved while the store stayed shallow.

### No failure widens the scope

All 130 fetches in the fixture run and all 10 in the GitHub run carried `--filter=blob:none`. Every failed step in both runs acquired no objects. Lazy fetch was enabled only for the three backfill measurements.

### The 2 GiB fixture

The fixture's tree holds 2,148,329,321 bytes of blobs: 512 incompressible 4 MiB files and 200 source files. For a 10-file change, stages A and B downloaded 48,219 bytes of pack data. The blobs in it were the 6-byte `.gitignore` and 80,774 bytes for the 20 head and merge-base sides of the changed files. The limit is 100 MiB.

### Preparation cost grows with reviewed history

Each PR below has the same three-line delta in one file and the same two open findings, with evidence in two files and their baselines at the frontier. Only the already-reviewed history differs: 2 files in one round, 121 files in 11 rounds, and 495 files in 11 rounds, close to the 500-file cap. Files are about 6 KB. The union plan follows §5.4. The narrowed plan acquires only the incremental delta and the findings' evidence paths. Parsing ran the pinned ast-grep over the eligible head files. Times are medians of five runs on a 2-CPU container.

| History | Plan | Manifest paths | Blobs acquired | Blob bytes | Files parsed | Bytes parsed | Parse ms | Patch bytes | Wall ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 files | union | 2 | 5 | 30,127 | 2 | 12,057 | 3 | 25,447 | 62 |
| 2 files | narrowed | 2 | 5 | 30,127 | 2 | 12,057 | 3 | 25,447 | 63 |
| 121 files | union | 121 | 243 | 1,460,780 | 121 | 727,857 | 31 | 1,515,613 | 144 |
| 121 files | narrowed | 2 | 5 | 30,127 | 2 | 12,057 | 3 | 25,447 | 69 |
| 495 files | union | 495 | 991 | 5,969,350 | 495 | 2,984,573 | 114 | 6,207,817 | 372 |
| 495 files | narrowed | 2 | 5 | 30,127 | 2 | 12,057 | 3 | 25,447 | 71 |

Under the union manifest, unrelated blob acquisition, parsing and patch generation grow linearly with reviewed history, while the delta stays one file. The narrowed plan stays constant. Commit and tree metadata grew slightly with history in both plans, as expected.

The narrowed rows are a lower bound for the plan decision 6 adopts. The fixture has no pending ranges or obligations, because every earlier round was fully reviewed. They also leave out the files the one-hop impact graph needs, which the bounded reference search finds. The spike did not measure either addition.

Wall-clock time is not the problem: under half a second against a 22-minute deadline. The read volume is. At the cap, a one-file delta reads 2.83 MiB of unrelated source to index it, 18% of the 16 MiB context read budget, at 6 KB per file. Real files are larger, and the cost repeats on every incremental round.

## Decision

1. Keep the two blobless stages, `--depth=1 --filter=blob:none`, no checkout, `GIT_NO_LAZY_FETCH=1` on every Git process, and no full-fetch fallback.
2. Acquire blobs with the exact blob-ID fetch above, never with `git backfill`. This is the tested equivalent §5.4 allows. The plan lists object IDs from metadata, deduplicated across revisions and counted against the 100 MiB budget, and the fetch sends them in batches of `fetch.backfillBatchSize`. Because the request names objects rather than paths, no sparse pattern is written and no path needs escaping for acquisition. Pathspecs for `git diff` and `git grep` stay literal (`:(literal)<path>`).
3. Every acquisition step requests only the planned blob IDs the store does not already hold. Afterwards it verifies that every planned blob ID is in the store and that no unplanned blob arrived, and fails otherwise. A blob already in the store, such as a `.gitignore` read for admission or content shared with another path, is not requested again and is not reported as missing.
4. Blob sizes come from the GitHub tree API. `remote-object-info` is not used while GitHub does not offer it.
5. Ancestry is proved by blobless deepening within `fetch.deepenCapCommits`, or by the compare API. `rewritten` requires complete history of both commits, checked per commit as above, or the compare API. Everything else is `unknown`.
6. Adopt the narrowed acquisition plan for incremental and reconcile rounds. Acquisition, parsing and patches cover the incremental delta, the evidence paths of open findings, paths with pending ranges or `CoverageObligation` records, and the files the bounded reference search admits for the one-hop impact graph. The rest of the union manifest stays as metadata for eligibility, the hidden-path detector, coverage and ledger reconstruction. It narrows the union manifest and does not replace it. Full rounds still acquire the whole union manifest.

   One question stays open for P3.2a (#169) and P1.0 (#147). `git grep` fails on blobs that were never acquired, as the `lazy-fetch-disabled` scenario shows, so the reference search cannot find one-hop files among bodies the narrowed plan skipped. The search therefore needs its own bounded acquisition of the blobs it scans, under the separate 64 MiB search-scan budget and nearest directories first, as §5.1 describes. If P3.2a cannot keep that acquisition well below the union manifest's cost, it measures the plan with obligations and search candidates included and revisits this decision before freezing its contract.

## Consequences

- No dependent slice is blocked. The bounded strategy works, with the acquisition command changed.
- P1.0 (#147) orchestrates the exact blob-ID fetch instead of `git backfill`, and plans acquisition per decision 6.
- P1.1 (#148) allows `-c fetch.negotiationAlgorithm=noop` on fetches that name blob IDs, and keeps `protocol.file.allow=always` reachable only from the test harness.
- P1.9 (#156) acquires admitted blobs by ID and verifies the store against the plan, as decision 3 says. It needs no sparse-checkout configuration.
- P1.4 (#151) and P3.2a (#169) build patches and indexes from the narrowed set in incremental rounds, and P3.2a owns the open question under decision 6. P1.10 (#157) follows decision 5.
- The spec's §5.3 `RepositoryFetcher` row and §5.4 scoped-backfill paragraph still name `git backfill`. This ADR supersedes them until the spec is revised.
- `docker/binaries.lock` notes that this contract was proved against Git 2.56.0. A Git upgrade reruns `experiments/fetch/run-in-image.sh` (`docker/runtime-policy.md`).
- GitHub may start advertising `object-info`, or change how it answers wants by blob ID. Rerunning the spike with `--github` detects both.
