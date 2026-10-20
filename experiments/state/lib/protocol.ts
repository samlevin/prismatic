// The publication protocol (§7.4) with its recovery rules (§7.1), run against
// the GitHub port. One call is one run for one attempt:
//
//   load authenticated state -> resume a validated record without inference
//   -> or refuse when an earlier inference is uncertain
//   -> or reserve, infer once, persist the record, publish each effect.
//
// `interrupt` is called at every point where a real run can die, so a test
// can stop the run there and start the next one against the same comments.
import { canonicalJson } from '../../../src/shared/canonical.ts';
import { sha256 } from '../../../src/shared/digest.ts';
import type { Anchor, Comment, CommentChannel, GitHubPort } from './github.ts';
import { cursorFor, JournalWriter, readJournal } from './journal.ts';
import type {
  JournalCursor,
  JournalRecord,
  JournalView,
  PrIdentity,
  Shard,
} from './journal.ts';
import { attemptId, reviewKey, roundKey } from './keys.ts';
import type { ReviewKeyInput } from './keys.ts';
import { Ledger } from './ledger.ts';
import type { Spend } from './ledger.ts';
import {
  countMarkers,
  decodeMarker,
  effectMarker,
  encodeMarker,
  findEffectMarkers,
  maxCommentChars,
} from './marker.ts';
import { isAuthentic, requireAuthentic } from './publisher.ts';
import type { ExpectedPublisher } from './publisher.ts';
import { partitionRecord, planEffects } from './record.ts';
import type {
  Finding,
  Outcome,
  PlannedEffect,
  PublicationConfig,
  PublicationRecord,
  Usage,
} from './record.ts';

export interface FindingDraft {
  readonly title: string;
  readonly body: string;
  readonly anchor: Anchor | null;
}

export type InferenceResult =
  | {
      readonly kind: 'completed';
      readonly outcome: Outcome;
      readonly findings: readonly FindingDraft[];
      readonly coverage: {
        readonly reviewed: number;
        readonly unreviewed: number;
      };
      readonly usage: Usage;
    }
  // A definitive provider failure with known usage.
  | { readonly kind: 'failed'; readonly usage: Usage };

// A throw means the provider's completion is unknown.
export interface ModelPort {
  infer(request: {
    readonly roundKey: string;
    readonly headSha: string;
  }): Promise<InferenceResult>;
}

export interface RunContext {
  readonly github: GitHubPort;
  readonly publisher: ExpectedPublisher;
  readonly identity: PrIdentity;
  readonly config: PublicationConfig;
  readonly model: ModelPort;
  readonly interrupt?: (point: string) => void;
}

export interface AttemptInput {
  readonly review: ReviewKeyInput;
  readonly manual?: {
    readonly kind: 'command' | 'dispatch';
    readonly id: number;
  };
  readonly reservationMicroUsd: number;
}

export type RecoveryIssue =
  | JournalView['issues'][number]
  | 'incomplete-publication-record'
  | 'missing-publication-record';

export type RunResult =
  | {
      readonly kind: 'published';
      readonly resumed: boolean;
      readonly roundKey: string;
    }
  | { readonly kind: 'duplicate'; readonly roundKey: string }
  | { readonly kind: 'status-restored'; readonly roundKey: string }
  | { readonly kind: 'inference-uncertain'; readonly attemptId: string }
  | { readonly kind: 'inference-failed'; readonly attemptId: string }
  // The attempt already spent and has no record to resume: it failed with
  // known usage, or a reset acknowledged its round. Automatic replay never
  // spends again; a new head or an authorized manual attempt does.
  | { readonly kind: 'attempt-closed'; readonly attemptId: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'abandoned'; readonly roundKey: string }
  | RecoveryRequired;

// Automatic inference and publication stop here until a maintainer resets
// the baseline. Spend and suppressions are what every authentic, decodable
// shard still shows, so a broken chain never drops a charge.
export interface RecoveryRequired {
  readonly kind: 'recovery-required';
  readonly issues: readonly RecoveryIssue[];
  readonly spend: Spend;
  readonly suppressions: readonly string[];
}

