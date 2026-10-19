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
  test('separates fixed framing from per-token error', () => {
    // provider = 1.05 * local + 300 exactly.
    const summary = summarizeMargin('t', [
      { label: 'a', local: 4000, provider: 4500 },
      { label: 'b', local: 16000, provider: 17100 },
      { label: 'c', local: 20000, provider: 21300 },
    ]);
    expect(summary.tokenizer).toBe('t');
    expect(summary.samples).toBe(3);
    expect(summary.slope).toBeCloseTo(1.05, 10);
    expect(summary.interceptTokens).toBeCloseTo(300, 6);
    expect(summary.worstAbsoluteResidualRatio).toBeCloseTo(0, 10);
    expect(summary.requiredMarginRatio).toBeCloseTo(0, 10);
  });

  test('a fixed overhead alone needs no proportional margin', () => {
    // A short request makes a fixed 400-token overhead look like a 10% error
    // by ratio; the fit puts it in the intercept instead.
    const summary = summarizeMargin('t', [
      { label: 'short', local: 3600, provider: 4000 },
      { label: 'long', local: 16000, provider: 16400 },
    ]);
    expect(summary.slope).toBeCloseTo(1, 10);
    expect(summary.interceptTokens).toBeCloseTo(400, 6);
    expect(summary.requiredMarginRatio).toBeCloseTo(0, 10);
  });

  test('reports the worst under-prediction left by the fit', () => {
    const summary = summarizeMargin('t', [
      { label: 'a', local: 1000, provider: 1000 },
      { label: 'b', local: 2000, provider: 2100 },
      { label: 'c', local: 3000, provider: 3000 },
    ]);
    expect(summary.slope).toBeCloseTo(1, 10);
    expect(summary.interceptTokens).toBeCloseTo(100 / 3, 6);
    expect(summary.worstUnderPredictionRatio).toBeCloseTo(
      (2100 - 2000 - 100 / 3) / 2100,
      10,
    );
    expect(summary.requiredMarginRatio).toBe(summary.worstUnderPredictionRatio);
    expect(summary.meanAbsoluteResidualRatio).toBeGreaterThan(0);
  });

  test('takes the slope as 1 when every local count is equal', () => {
    const summary = summarizeMargin('t', [
      { label: 'a', local: 100, provider: 130 },
      { label: 'b', local: 100, provider: 110 },
    ]);
    expect(summary.slope).toBe(1);
    expect(summary.interceptTokens).toBe(20);
    expect(summary.requiredMarginRatio).toBeCloseTo(10 / 130, 10);
  });

  test('refuses an empty sample set', () => {
    expect(() => summarizeMargin('t', [])).toThrow(RangeError);
  });
});

describe('selectTokenizer', () => {
  test('prefers the tightest fit, then a slope nearer 1', () => {
    const loose = summarizeMargin('loose', [
      { label: 'a', local: 1000, provider: 1000 },
      { label: 'b', local: 2000, provider: 2300 },
      { label: 'c', local: 3000, provider: 3000 },
    ]);
    const scaled = summarizeMargin('scaled', [
      { label: 'a', local: 800, provider: 1000 },
      { label: 'b', local: 1600, provider: 2000 },
    ]);
    const exact = summarizeMargin('exact', [
      { label: 'a', local: 1000, provider: 1050 },
      { label: 'b', local: 2000, provider: 2050 },
    ]);
    expect(selectTokenizer([loose, scaled, exact])?.tokenizer).toBe('exact');
    expect(selectTokenizer([loose, scaled])?.tokenizer).toBe('scaled');
    expect(selectTokenizer([])).toBeUndefined();
  });
});
