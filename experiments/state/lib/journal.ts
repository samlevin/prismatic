// Journal shards (§7.1): bot-owned PR comments holding append-only records.
//
// Each shard links to the one before it by comment id and digest, so editing
// or deleting a sealed shard breaks the chain where it happened. The newest
// shard can still grow; the snapshot pins how many of its records it has seen
// and their digest. A reader accepts only shards whose author id is the
// expected publisher and whose repository and pull request match. A baseline
// reset starts a new chain segment; history before it is acknowledged, not
// read.
import { canonicalJson } from '../../../src/shared/canonical.ts';
import { sha256 } from '../../../src/shared/digest.ts';
import type { Comment, GitHubPort } from './github.ts';
import { encodeMarker, findMarkers, maxCommentChars } from './marker.ts';
import { isAuthentic, requireAuthentic } from './publisher.ts';
import type { ExpectedPublisher } from './publisher.ts';

export type RecordType =
  | 'reservation'
  | 'settlement'
  | 'publication-chunk'
  | 'publication-manifest'
  | 'receipt'
  | 'abandoned'
  | 'suppression'
  | 'reset';

export interface JournalRecord {
  readonly key: string;
  readonly type: RecordType;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface PrIdentity {
  readonly repoId: number;
  readonly prNumber: number;
}

export interface ShardLink {
  readonly commentId: number;
  readonly digest: string;
}

export interface Shard {
  readonly commentId: number;
  readonly seq: number;
  readonly prev: ShardLink | null;
  readonly records: readonly JournalRecord[];
  readonly digest: string;
}

// What a snapshot pins: a shard on the chain and a digest of the records it
// had seen there.
export interface JournalCursor {
  readonly commentId: number;
  readonly recordCount: number;
  readonly prefixDigest: string;
}

export type JournalIssue =
  | 'corrupt-shard'
  | 'missing-shard'
  | 'modified-shard'
  | 'forked-journal'
  | 'conflicting-record'
  | 'cursor-missing'
  | 'cursor-mismatch';

export interface JournalView {
  // The verified chain, oldest first, from the latest reset (or genesis).
  readonly chain: readonly Shard[];
  // Every authentic, decodable shard, verified or not, oldest first. On a
  // broken chain this is what the protocol keeps charges and suppressions
  // from.
  readonly authentic: readonly Shard[];
  readonly records: readonly JournalRecord[];
  readonly issues: readonly JournalIssue[];
  // Authentic comments whose journal marker could not be read.
  readonly corrupt: readonly number[];
  // Comments that carried a journal marker but are not the publisher's.
  readonly ignored: number;
}

const header =
  'Prismatic machine journal. Prismatic keeps its review state here; editing or deleting this comment can stop automatic reviews on this pull request until a maintainer resets the baseline.';

const recordTypes: readonly string[] = [
  'reservation',
  'settlement',
  'publication-chunk',
  'publication-manifest',
  'receipt',
  'abandoned',
  'suppression',
  'reset',
];

export function shardBody(
  identity: PrIdentity,
  seq: number,
  prev: ShardLink | null,
  records: readonly JournalRecord[],
): { readonly body: string; readonly digest: string } {
  const { marker, digest } = encodeMarker('journal', {
    kind: 'journal-shard',
    repoId: identity.repoId,
    prNumber: identity.prNumber,
    seq,
    prev,
    records,
  });
  const body = `${header}\n\n${marker}`;
  if (body.length > 40_000 || body.length > maxCommentChars) {
    throw new RangeError('The journal shard is over 40,000 characters.');
  }
  return { body, digest };
}

export function prefixDigest(records: readonly JournalRecord[]): string {
  return sha256(canonicalJson(records));
}

export function cursorFor(shard: Shard): JournalCursor {
  return {
    commentId: shard.commentId,
    recordCount: shard.records.length,
    prefixDigest: prefixDigest(shard.records),
  };
}

export function readJournal(
  comments: readonly Comment[],
  publisher: ExpectedPublisher,
  identity: PrIdentity,
  cursor?: JournalCursor,
): JournalView {
  const issues = new Set<JournalIssue>();
  const authentic: Shard[] = [];
  const corrupt: number[] = [];
  let ignored = 0;
  for (const comment of comments) {
    const [decoded, ...extra] = findMarkers(comment.body, 'journal');
    if (decoded === undefined) continue;
    if (!isAuthentic(comment, publisher)) {
      ignored += 1;
      continue;
    }
    const shard =
      decoded.ok && extra.length === 0
        ? toShard(comment.id, decoded.value, decoded.digest, identity)
        : undefined;
    if (shard === undefined) corrupt.push(comment.id);
    else authentic.push(shard);
  }
  authentic.sort((a, b) => a.seq - b.seq);
  const chain = walkChain(authentic, issues);
  // A reset acknowledges the unreadable shards that existed when it ran.
  const reset = chain[0]?.records[0];
  const acknowledged =
    reset?.type === 'reset' && Array.isArray(reset.data.corruptCommentIds)
      ? (reset.data.corruptCommentIds as unknown[])
      : [];
  if (corrupt.some((id) => !acknowledged.includes(id))) {
    issues.add('corrupt-shard');
  }
  if (cursor !== undefined) checkCursor(chain, cursor, issues);
  const records = collect(chain, issues);
  return { chain, authentic, records, issues: [...issues], corrupt, ignored };
}

function toShard(
  commentId: number,
  value: unknown,
  digest: string,
  identity: PrIdentity,
): Shard | undefined {
  const shard = value as Record<string, unknown>;
  if (
    shard.kind !== 'journal-shard' ||
    shard.repoId !== identity.repoId ||
    shard.prNumber !== identity.prNumber ||
    !Number.isSafeInteger(shard.seq) ||
    (shard.seq as number) < 0 ||
    !isLink(shard.prev) ||
    !Array.isArray(shard.records) ||
    !shard.records.every(isRecord)
  ) {
    return undefined;
  }
  // Only genesis or a reset may start a chain; anything else that claims to
  // would hide every shard before it.
  if (
    shard.prev === null &&
    shard.seq !== 0 &&
    (shard.records[0] as JournalRecord | undefined)?.type !== 'reset'
  ) {
    return undefined;
  }
  return {
    commentId,
    seq: shard.seq as number,
    prev: shard.prev,
    records: shard.records,
    digest,
  };
}

// Walks back from the newest shard to genesis or the latest reset. Any shard
// left over that is newer than where the walk stopped means a fork.
function walkChain(
  shards: readonly Shard[],
  issues: Set<JournalIssue>,
): readonly Shard[] {
  const byId = new Map(shards.map((shard) => [shard.commentId, shard]));
  const chain: Shard[] = [];
  let shard = shards.at(-1);
  while (shard !== undefined) {
    chain.unshift(shard);
    if (shard.records[0]?.type === 'reset' || shard.prev === null) break;
    const prev = byId.get(shard.prev.commentId);
    if (prev === undefined) {
      issues.add('missing-shard');
      break;
    }
    if (prev.digest !== shard.prev.digest || prev.seq !== shard.seq - 1) {
      issues.add('modified-shard');
      break;
    }
    shard = prev;
  }
  const floor = chain[0]?.seq ?? 0;
  const onChain = new Set(chain);
  if (shards.some((item) => item.seq >= floor && !onChain.has(item))) {
    issues.add('forked-journal');
  }
  return chain;
}

function checkCursor(
  chain: readonly Shard[],
  cursor: JournalCursor,
  issues: Set<JournalIssue>,
): void {
  const shard = chain.find((item) => item.commentId === cursor.commentId);
  if (shard === undefined) {
    issues.add('cursor-missing');
    return;
  }
  const seen = shard.records.slice(0, cursor.recordCount);
  if (
    seen.length !== cursor.recordCount ||
    prefixDigest(seen) !== cursor.prefixDigest
  ) {
    issues.add('cursor-mismatch');
  }
}

// Records in chain order. A repeated key with identical content is a retry
// and is kept once; with different content it is corruption.
function collect(
  chain: readonly Shard[],
  issues: Set<JournalIssue>,
): readonly JournalRecord[] {
  return dedupe(
    chain.flatMap((shard) => shard.records),
    issues,
  );
}

export function dedupe(
  records: readonly JournalRecord[],
  issues?: Set<JournalIssue>,
): readonly JournalRecord[] {
  const seen = new Map<string, string>();
  const kept: JournalRecord[] = [];
  for (const record of records) {
    const text = canonicalJson(record);
    const earlier = seen.get(record.key);
    if (earlier === undefined) {
      seen.set(record.key, text);
      kept.push(record);
    } else if (earlier !== text) {
      issues?.add('conflicting-record');
    }
  }
  return kept;
}

function isLink(value: unknown): value is ShardLink | null {
  if (value === null) return true;
  const link = value as Record<string, unknown> | undefined;
  return (
    typeof link === 'object' &&
    Number.isSafeInteger(link.commentId) &&
    typeof link.digest === 'string'
  );
}

function isRecord(value: unknown): value is JournalRecord {
  const record = value as Record<string, unknown> | null;
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.key === 'string' &&
    record.key.length > 0 &&
    record.key.length <= 200 &&
    recordTypes.includes(record.type as string) &&
    typeof record.data === 'object' &&
    record.data !== null &&
    !Array.isArray(record.data)
  );
}

