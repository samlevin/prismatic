// The validated publication record (§7.4) and its bounded chunks.
//
// A record holds everything a later run needs to finish publishing without
// inference: the sanitized findings, outcome, coverage, usage and the ordered
// effect plan. A large record is split into chunks plus a manifest that is
// written last. A missing manifest means the record was never persisted; a
// manifest whose chunks are missing or altered cannot authorize publication.
import { canonicalJson } from '../../../src/shared/canonical.ts';
import { sha256 } from '../../../src/shared/digest.ts';
import type { Anchor } from './github.ts';
import { effectId } from './keys.ts';

export type Outcome = 'approve' | 'revise' | 'rework';
export type EffectKind = 'inline' | 'progress' | 'status';
export type ProgressComments = 'changes-only' | 'always' | 'never';

export interface PublicationConfig {
  readonly publishInline: boolean;
  readonly progressComments: ProgressComments;
}

export interface Finding {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly anchor: Anchor | null;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
}

export interface PlannedEffect {
  readonly id: string;
  readonly kind: EffectKind;
  readonly ordinal: number;
  readonly findingId: string | null;
}

export interface PublicationRecord {
  readonly kind: 'publication-record';
  readonly reviewKey: string;
  readonly attemptId: string;
  readonly roundKey: string;
  readonly headSha: string;
  readonly outcome: Outcome;
  readonly findings: readonly Finding[];
  readonly coverage: { readonly reviewed: number; readonly unreviewed: number };
  readonly usage: Usage;
  readonly effects: readonly PlannedEffect[];
}

export const recordLimits = {
  maxFindings: 200,
  maxTitleChars: 200,
  maxBodyChars: 4_000,
  maxChunkChars: 16_000,
  maxChunks: 64,
};

// Inline comments first, then the progress comment, then the status
// snapshot, which is always last and always present.
export function planEffects(
  round: string,
  findings: readonly Finding[],
  config: PublicationConfig,
): readonly PlannedEffect[] {
  const effects: PlannedEffect[] = [];
  const add = (kind: EffectKind, findingId: string | null): void => {
    const ordinal = effects.filter((effect) => effect.kind === kind).length;
    effects.push({
      id: effectId(round, kind, ordinal),
      kind,
      ordinal,
      findingId,
    });
  };
  if (config.publishInline) {
    for (const finding of findings) {
      if (finding.anchor !== null) add('inline', finding.id);
    }
  }
  if (
    config.progressComments === 'always' ||
    (config.progressComments === 'changes-only' && findings.length > 0)
  ) {
    add('progress', null);
  }
  add('status', null);
  return effects;
}

const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const outcomes: readonly string[] = ['approve', 'revise', 'rework'];
const kindOrder: readonly EffectKind[] = ['inline', 'progress', 'status'];

// Returns the reason a value is not a valid record, or undefined.
export function recordProblem(value: unknown): string | undefined {
  if (!isObject(value) || value.kind !== 'publication-record') return 'kind';
  for (const key of ['reviewKey', 'attemptId', 'roundKey'] as const) {
    if (!matches(value[key], digest)) return key;
  }
  if (!matches(value.headSha, sha)) return 'headSha';
  if (!outcomes.includes(value.outcome as string)) return 'outcome';
  if (!isCounts(value.coverage, ['reviewed', 'unreviewed'])) return 'coverage';
  if (!isCounts(value.usage, ['inputTokens', 'outputTokens', 'costMicroUsd'])) {
    return 'usage';
  }
  const findings = value.findings;
  if (!Array.isArray(findings) || findings.length > recordLimits.maxFindings) {
    return 'findings';
  }
  const ids = new Set<string>();
  for (const finding of findings) {
    const problem = findingProblem(finding);
    if (problem !== undefined) return problem;
    if (ids.has((finding as Finding).id)) return 'duplicate finding';
    ids.add((finding as Finding).id);
  }
  return effectsProblem(value.effects, value.roundKey as string, findings);
}

function findingProblem(finding: unknown): string | undefined {
  if (!isObject(finding) || !matches(finding.id, digest)) return 'finding id';
  if (!isText(finding.title, recordLimits.maxTitleChars))
    return 'finding title';
  if (!isText(finding.body, recordLimits.maxBodyChars)) return 'finding body';
  const anchor = finding.anchor;
  if (anchor === null) return undefined;
  return isObject(anchor) &&
    isText(anchor.path, 4_096) &&
    Number.isSafeInteger(anchor.line) &&
    (anchor.line as number) > 0
    ? undefined
    : 'finding anchor';
}