export interface Snapshot {
  readonly kind: 'snapshot';
  readonly repoId: number;
  readonly prNumber: number;
  readonly generation: number;
  // Shown to people. Never used to decide who the publisher is.
  readonly publisherLogin: string;
  readonly journal: JournalCursor;
  readonly round: {
    readonly roundKey: string;
    readonly headSha: string;
    readonly outcome: Outcome;
  } | null;
  readonly openFindingIds: readonly string[];
  readonly spend: Spend;
  readonly resets: number;
}

export interface LoadedState {
  readonly view: JournalView;
  readonly ledger: Ledger;
  readonly issues: readonly RecoveryIssue[];
  readonly snapshot:
    { readonly commentId: number; readonly value: Snapshot } | undefined;
  // Authentic comments only.
  readonly comments: Readonly<Record<CommentChannel, readonly Comment[]>>;
  // Comments with a state or journal marker from any other author.
  readonly ignored: number;
}

export async function loadState(context: RunContext): Promise<LoadedState> {
  const { github, publisher, identity } = context;
  const issueComments = await github.listComments('issue');
  const reviewComments = await github.listComments('review');
  let ignored = 0;
  let snapshot: LoadedState['snapshot'];
  for (const comment of issueComments) {
    if (!isAuthentic(comment, publisher)) {
      if (countMarkers(comment.body, 'state') > 0) ignored += 1;
      continue;
    }
    const decoded = decodeMarker(comment.body, 'state');
    if (decoded === undefined) continue;
    const value = decoded.ok ? toSnapshot(decoded.value, identity) : undefined;
    // An unreadable snapshot is treated as deleted: the journal rebuilds it.
    if (value === undefined) continue;
    if (
      snapshot === undefined ||
      value.generation > snapshot.value.generation
    ) {
      snapshot = { commentId: comment.id, value };
    }
  }
  const view = readJournal(
    issueComments,
    publisher,
    identity,
    snapshot?.value.journal,
  );
  const ledger = new Ledger(view.records);
  const issues: RecoveryIssue[] = [...view.issues];
  for (const key of ledger.manifests.keys()) {
    if (ledger.record(key)?.status === 'incomplete') {
      issues.push('incomplete-publication-record');
      break;
    }
  }
  const comments = {
    issue: issueComments.filter((comment) => isAuthentic(comment, publisher)),
    review: reviewComments.filter((comment) => isAuthentic(comment, publisher)),
  };
  // A marker the publisher wrote for a round the journal does not know means
  // journal records were lost.
  const unknown = [...comments.issue, ...comments.review].some((comment) =>
    findEffectMarkers(comment.body).some(
      (marker) => !ledger.knows(marker.roundKey),
    ),
  );
  if (unknown) issues.push('missing-publication-record');
  return {
    view,
    ledger,
    issues,
    snapshot,
    comments,
    ignored: ignored + view.ignored,
  };
}

function toSnapshot(
  value: unknown,
  identity: PrIdentity,
): Snapshot | undefined {
  const snapshot = value as Partial<Snapshot>;
  const cursor = snapshot.journal as Partial<JournalCursor> | null | undefined;
  return snapshot.kind === 'snapshot' &&
    snapshot.repoId === identity.repoId &&
    snapshot.prNumber === identity.prNumber &&
    Number.isSafeInteger(snapshot.generation) &&
    typeof cursor === 'object' &&
    cursor !== null &&
    Number.isSafeInteger(cursor.commentId) &&
    Number.isSafeInteger(cursor.recordCount) &&
    typeof cursor.prefixDigest === 'string'
    ? (snapshot as Snapshot)
    : undefined;
}

function recoveryRequired(state: LoadedState): RecoveryRequired {
  // Verified as authentic and intact, if not as one chain.
  const ledger = new Ledger(
    state.view.authentic.flatMap((shard) => shard.records),
  );
  return {
    kind: 'recovery-required',
    issues: [...new Set(state.issues)],
    spend: ledger.spend,
    suppressions: [...ledger.suppressions.keys()],
  };
}

