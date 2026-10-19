import { describe, expect, test } from 'vitest';
import {
  byteHeuristic,
  selectTokenizer,
  summarizeMargin,
  tokenizerCandidates,
} from './tokens.ts';

describe('tokenizer candidates', () => {
  test('count text deterministically and offline', () => {
    const text = 'export function ledgerShard0(a: number): number {\n';
    expect(tokenizerCandidates.map((c) => c.id)).toEqual([
      'o200k_base',
      'cl100k_base',
      'utf8-bytes-div-4',
    ]);
    for (const candidate of tokenizerCandidates) {
      const count = candidate.count(text);
      expect(count).toBeGreaterThan(0);
      expect(candidate.count(text)).toBe(count);
      expect(candidate.count('')).toBe(0);
    }
  });

  test('the byte heuristic rounds UTF-8 bytes up to quarters', () => {
    expect(byteHeuristic.count('abcde')).toBe(2);
    expect(byteHeuristic.count('é')).toBe(1);
  });

  test('o200k_base treats special-token text as ordinary text', () => {
    const [o200k] = tokenizerCandidates;
    expect(o200k?.count('<|endoftext|>')).toBeGreaterThan(1);
  });
});

describe('summarizeMargin', () => {
  test('measures under-count, absolute error and framing overhead', () => {
    const summary = summarizeMargin('t', [
      { label: 'a', local: 90, provider: 100 },
      { label: 'b', local: 210, provider: 200 },
    ]);
    expect(summary).toMatchObject({
      tokenizer: 't',
      samples: 2,
      minOverheadTokens: -10,
      maxOverheadTokens: 10,
    });
    expect(summary.worstUnderCountRatio).toBeCloseTo(0.1, 10);
    expect(summary.requiredMarginRatio).toBeCloseTo(0.1, 10);
    expect(summary.worstAbsoluteErrorRatio).toBeCloseTo(0.1, 10);
    expect(summary.meanAbsoluteErrorRatio).toBeCloseTo(0.075, 10);
  });

  test('needs no margin when the local count never falls short', () => {
    const summary = summarizeMargin('t', [
      { label: 'a', local: 120, provider: 100 },
      { label: 'z', local: 1, provider: 0 },
    ]);
    expect(summary.requiredMarginRatio).toBe(0);
  });

  test('refuses an empty sample set', () => {
    expect(() => summarizeMargin('t', [])).toThrow(RangeError);
  });
});

describe('selectTokenizer', () => {
  test('prefers accuracy in both directions, then mean error', () => {
    const overCounter = summarizeMargin('over', [
      { label: 'a', local: 140, provider: 100 },
    ]);
    const close = summarizeMargin('close', [
      { label: 'a', local: 98, provider: 100 },
      { label: 'b', local: 100, provider: 100 },
    ]);
    const closeToo = summarizeMargin('close-too', [
      { label: 'a', local: 98, provider: 100 },
      { label: 'b', local: 98, provider: 100 },
    ]);
    expect(selectTokenizer([overCounter, closeToo, close])?.tokenizer).toBe(
      'close',
    );
    expect(selectTokenizer([])).toBeUndefined();
  });
});
