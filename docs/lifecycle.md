# PR state, publication and recovery

This page records what P0.10 (#143) established about the publisher identity, the bounded state markers, the journal, the publication record, and recovery after interruption, deletion or corruption (spec §7.1 and §7.4). The production codecs (P6.1) and the state repository (P6.2) build on it. The spike is described in [experiments/state/README.md](../experiments/state/README.md).

## Status

| Part | State |
| --- | --- |
| Forged snapshot rejection by account id | Verified offline |
| Publisher resolution: Actions `GITHUB_TOKEN`, configured App, CLI personal token, CLI App token | Verified offline. Read-only lookups verified live on 2026-10-19. Writes verified live on 2026-10-20 for the Actions `GITHUB_TOKEN`, App and CLI personal token paths |
| Bounded markers, decompression caps, linked shards, chunked publication record | Verified offline |
| Status snapshot deletion with inline and progress publication off, and with no findings | Verified offline |
| Interruption at every step, and lost write responses | Verified offline |
| Deletion and corruption limits, baseline reset | Verified offline |

"Offline" means the fake pull request in `experiments/state/lib/github.ts`, where every comment can be edited or deleted after it is written. No test assumes a comment stays as it was written.

## Publisher identity

A run decides whose comments it trusts before it reads any marker. The expected login comes from the trusted `publisher-login` workflow input, which defaults to `github-actions[bot]`, or from the CLI's own personal token. The run resolves that login to its account id with `GET /users/{login}`, or takes the id from `GET /user` for a personal token. From then on only the id counts. A comment is state only when the author id GitHub reports for it equals the resolved id, and every write response must report the same id or the run stops.

| Token | How the publisher is resolved | Notes |
| --- | --- | --- |
| Actions `GITHUB_TOKEN` | `publisher-login` input, default `github-actions[bot]`, through `GET /users/{login}` | `GET /user` refuses installation tokens with 403, so the login cannot come from the token |
| GitHub App token in Actions | `publisher-login` set to the App's `<slug>[bot]` login | The login must end in `[bot]` and resolve to a `Bot` account. The bot user's id is what appears as a comment author; it is not the App id |
| CLI personal token | `GET /user` | The account must be a `User` |
| CLI App token | `--publisher-login <slug>[bot]` | Same rules as the App in Actions. Without the flag the CLI cannot resolve the App, because `GET /user` refuses the token |

An Actions run may also name a machine user that owns a personal token stored as a secret. That login resolves to a `User` account and is accepted.

The tests in `lib/protocol.test.ts` cover the forged cases. A snapshot posted by another account, whose API author matches the login the snapshot claims for itself, is ignored, together with the journal shard and effect marker in the same comment. A byte-for-byte copy of the publisher's own status comment posted by another account is ignored. A comment from another account full of compression bombs is counted as ignored, and none of its markers is decoded. A publisher-authored snapshot naming another pull request is ignored. `lib/publisher.test.ts` covers renames: after the publisher renames, another account can take the old login; its comments do not pass, and the publisher's earlier comments still do. Under a publisher resolved as the forger, the same comments would be trusted, which shows the account id is the only thing that decides.

Live, read-only, on 2026-10-19: with a personal token, `GET /user` succeeded and returned a `User`. `GET /users/github-actions%5Bbot%5D` and the same lookup for another App's bot login returned `Bot` accounts.

Live, with writes, on 2026-10-20: a `workflow_dispatch` job in a sandbox repository ran the probe with the workflow's `GITHUB_TOKEN` (`--path actions --write`) against a sandbox pull request. `GET /user` returned 403, the publisher resolved to `github-actions[bot]`, and `createAuthorMatches`, `editAuthorMatches` and `listAuthorMatches` were all `true`. The probe deleted its comment afterwards. The same probe under a CLI personal token (`--path personal --write`), against the same pull request, resolved the publisher through `GET /user`, matched the author on create, edit and list, and deleted its comment. Under an App installation token minted inside a `workflow_dispatch` job (`--path app --publisher-login <slug>[bot] --write`), against the same pull request, `GET /user` returned 403, the publisher resolved to the App's `[bot]` login, the author matched on create, edit and list, and the comment was deleted.

## Markers

Every marker is `<!-- prra:<kind>:v2:<payload>:<sha256> -->`, where the payload is base64url of raw-deflated canonical JSON and the digest is SHA-256 of that JSON. Any version other than `v2` is refused. The reader checks the author first. In a comment from any other account it only counts markers by pattern, to report them as ignored, and decodes none. A publisher comment with more than one marker of a kind is refused before any of them is decoded: a shard is then corrupt, and a status comment is unreadable. The reader checks the limits in the order that avoids allocating before the check:

| Check | State snapshot | Journal shard |
| --- | --- | --- |
| Encoded payload, checked before base64 decoding | 24 KiB | 39,000 characters (the whole shard comment is capped at 40,000) |
| Decompressed bytes, enforced by zlib's `maxOutputLength` while inflating | 256 KiB | 512 KiB |
| Nesting depth, by a linear scan before `JSON.parse` | 16 | 16 |
| Array length, by the same scan | 2,000 | 2,000 |

After inflating, the reader checks the digest, decodes UTF-8 strictly, scans structure, parses, and refuses JSON that is not in canonical form. A compression bomb stops at the decompressed cap. The writer refuses any value the reader would refuse. A status comment is also checked against GitHub's 65,536-character comment limit.

The digest detects corruption. It does not show who wrote the marker, since anyone can compute it.

## Journal shards

A shard is an issue comment with a short warning and one journal marker. Its payload names the repository id, the pull request number, a sequence number, a link to the previous shard (comment id and digest), and the records. The newest shard grows by editing; when the next batch does not fit, a new shard opens, linked to the newest. A sealed shard's digest is fixed by the link in the shard after it, so editing or deleting it breaks the chain at that point.

The snapshot pins a journal cursor: a shard's comment id, how many of its records the snapshot had seen, and a digest of those records. The cursor shard can grow after the snapshot is written, but its first records cannot change. A record key appears once. A repeated key with identical content is a retried write and is kept once; with different content it is corruption.

Only sequence 0 or a reset may start a chain. Without that rule, an edit that rewrote a later shard as a new genesis would hide every shard before it.

## Publication record

After a validated inference response, the run writes a publication record holding the sanitized findings, outcome, coverage, actual usage and the ordered effect plan: inline comments, then the progress comment, then the status snapshot, which is always last. Effect ids derive from the round key, the effect kind and its position, and the validator recomputes them. The record is split into chunks of at most 16,000 characters of base64url text, at most 64 chunks, then a manifest with each chunk's digest and the record's digest is written last, together with the spend settlement. A missing manifest means the record does not exist. A manifest whose chunks are missing or altered cannot authorize publication and stops the run as `recovery-required`.

Keys hash the canonical JSON array of their parts instead of the parts joined with `|`, so a `|` inside a branch name or config digest cannot make two inputs collide. This changes the §7.4 formula's encoding, not its inputs.

## Interruption and replay

A run checks the head and loads authenticated state. It then retires any complete record for another head that still has effects without receipts, since those effects would publish stale conclusions. First it reads the publisher's comments for those effects' markers and records a receipt for each one it finds, such as a status write whose receipt was lost. It marks the round as abandoned only when effects are still missing after that. Then it does the first of these that applies:

1. A complete record for its round with every receipt, and a status snapshot for that round: `duplicate`, nothing written.
2. A complete record with every receipt, but no readable snapshot or one for another round, as after a force-push back to an earlier head: rebuild the status comment from the journal (`status-restored`), with no inference.
3. A complete record with missing receipts: publish the missing effects in order (`published`, `resumed: true`), with no inference. Before each effect it reads; a comment already carrying that effect's marker gets its receipt without a second write. Before each effect it also rechecks the head, and on a new head it records the round as abandoned and publishes nothing more.
4. A reservation with no record and no settlement: `inference-uncertain`. Nothing is spent again until an authorized manual attempt, which has its own attempt id.
5. A reservation with a settlement and no record, or a round a reset acknowledged: `attempt-closed`.
6. Otherwise reserve, infer once, write the chunks, then the manifest with the settlement, then publish. A response that cannot form a valid record, such as a finding with an empty body or a record over 64 chunks, is settled with its known usage and returns `inference-failed`.

| Interrupted | Next run of the same attempt | Inference calls in total |
| --- | --- | --- |
| Before the reservation | Reviews normally | 1 |
| After the reservation, before the request | `inference-uncertain`, reservation held | 0, then 1 after a manual attempt |
| After the response, before the record | `inference-uncertain`, reservation held | 1, then 2 after a manual attempt |
| Provider error with unknown completion | `inference-uncertain`, reservation held | 1 |
| Provider failure with known usage, or a response that cannot form a valid record | `inference-failed`, then `attempt-closed`; usage settled, no review written | 1 |
| After the record, or before or after any effect | Resumes and publishes each effect exactly once | 1 |
| Lost response on an effect or on the manifest write | Reads the marker or the record and resumes | 1 |
| Head moved mid-publication | `abandoned`; later runs of that attempt write nothing | 1, then 1 more on the new head |
| Crash mid-publication, then a push | The first run on the new head records receipts for effects whose markers it finds, abandons the old record, and reviews the new head | 2 |
| Crash after the status write, then a push | The first run on the new head records the status receipt from its marker, so the old round stays complete, and reviews the new head | 2 |

A crash after the reservation but before the request cannot be told apart from a crash during it, so both hold the reservation. That costs at most one reservation and never repeats paid inference silently.

## Deletion and corruption limits

| What happens | What the next run sees |
| --- | --- |
| Status comment deleted | Rebuilt from the journal, whatever `publishInline` and `progressComments` are and whether the round had findings |
| Status marker corrupted | Treated as deleted and rebuilt in a new comment; the unreadable one stays |
| Sealed shard deleted | `recovery-required` (`missing-shard`) |
| Sealed shard edited, even with a valid marker | `recovery-required` (`modified-shard`, or `corrupt-shard` when it no longer decodes or claims to start the chain) |
| The shard the snapshot pins deleted, or the records it has seen changed | `recovery-required` (`cursor-missing` or `cursor-mismatch`) |
| Records written after the last status write removed, or a shard opened after it deleted | Undetected. The snapshot only pins what it has seen. If a reservation is lost this way, the next run pays for inference again |
| Two shards on one parent | `recovery-required` (`forked-journal`) |
| Every shard deleted, threads or progress comments left | `recovery-required` (`missing-publication-record`), from markers on the remaining comments |
| Inline comment edited or deleted | Not state. The round stays complete and nothing is republished |
| Status and newest shard both deleted, inline and progress off | Undetected when the lost shard held only receipts. When it held the record, the reservation without a record gives `inference-uncertain` |
| Every journal shard and the status comment deleted, nothing else left | Undetected. The next run reviews the same head again and pays again |

While `recovery-required`, a run makes no model call and writes nothing. It reports the spend and suppressions from every authentic shard that still decodes, whether or not the chain is intact. A reservation whose settlement was lost counts in full. When every shard is gone the spend record is gone too, and the per-PR budget undercounts. P6.2 should take the authenticated snapshot's spend totals as a floor in that case.

Repository admins and maintainers can edit any comment, and an edit keeps the original author id. Someone with that access can write a valid marker into a bot comment, including a reset record. They are inside the trust boundary, as they can already change the workflow. Other workflows that post as the same account are inside it too.

## Baseline reset

A reset is how a maintainer lets automatic reviews continue after `recovery-required`.

1. Read the status comment and the run log for the reported issues.
2. Post the reset command as a comment on the pull request. The run is given only the command comment's id. It reads that comment from the pull request's comments and refuses an id it does not find there. The comment's author is the authorizer. The run looks up that author's permission by login and refuses unless the account GitHub reports has the author's id and `maintain` or `admin` permission. A `write` user is refused, and so is a login that has passed to another account since the command was posted.
3. The run writes a reset record in a new shard, linked to the newest authentic shard for reference. The record names the authorizer by the command comment's author login and id, the command comment id, the reason, the acknowledged issues, and the comment ids of unreadable shards. It carries forward every verified reservation, settlement and suppression, every round key known from records or from markers on comments, and the reset count.
4. The run rewrites the status comment to say who reset the baseline and why, with no current round and the carried spend.

Readers stop at the newest reset, so history before it is acknowledged and not read. Corruption that appears after the reset stops the run again. A round published before the reset is `attempt-closed`, not reviewed again; a new head reviews normally. The reset never treats missing history as an empty pull request: the status comment says history was not fully recoverable, and charges and dismissals survive.

## Contract changes for P6.1 and P6.2

- Hash keys over the canonical JSON array of their parts.
- Pin the snapshot's journal cursor as comment id, seen record count and a digest of those records.
- Refuse a shard with no previous link unless it is sequence 0 or starts with a reset record.
- Write publication chunks first and the manifest with the settlement last.
- Check a comment's author before reading its markers. Count markers in other accounts' comments without decoding them, and refuse a publisher comment with more than one marker of a kind without decoding any.
- Before abandoning a record for another head, record receipts for effects whose markers are on the publisher's comments.
- Return `duplicate` only when the snapshot is for the same round; otherwise rebuild the status comment.
- Take a reset's authorizer from the command comment's author id, and check that the account whose permission was read has that id.
- Refuse an account payload without a positive id, a login and a type when resolving the publisher or checking permission.
- Carry the acknowledged unreadable shard ids and the known round keys in the reset record.
- Validate every journal record type against its schema. The spike checks record envelopes and the publication record, and trusts the rest of each authenticated record's content.
- Not covered by the spike: thread follow-up effects (they use the same read-then-write receipts as inline comments), compaction, persisting the findings of an abandoned record, and naming the interrupted head in the status comment after an abandonment.