// Appends records as the publisher. Grows the newest shard while it fits,
// then opens the next one linked to it. A write whose response names another
// author stops the run.
export class JournalWriter {
  readonly #github: GitHubPort;
  readonly #publisher: ExpectedPublisher;
  readonly #identity: PrIdentity;
  #tip: Shard | undefined;
  readonly #keys = new Map<string, string>();
  readonly #records: JournalRecord[] = [];

  constructor(
    github: GitHubPort,
    publisher: ExpectedPublisher,
    identity: PrIdentity,
    view: Pick<JournalView, 'chain' | 'records'>,
  ) {
    this.#github = github;
    this.#publisher = publisher;
    this.#identity = identity;
    this.#tip = view.chain.at(-1);
    for (const record of view.records) this.#remember(record);
  }

  get tip(): Shard | undefined {
    return this.#tip;
  }

  // Every record this writer has loaded or written, in order.
  get records(): readonly JournalRecord[] {
    return this.#records;
  }

  async append(records: readonly JournalRecord[]): Promise<void> {
    const fresh = records.filter((record) => {
      const earlier = this.#keys.get(record.key);
      if (earlier === undefined) return true;
      if (earlier !== canonicalJson(record)) {
        throw new RangeError(
          `Journal key ${record.key} already holds a different record.`,
        );
      }
      return false;
    });
    if (fresh.length === 0) return;
    const tip = this.#tip;
    const grown = tip === undefined ? undefined : this.#tryGrow(tip, fresh);
    if (tip !== undefined && grown !== undefined) {
      const comment = await this.#github.updateComment(
        'issue',
        tip.commentId,
        grown.body,
      );
      this.#accept(
        comment,
        tip.seq,
        tip.prev,
        [...tip.records, ...fresh],
        grown.digest,
        fresh,
      );
    } else {
      await this.#open(fresh, tip);
    }
  }

  // A reset always opens a new shard, linked to the newest authentic shard
  // for the record, and is the first record of it.
  async reset(record: JournalRecord, after: Shard | undefined): Promise<void> {
    if (record.type !== 'reset') throw new RangeError('Not a reset record.');
    this.#tip = after;
    await this.#open([record], after);
  }

  #tryGrow(
    tip: Shard,
    fresh: readonly JournalRecord[],
  ): { readonly body: string; readonly digest: string } | undefined {
    try {
      return shardBody(this.#identity, tip.seq, tip.prev, [
        ...tip.records,
        ...fresh,
      ]);
    } catch {
      return undefined;
    }
  }

  async #open(
    fresh: readonly JournalRecord[],
    after: Shard | undefined,
  ): Promise<void> {
    const seq = after === undefined ? 0 : after.seq + 1;
    const prev =
      after === undefined
        ? null
        : { commentId: after.commentId, digest: after.digest };
    const { body, digest } = shardBody(this.#identity, seq, prev, fresh);
    const comment = await this.#github.createComment('issue', body);
    this.#accept(comment, seq, prev, fresh, digest, fresh);
  }

  #accept(
    comment: Comment,
    seq: number,
    prev: ShardLink | null,
    records: readonly JournalRecord[],
    digest: string,
    fresh: readonly JournalRecord[],
  ): void {
    requireAuthentic(comment, this.#publisher);
    this.#tip = { commentId: comment.id, seq, prev, records, digest };
    for (const record of fresh) this.#remember(record);
  }

  #remember(record: JournalRecord): void {
    this.#keys.set(record.key, canonicalJson(record));
    this.#records.push(record);
  }
}