export async function runAttempt(
  context: RunContext,
  attempt: AttemptInput,
): Promise<RunResult> {
  const interrupt = context.interrupt ?? (() => undefined);
  if ((await context.github.headSha()) !== attempt.review.headSha) {
    return { kind: 'stale' };
  }
  const state = await loadState(context);
  if (state.issues.length > 0) return recoveryRequired(state);
  const review = reviewKey(attempt.review);
  const attemptKey = attemptId(review, attempt.manual);
  const round = roundKey(review, attemptKey);
  const writer = new JournalWriter(
    context.github,
    context.publisher,
    context.identity,
    state.view,
  );

  // A pending record for another head can never be resumed: its remaining
  // effects would publish stale conclusions. Effects whose markers are already
  // on GitHub get their receipts; the rest are retired.
  for (const key of state.ledger.manifests.keys()) {
    const pending = state.ledger.record(key);
    if (
      pending?.status !== 'complete' ||
      pending.record.headSha === attempt.review.headSha ||
      state.ledger.abandoned.has(key)
    ) {
      continue;
    }
    const missing = new Set(
      pending.record.effects
        .filter((e) => !state.ledger.receipts.has(e.id))
        .map((e) => e.id),
    );
    if (missing.size === 0) continue;
    const receipts = new Map(state.ledger.receipts);
    const landed: JournalRecord[] = [];
    for (const comment of [...state.comments.issue, ...state.comments.review]) {
      for (const marker of findEffectMarkers(comment.body)) {
        if (marker.roundKey !== key || !missing.delete(marker.effectId)) {
          continue;
        }
        receipts.set(marker.effectId, comment.id);
        landed.push(receipt(key, marker.effectId, comment.id));
      }
    }
    await writer.append(landed);
    if (missing.size > 0) await abandon(writer, pending.record, receipts);
  }

  // A validated record resumes without inference.
  const assembled = state.ledger.record(round);
  if (assembled?.status === 'complete') {
    return resume(context, state, writer, assembled.record, interrupt);
  }
  // A reservation with no record and no settlement: the provider may have
  // completed and charged. Only an authorized new attempt may spend again.
  if (state.ledger.reservations.has(attemptKey)) {
    return state.ledger.settlements.has(attemptKey)
      ? { kind: 'attempt-closed', attemptId: attemptKey }
      : { kind: 'inference-uncertain', attemptId: attemptKey };
  }
  if (state.ledger.acknowledged.has(round)) {
    return { kind: 'attempt-closed', attemptId: attemptKey };
  }

  interrupt('before-reservation');
  await writer.append([
    {
      key: `reservation:${attemptKey}`,
      type: 'reservation',
      data: {
        attemptId: attemptKey,
        amountMicroUsd: attempt.reservationMicroUsd,
      },
    },
  ]);
  interrupt('after-reservation');
  let result: InferenceResult;
  try {
    result = await context.model.infer({
      roundKey: round,
      headSha: attempt.review.headSha,
    });
  } catch {
    return { kind: 'inference-uncertain', attemptId: attemptKey };
  }
  interrupt('after-inference-response');
  const settlement: JournalRecord = {
    key: `settlement:${attemptKey}`,
    type: 'settlement',
    data: { attemptId: attemptKey, costMicroUsd: result.usage.costMicroUsd },
  };
  if (result.kind === 'failed') {
    await writer.append([settlement]);
    return { kind: 'inference-failed', attemptId: attemptKey };
  }
  // The ordinal keeps two drafts with the same title and anchor distinct.
  const findings: Finding[] = result.findings.map((draft, index) => ({
    id: sha256(canonicalJson(['finding', index, draft.title, draft.anchor])),
    ...draft,
  }));
  const record: PublicationRecord = {
    kind: 'publication-record',
    reviewKey: review,
    attemptId: attemptKey,
    roundKey: round,
    headSha: attempt.review.headSha,
    outcome: result.outcome,
    findings,
    coverage: result.coverage,
    usage: result.usage,
    effects: planEffects(round, findings, context.config),
  };
  let partitioned: ReturnType<typeof partitionRecord>;
  try {
    partitioned = partitionRecord(record);
  } catch {
    // A response the record cannot hold is a definitive failure with known
    // usage, not an uncertain one.
    await writer.append([settlement]);
    return { kind: 'inference-failed', attemptId: attemptKey };
  }
  const { chunks, manifest } = partitioned;
  // Chunks first, then the manifest with the settlement, so a run that dies
  // between them leaves no record that can authorize publication.
  for (const chunk of chunks) {
    await writer.append([
      {
        key: `chunk:${round}:${chunk.index}`,
        type: 'publication-chunk',
        data: { ...chunk },
      },
    ]);
  }
  await writer.append([
    {
      key: `manifest:${round}`,
      type: 'publication-manifest',
      data: { ...manifest },
    },
    settlement,
  ]);
  interrupt('after-record-persisted');
  return publish(context, state, writer, record, interrupt, false);
}

