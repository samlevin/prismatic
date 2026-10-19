import { describe, expect, test } from 'vitest';
import { sha256 } from '../../../src/shared/digest.ts';
import { attemptId, reviewKey, roundKey } from './keys.ts';
import {
  assembleRecord,
  partitionRecord,
  planEffects,
  recordLimits,
  recordProblem,
} from './record.ts';
import type { Finding, PublicationRecord } from './record.ts';
import { allOff, allOn, headA, review, usage } from './testing.ts';

const key = reviewKey(review());
const attempt = attemptId(key);
const round = roundKey(key, attempt);

function finding(index: number, anchored = true): Finding {
  return {
    id: sha256(`finding ${index}`),
    title: `Finding ${index} é`,
    body: `Body ${index} 😀`,
    anchor: anchored ? { path: `src/f${index}.ts`, line: index + 1 } : null,
  };
}

function record(
  findings: readonly Finding[] = [finding(0), finding(1)],
): PublicationRecord {
  return {
    kind: 'publication-record',
    reviewKey: key,
    attemptId: attempt,
    roundKey: round,
    headSha: headA,
    outcome: findings.length === 0 ? 'approve' : 'revise',
    findings,
    coverage: { reviewed: 2, unreviewed: 1 },
    usage,
    effects: planEffects(round, findings, allOn),
  };
}

describe('planEffects', () => {
  test('orders inline comments, then progress, then status', () => {
    const effects = planEffects(
      round,
      [finding(0), finding(1, false), finding(2)],
      allOn,
    );
    expect(effects.map((effect) => `${effect.kind}:${effect.ordinal}`)).toEqual(
      ['inline:0', 'inline:1', 'progress:0', 'status:0'],
    );
    expect(effects[1]?.findingId).toBe(finding(2).id);
  });

  test('keeps only the status effect with inline and progress off', () => {
    expect(planEffects(round, [finding(0)], allOff).map((e) => e.kind)).toEqual(
      ['status'],
    );
  });

  test('posts a changes-only progress comment only when there are findings', () => {
    const config = {
      publishInline: false,
      progressComments: 'changes-only',
    } as const;
    expect(planEffects(round, [], config).map((e) => e.kind)).toEqual([
      'status',
    ]);
    expect(planEffects(round, [finding(0)], config).map((e) => e.kind)).toEqual(
      ['progress', 'status'],
    );
    expect(planEffects(round, [], allOn).map((e) => e.kind)).toEqual([
      'progress',
      'status',
    ]);
  });
});

describe('recordProblem', () => {
  test('accepts a complete record, with or without findings', () => {
    expect(recordProblem(record())).toBeUndefined();
    expect(recordProblem(record([]))).toBeUndefined();
  });

  const valid = record();
  const status = valid.effects.at(-1);
  const cases: [string, unknown][] = [
    ['kind', null],
    ['kind', { ...valid, kind: 'other' }],
    ['reviewKey', { ...valid, reviewKey: 'x' }],
    ['headSha', { ...valid, headSha: 'HEAD' }],
    ['outcome', { ...valid, outcome: 'merge' }],
    ['coverage', { ...valid, coverage: { reviewed: -1, unreviewed: 0 } }],
    ['usage', { ...valid, usage: { ...usage, costMicroUsd: 0.5 } }],
    ['findings', { ...valid, findings: {} }],
    [
      'findings',
      {
        ...valid,
        findings: Array.from({ length: recordLimits.maxFindings + 1 }, (_, i) =>
          finding(i),
        ),
      },
    ],
    ['finding id', { ...valid, findings: [{ ...finding(0), id: 'x' }] }],
    ['finding title', { ...valid, findings: [{ ...finding(0), title: '' }] }],
    [
      'finding body',
      { ...valid, findings: [{ ...finding(0), body: 'x'.repeat(4_001) }] },
    ],
    [
      'finding anchor',
      {
        ...valid,
        findings: [{ ...finding(0), anchor: { path: 'a', line: 0 } }],
      },
    ],
    ['duplicate finding', { ...valid, findings: [finding(0), finding(0)] }],
    ['effects', { ...valid, effects: [] }],
    ['effect', { ...valid, effects: [null] }],
    [
      'effect order',
      { ...valid, effects: [status, ...valid.effects.slice(0, -1)] },
    ],
    ['effect order', { ...valid, effects: [{ ...status, kind: 'other' }] }],
    ['effect id', { ...valid, effects: [{ ...status, id: sha256('x') }] }],
    [
      'effect finding',
      { ...valid, effects: [{ ...status, findingId: finding(0).id }] },
    ],
    [
      'effect finding',
      {
        ...valid,
        findings: [finding(0, false), finding(1)],
        effects: valid.effects,
      },
    ],
    ['status effect', { ...valid, effects: valid.effects.slice(0, -1) }],
  ];
  test.each(cases)('reports %s', (problem, value) => {
    expect(recordProblem(value)).toBe(problem);
  });
});

describe('partitionRecord and assembleRecord', () => {
  test('round-trip a record over several chunks without splitting characters', () => {
    const value = record();
    const { chunks, manifest } = partitionRecord(value, 64);
    expect(chunks.length).toBeGreaterThan(3);
    expect(manifest.chunkDigests).toHaveLength(chunks.length);
    expect(assembleRecord(manifest, [...chunks].reverse())).toEqual({
      status: 'complete',
      record: value,
    });
    expect(partitionRecord(value).chunks).toHaveLength(1);
  });

  test('a missing or altered chunk cannot authorize publication', () => {
    const { chunks, manifest } = partitionRecord(record(), 64);
    expect(assembleRecord(manifest, chunks.slice(1))).toEqual({
      status: 'incomplete',
      reason: 'chunk 0 is missing',
    });
    const altered = chunks.map((chunk, index) =>
      index === 2 ? { ...chunk, data: `${chunk.data.slice(1)}A` } : chunk,
    );
    expect(assembleRecord(manifest, altered)).toMatchObject({
      reason: 'chunk 2 does not match',
    });
    expect(
      assembleRecord({ ...manifest, recordDigest: sha256('other') }, chunks),
    ).toMatchObject({ reason: 'record digest does not match' });
    expect(
      assembleRecord(
        {
          ...manifest,
          chunkDigests: Array.from({ length: 65 }, () => sha256('x')),
        },
        chunks,
      ),
    ).toMatchObject({ reason: 'too many chunks' });
  });

  test('refuses a manifest whose chunks hold an invalid or foreign record', () => {
    const other = sha256('other round');
    const { chunks, manifest } = partitionRecord(record());
    const relabeled = chunks.map((chunk) => ({ ...chunk, roundKey: other }));
    expect(
      assembleRecord({ ...manifest, roundKey: other }, relabeled),
    ).toMatchObject({
      reason: 'record names another round',
    });
    const text = JSON.stringify({ kind: 'publication-record' });
    const data = Buffer.from(text).toString('base64url');
    expect(
      assembleRecord(
        {
          roundKey: round,
          chunkDigests: [sha256(data)],
          recordDigest: sha256(text),
        },
        [{ roundKey: round, index: 0, data }],
      ),
    ).toMatchObject({ reason: 'record is invalid: reviewKey' });
  });

  test('refuses an invalid record and one that needs too many chunks', () => {
    expect(() =>
      partitionRecord({ ...record(), outcome: 'merge' as 'approve' }),
    ).toThrow('invalid: outcome');
    expect(() => partitionRecord(record(), 8)).toThrow('too many chunks');
  });
});
