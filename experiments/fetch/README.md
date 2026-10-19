# Scoped-fetch spike (P0.8)

This spike tests the blobless fetch contract from spec §5.3 and §5.4 against the pinned Git in the Action image. Its conclusions and the accepted contract are in [ADR 0004](../../docs/adr/0004-blobless-fetch.md). Production code never imports anything from this directory.

## Running it

```sh
experiments/fetch/run-in-image.sh > results.json
experiments/fetch/run-in-image.sh --skip-large > results.json
experiments/fetch/run-in-image.sh --github samlevin/prismatic 236 980f3c9d35c34dd9ee7717a6af38546719977024 > results.json
```

The script builds the image from the repository `Dockerfile`, or uses `PRISMATIC_SPIKE_IMAGE` when it is set, and runs `spike/main.ts` in it as uid 10001 with `experiments/` and `src/` mounted read-only. Results are JSON on stdout and progress goes to stderr. The exit status is 0 only when every check passes. A full run takes about two minutes, most of it generating the 2 GiB fixture. `--skip-large` leaves that fixture out.

`--github <owner/repo> <pr> <sha>` adds a run against a GitHub repository over anonymous HTTPS, with `<sha>` an earlier head of the pull request. It uses only public endpoints: the pull request, compare and recursive tree REST APIs, and Git fetches by commit, PR ref and blob ID. Nothing is checked out.

Fixture repositories are generated in the container's `/tmp` from the descriptions in `spike/reviewFixture.ts`, `spike/large.ts` and `spike/history.ts`, with fixed commit times and seeded content, so object IDs are the same on every run. Nothing generated is committed.

## Layout

- `lib/` holds the parts that become production candidates: the normative Git environment and runner, the process spawner, object accounting, `ls-tree` and raw-diff parsers, the union manifest, admission planning, the content probe, sparse patterns and literal pathspecs, ancestry classification, and the fast-import fixture writer. Unit tests sit beside each file and count toward the coverage gate.
- `spike/` holds the scenarios and the workbench they share. It runs only inside the image, so the coverage gate leaves it out. The recorded results are its evidence.
- `results/` holds the JSON from the run ADR 0004 cites.

## Scenarios

| Id | Criteria in #141 | What it checks |
| --- | --- | --- |
| `raw-inventory` | 1, 2 | Blobless fetch, `ls-tree` and `diff --raw --no-renames` read no blobs, renames split, hostile names are reported, and sizes must come from the remote |
| `admission-and-acquisition` | 1, 2 | Ignore rules, oversized and non-regular entries, exact blob-ID acquisition, and the binary and LFS probe |
| `acquisition-negotiation` | 1, 2 | Blob-ID fetches need the noop negotiator once a local ref exists |
| `backfill` | 2, 3 | `git backfill` under `GIT_NO_LAZY_FETCH`, `--no-include-edges` with the parent present, and escaped sparse patterns with decoys |
| `lazy-fetch-disabled` | 2, 3 | Reads outside the acquired scope fail without fetching |
| `ancestry` | 3 | Shallow ancestor, rewritten and unknown histories without blobs |
| `history-cost` | 4 | Preparation cost for one delta with little, much and maximal reviewed history, union versus narrowed plans |
| `large-2gib-10-files` | 3 | A 10-file change in a 2 GiB tree downloads under 100 MiB |
| `github-sandbox` | 1, 2, 3 | Stage A and stage B, exact acquisition, `remote-object-info`, lazy-fetch refusal and ancestry against GitHub |
| `no-full-fetch` | 3, 5 | Every fetch carried `--filter=blob:none`, and no failed step acquired anything |