async function resume(
  context: RunContext,
  state: LoadedState,
  writer: JournalWriter,
  record: PublicationRecord,
  interrupt: (point: string) => void,
): Promise<RunResult> {
  if (state.ledger.abandoned.has(record.roundKey)) {
    return { kind: 'abandoned', roundKey: record.roundKey };
  }
  const done = record.effects.every((effect) =>
    state.ledger.receipts.has(effect.id),
  );
  if (!done) return publish(context, state, writer, record, interrupt, true);
  if (state.snapshot?.value.round?.roundKey === record.roundKey) {
    return { kind: 'duplicate', roundKey: record.roundKey };
  }
  // Every effect happened, but the status snapshot is gone or shows another
  // round, as after a force-push back to this head: rebuild it from the
  // journal. This is not a round effect and spends nothing.
  await writeStatus(context, state, writer, record, '');
  return { kind: 'status-restored', roundKey: record.roundKey };
}

// Publishes each effect that has no receipt, in plan order. Before each one
// the run reads: a marker already on GitHub means an earlier write landed
// and only its receipt is missing.
async function publish(
  context: RunContext,
  state: LoadedState,
  writer: JournalWriter,
  record: PublicationRecord,
  interrupt: (point: string) => void,
  resumed: boolean,
): Promise<RunResult> {
  const receipts = new Map(state.ledger.receipts);
  for (const effect of record.effects) {
    if (receipts.has(effect.id)) continue;
    if ((await context.github.headSha()) !== record.headSha) {
      await abandon(writer, record, receipts);
      return { kind: 'abandoned', roundKey: record.roundKey };
    }
    const label = `${effect.kind}:${effect.ordinal}`;
    const marker = effectMarker(record.roundKey, effect.id);
    const channel: CommentChannel =
      effect.kind === 'inline' ? 'review' : 'issue';
    const listed = await context.github.listComments(channel);
    let comment = listed.find(
      (item) =>
        isAuthentic(item, context.publisher) && item.body.includes(marker),
    );
    if (comment === undefined) {
      interrupt(`before-effect:${label}`);
      comment = await sendEffect(
        context,
        state,
        writer,
        record,
        effect,
        marker,
      );
      interrupt(`after-effect:${label}`);
    }
    await writer.append([receipt(record.roundKey, effect.id, comment.id)]);
    receipts.set(effect.id, comment.id);
  }
  return { kind: 'published', resumed, roundKey: record.roundKey };
}

function receipt(
  roundKey: string,
  effectId: string,
  commentId: number,
): JournalRecord {
  return {
    key: `receipt:${effectId}`,
    type: 'receipt',
    data: { effectId, roundKey, commentId },
  };
}

async function sendEffect(
  context: RunContext,
  state: LoadedState,
  writer: JournalWriter,
  record: PublicationRecord,
  effect: PlannedEffect,
  marker: string,
): Promise<Comment> {
  const { github, publisher } = context;
  if (effect.kind === 'status') {
    return writeStatus(context, state, writer, record, marker);
  }
  if (effect.kind === 'progress') {
    const body = `Review of \`${record.headSha.slice(0, 7)}\`: ${record.findings.length} finding(s).\n\n${marker}`;
    return requireAuthentic(
      await github.createComment('issue', body),
      publisher,
    );
  }
  const finding = record.findings.find(
    (item) => item.id === effect.findingId,
  ) as Finding;
  const body = `**${finding.title}**\n\n${finding.body}\n\n${marker}`;
  return requireAuthentic(
    await github.createComment('review', body, finding.anchor as Anchor),
    publisher,
  );
}

async function abandon(
  writer: JournalWriter,
  record: PublicationRecord,
  receipts: ReadonlyMap<string, number>,
): Promise<void> {
  await writer.append([
    {
      key: `abandoned:${record.roundKey}`,
      type: 'abandoned',
      data: {
        roundKey: record.roundKey,
        observed: record.effects
          .filter((e) => receipts.has(e.id))
          .map((e) => e.id),
        retired: record.effects
          .filter((e) => !receipts.has(e.id))
          .map((e) => e.id),
      },
    },
  ]);
}

