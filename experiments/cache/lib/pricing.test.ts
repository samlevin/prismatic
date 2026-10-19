import { describe, expect, test } from 'vitest';
import type { ModelPrices, Usage } from './pricing.ts';
import {
  costOf,
  parseUsage,
  pricesFor,
  reservationFor,
  rowFor,
} from './pricing.ts';

const sol = pricesFor('gpt-6.1-sol');

const usage = (overrides: Partial<Usage> = {}): Usage => ({
  inputTokens: 200_000,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 20_000,
  reasoningTokens: 15_000,
  ...overrides,
});

const total = (u: Usage): number =>
  Math.round(costOf(u, sol).totalUsd * 1000) / 1000;

describe('costOf', () => {
  // The §9.5 worked example: 200K input, a 160K reusable prefix, 20K output.
  test('reproduces the specification worked example', () => {
    expect(total(usage())).toBe(0.6);
    expect(total(usage({ cacheWriteTokens: 160_000 }))).toBe(0.68);
    expect(total(usage({ cachedTokens: 160_000 }))).toBe(0.296);
  });

  test('splits the cost and reports the write premium', () => {
    const cost = costOf(
      usage({ cachedTokens: 40_000, cacheWriteTokens: 100_000 }),
      sol,
    );
    expect(cost.ordinaryInputUsd).toBeCloseTo(0.12, 10);
    expect(cost.cacheWriteUsd).toBeCloseTo(0.25, 10);
    expect(cost.cachedInputUsd).toBeCloseTo(0.004, 10);
    expect(cost.outputUsd).toBeCloseTo(0.2, 10);
    expect(cost.writePremiumUsd).toBeCloseTo(0.05, 10);
    expect(cost.totalUsd).toBeCloseTo(0.574, 10);
  });

  test('refuses to price a request on the unknown long-context row', () => {
    expect(() => costOf(usage({ inputTokens: 272_001 }), sol)).toThrow(
      'The input rate is unknown.',
    );
  });
});

describe('rowFor and pricesFor', () => {
  test('chooses the row from total input', () => {
    expect(rowFor(sol, 272_000).maxInputTokens).toBe(272_000);
    expect(rowFor(sol, 272_001).maxInputTokens).toBeNull();
  });

  test('refuses an uncovered input or an unknown model', () => {
    const bounded: ModelPrices = { ...sol, rows: [sol.rows[0]!] };
    expect(() => rowFor(bounded, 300_000)).toThrow(RangeError);
    expect(() => pricesFor('gpt-6-luna')).toThrow(
      'No price catalog entry for gpt-6-luna.',
    );
  });
});

describe('reservationFor', () => {
  test('assumes every input token is written and the output ceiling is used', () => {
    expect(reservationFor(100_000, 64_000, sol)).toBeCloseTo(0.25 + 0.64, 10);
    expect(reservationFor(100_000, 0, sol, 1.1)).toBeCloseTo(0.275, 10);
  });
});

describe('parseUsage', () => {
  const raw = {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 40 },
    total_tokens: 1050,
  };

  test('reads a complete usage object', () => {
    expect(parseUsage(raw)).toEqual({
      kind: 'known',
      usage: {
        inputTokens: 1000,
        cachedTokens: 600,
        cacheWriteTokens: 300,
        outputTokens: 50,
        reasoningTokens: 40,
      },
    });
  });

  test('treats missing usage as unknown, never zero', () => {
    expect(parseUsage(undefined)).toEqual({
      kind: 'unknown',
      reason: 'usage missing',
    });
    expect(parseUsage(null).kind).toBe('unknown');
    expect(parseUsage({ ...raw, input_tokens_details: undefined })).toEqual({
      kind: 'unknown',
      reason: 'usage counter missing or invalid',
    });
  });

  test('refuses negative, fractional and inconsistent counters', () => {
    expect(parseUsage({ ...raw, output_tokens: -1 }).kind).toBe('unknown');
    expect(parseUsage({ ...raw, input_tokens: 1.5 }).kind).toBe('unknown');
    expect(parseUsage({ ...raw, input_tokens: 800 })).toEqual({
      kind: 'unknown',
      reason: 'cached and written tokens exceed input tokens',
    });
    expect(
      parseUsage({ ...raw, output_tokens_details: { reasoning_tokens: 51 } }),
    ).toEqual({
      kind: 'unknown',
      reason: 'reasoning tokens exceed output tokens',
    });
  });
});