// Ids must be the ones the round key derives, kinds in publication order,
// and exactly one status effect, last.
function effectsProblem(
  effects: unknown,
  round: string,
  findings: readonly Finding[],
): string | undefined {
  if (!Array.isArray(effects) || effects.length === 0) return 'effects';
  const counts = new Map<string, number>();
  let rank = 0;
  for (const effect of effects as unknown[]) {
    if (!isObject(effect)) return 'effect';
    const kind = effect.kind as EffectKind;
    const kindRank = kindOrder.indexOf(kind);
    if (kindRank < rank || kindRank < 0) return 'effect order';
    rank = kindRank;
    const ordinal = counts.get(kind) ?? 0;
    counts.set(kind, ordinal + 1);
    if (
      effect.ordinal !== ordinal ||
      effect.id !== effectId(round, kind, ordinal)
    ) {
      return 'effect id';
    }
    const finding = findings.find((item) => item.id === effect.findingId);
    const wantsFinding = kind === 'inline';
    if (wantsFinding ? finding?.anchor == null : effect.findingId !== null) {
      return 'effect finding';
    }
  }
  return counts.get('status') === 1 &&
    (effects as PlannedEffect[]).at(-1)?.kind === 'status'
    ? undefined
    : 'status effect';
}

export interface JournalChunk {
  readonly roundKey: string;
  readonly index: number;
  readonly data: string;
}

export interface RecordManifest {
  readonly roundKey: string;
  readonly chunkDigests: readonly string[];
  readonly recordDigest: string;
}

// Base64url of the canonical UTF-8, so a cut never splits a character.
export function partitionRecord(
  record: PublicationRecord,
  maxChunkChars: number = recordLimits.maxChunkChars,
): {
  readonly chunks: readonly JournalChunk[];
  readonly manifest: RecordManifest;
} {
  const problem = recordProblem(record);
  if (problem !== undefined) {
    throw new RangeError(`The publication record is invalid: ${problem}.`);
  }
  const text = canonicalJson(record);
  const encoded = Buffer.from(text, 'utf8').toString('base64url');
  const chunks: JournalChunk[] = [];
  for (let start = 0; start < encoded.length; start += maxChunkChars) {
    chunks.push({
      roundKey: record.roundKey,
      index: chunks.length,
      data: encoded.slice(start, start + maxChunkChars),
    });
  }
  if (chunks.length > recordLimits.maxChunks) {
    throw new RangeError('The publication record needs too many chunks.');
  }
  return {
    chunks,
    manifest: {
      roundKey: record.roundKey,
      chunkDigests: chunks.map((chunk) => sha256(chunk.data)),
      recordDigest: sha256(text),
    },
  };
}

export type Assembled =
  | { readonly status: 'complete'; readonly record: PublicationRecord }
  | { readonly status: 'incomplete'; readonly reason: string };

export function assembleRecord(
  manifest: RecordManifest,
  chunks: readonly JournalChunk[],
): Assembled {
  if (manifest.chunkDigests.length > recordLimits.maxChunks) {
    return { status: 'incomplete', reason: 'too many chunks' };
  }
  const parts: string[] = [];
  for (const [index, expected] of manifest.chunkDigests.entries()) {
    const chunk = chunks.find(
      (item) => item.roundKey === manifest.roundKey && item.index === index,
    );
    if (chunk === undefined) {
      return { status: 'incomplete', reason: `chunk ${index} is missing` };
    }
    if (sha256(chunk.data) !== expected) {
      return { status: 'incomplete', reason: `chunk ${index} does not match` };
    }
    parts.push(chunk.data);
  }
  const text = Buffer.from(parts.join(''), 'base64url').toString('utf8');
  if (sha256(text) !== manifest.recordDigest) {
    return { status: 'incomplete', reason: 'record digest does not match' };
  }
  const record: unknown = JSON.parse(text);
  const problem = recordProblem(record);
  if (problem !== undefined) {
    return { status: 'incomplete', reason: `record is invalid: ${problem}` };
  }
  const valid = record as PublicationRecord;
  return valid.roundKey === manifest.roundKey
    ? { status: 'complete', record: valid }
    : { status: 'incomplete', reason: 'record names another round' };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value);
}

function isText(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isCounts(value: unknown, keys: readonly string[]): boolean {
  return (
    isObject(value) &&
    keys.every(
      (key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0,
    )
  );
}