// Creates or edits the one status comment: a human summary, the snapshot
// marker, and (for a round's status effect) the effect marker.
async function writeStatus(
  context: RunContext,
  state: LoadedState,
  writer: JournalWriter,
  record: PublicationRecord | null,
  marker: string,
  note = '',
): Promise<Comment> {
  const { github, publisher, identity } = context;
  const tip = writer.tip as Shard;
  const ledger = new Ledger(writer.records);
  const suppressed = ledger.suppressions;
  const snapshot: Snapshot = {
    kind: 'snapshot',
    repoId: identity.repoId,
    prNumber: identity.prNumber,
    generation: (state.snapshot?.value.generation ?? 0) + 1,
    publisherLogin: publisher.login,
    journal: cursorFor(tip),
    round:
      record === null
        ? null
        : {
            roundKey: record.roundKey,
            headSha: record.headSha,
            outcome: record.outcome,
          },
    openFindingIds:
      record === null
        ? []
        : record.findings.map((f) => f.id).filter((id) => !suppressed.has(id)),
    spend: ledger.spend,
    resets: ledger.resets,
  };
  const summary =
    record === null
      ? 'Prismatic has no completed review on this pull request since the reset.'
      : `Prismatic review: ${record.outcome}. Head \`${record.headSha.slice(0, 7)}\`, ${snapshot.openFindingIds.length} open finding(s).`;
  const body = [summary, note, encodeMarker('state', snapshot).marker, marker]
    .filter((part) => part !== '')
    .join('\n\n');
  if (body.length > maxCommentChars) {
    throw new RangeError('The status comment is over GitHub’s limit.');
  }
  const existing = state.snapshot?.commentId;
  const comment =
    existing === undefined
      ? await github.createComment('issue', body)
      : await github.updateComment('issue', existing, body);
  return requireAuthentic(comment, publisher);
}

export interface ResetRequest {
  // The maintainer's reset command, an issue comment on this pull request.
  // Its author authorizes the reset.
  readonly commandCommentId: number;
  readonly reason: string;
}

export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetRefusedError';
  }
}

// The documented baseline reset. Only a maintainer or admin may run it. It
// writes a visible reset record that starts a new chain segment and carries
// every verified charge, suppression and known round key forward, then
// rewrites the status comment to say so. It never treats missing history as
// an empty pull request.
export async function resetBaseline(
  context: RunContext,
  request: ResetRequest,
): Promise<void> {
  const command = (await context.github.listComments('issue')).find(
    (comment) => comment.id === request.commandCommentId,
  );
  if (command === undefined) {
    throw new ResetRefusedError(
      'The reset command is not a comment on this pull request.',
    );
  }
  const authorizer = command.author;
  const { account, permission } = await context.github.permissionOf(
    authorizer.login,
  );
  // The login may have changed hands since the command was posted.
  if (
    account.id !== authorizer.id ||
    (permission !== 'admin' && permission !== 'maintain')
  ) {
    throw new ResetRefusedError(
      'A baseline reset needs maintain or admin permission.',
    );
  }
  const state = await loadState(context);
  const verified = new Ledger(
    state.view.authentic.flatMap((shard) => shard.records),
  );
  const observed = [...state.comments.issue, ...state.comments.review].flatMap(
    (comment) =>
      findEffectMarkers(comment.body).map((marker) => marker.roundKey),
  );
  const carried = verified.carry();
  const reset: JournalRecord = {
    key: `reset:${request.commandCommentId}`,
    type: 'reset',
    data: {
      authorizedBy: { login: authorizer.login, id: authorizer.id },
      commandCommentId: request.commandCommentId,
      reason: request.reason.slice(0, 500),
      acknowledged: [...new Set(state.issues)],
      corruptCommentIds: state.view.corrupt,
      carried: {
        ...carried,
        roundKeys: [...new Set([...carried.roundKeys, ...observed])],
      },
    },
  };
  const writer = new JournalWriter(
    context.github,
    context.publisher,
    context.identity,
    {
      chain: [],
      records: [],
    },
  );
  await writer.reset(reset, state.view.authentic.at(-1));
  await writeStatus(
    context,
    state,
    writer,
    null,
    '',
    `Baseline reset by @${authorizer.login}: ${reset.data.reason as string}. History before the reset was not fully recoverable and is not used to decide later rounds; recorded charges and dismissals were kept.`,
  );
}
