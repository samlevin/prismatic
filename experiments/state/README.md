# Publisher identity and recovery spike (P0.10)

This spike tests the §7.1 storage channels and the §7.4 publication protocol: who may write trusted state, how bounded markers and journal shards are encoded, how a validated publication record is persisted, and what a run does after it is interrupted or after someone edits or deletes its comments. Its findings, the deletion and corruption limits, and the reset procedure are in [docs/lifecycle.md](../../docs/lifecycle.md). Production code never imports anything from this directory.

## Layout

- `lib/github.ts` is the GitHub port the protocol needs and an in-memory fake of one pull request. In the fake, as on GitHub, any comment can be edited or deleted after it is written, an edit keeps the original author, installation tokens get a 403 from `GET /user`, a write can apply and then lose its response, and renamed logins can be taken by another account.
- `lib/publisher.ts` resolves the expected publisher for the Actions `GITHUB_TOKEN`, a configured App, and the CLI's personal or App token, and checks authors by account id.
- `lib/marker.ts` encodes and decodes bounded v2 markers. `lib/keys.ts` derives the review, attempt, round and effect keys.
- `lib/journal.ts` writes and reads linked journal shards. `lib/record.ts` is the publication record, its effect plan, and its chunks and manifest. `lib/ledger.ts` adds the records up.
- `lib/protocol.ts` runs one attempt, resumes a validated record, and performs the authorized baseline reset.
- `lib/restGitHub.ts` is the same port over the REST API, used only by the live probe. Its tests use a fake `fetch`.
- `spike/probe.ts` is the live identity probe. The coverage gate leaves it out.

The offline evidence is the test suite. `lib/protocol.test.ts` has one `describe` block per acceptance criterion of #143. No test touches the network.

## Running it

```sh
npx vitest run experiments/state
```

The live probe reads by default and writes only with `--write`, which creates, edits, reads back and deletes one issue comment. Point it only at a sandbox pull request you are allowed to write to.

```sh
GITHUB_TOKEN=... node experiments/state/spike/probe.ts --repo <owner/name> --pr <n> --path personal --write
GITHUB_TOKEN=<app installation token> node experiments/state/spike/probe.ts --repo <owner/name> --pr <n> --path app --publisher-login <app-slug>[bot] --write
```

The Actions path has to run inside a workflow, because only a workflow holds a `GITHUB_TOKEN`. A minimal `workflow_dispatch` job in the sandbox repository checks out this repository, runs `npm ci` on Node 24, and runs:

```sh
node experiments/state/spike/probe.ts --repo "$GITHUB_REPOSITORY" --pr <n> --path actions --write
```

with `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` in the step's environment and `issues: write` and `pull-requests: write` in the job's permissions. The probe prints JSON with outcomes only, never a token, account id or personal login. It exits 1 when any author check fails.
