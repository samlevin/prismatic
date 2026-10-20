import { describe, expect, test } from 'vitest';
import {
  cacheBreakEvenShare,
  cacheReadShare,
  costLedger,
  costPerDefect,
  requestCost,
  usageCost,
  type Rates,
  type RequestRecord,
  type Usage,
} from './cost.ts';

// The §9.5 worked-example rates.
const rates: Rates = {
  inputPerMillion: 2,
  cacheWritePerMillion: 2.5,
  cachedInputPerMillion: 0.1,
  outputPerMillion: 10,
};

const usage: Usage = {
  inputTokens: 1000,
  cachedInputTokens: 200,
  cacheWriteTokens: 300,
  outputTokens: 100,
  reasoningTokens: 40,
};

describe('usageCost', () => {
  test('prices each input class at its own rate and output with reasoning', () => {
    // 500 ordinary at $2, 300 written at $2.50, 200 read at $0.10, 100 out at $10.
    expect(usageCost(usage, rates)).toBeCloseTo(2770 / 1e6, 15);
  });

  test('refuses inconsistent counters', () => {
    expect(() => usageCost({ ...usage, outputTokens: -1 }, rates)).toThrow(
      'outputTokens',
    );
    expect(() => usageCost({ ...usage, inputTokens: 1.5 }, rates)).toThrow(
      'inputTokens',
    );
    expect(() =>
      usageCost({ ...usage, cachedInputTokens: 800 }, rates),
    ).toThrow('exceed input');
    expect(() => usageCost({ ...usage, reasoningTokens: 101 }, rates)).toThrow(
      'exceed output',
    );
  });
});

describe('requestCost', () => {
  test('charges a request without usage its whole reservation', () => {
    expect(
      requestCost(
        {
          purpose: 'discovery',
          outcome: 'failed',
          usage: null,
          reservedUsd: 0.4,
        },
        rates,
      ),
    ).toEqual({ usd: 0.4, known: false });
  });

  test('charges nothing for a request refused before sending', () => {
    expect(
      requestCost(
        {
          purpose: 'discovery',
          outcome: 'refused-budget',
          usage: null,
          reservedUsd: 0.4,
        },
        rates,
      ),
    ).toEqual({ usd: 0, known: true });
    expect(() =>
      requestCost(
        {
          purpose: 'discovery',
          outcome: 'refused-budget',
          usage,
          reservedUsd: 0,
        },
        rates,
      ),
    ).toThrow('never sent');
  });

  test('refuses a negative reservation', () => {
    expect(() =>
      requestCost(
        { purpose: 'discovery', outcome: 'completed', usage, reservedUsd: -1 },
        rates,
      ),
    ).toThrow('reservation');
  });
});

describe('costLedger', () => {
  const records: RequestRecord[] = [
    { purpose: 'discovery', outcome: 'completed', usage, reservedUsd: 0.1 },
    {
      purpose: 'assessment',
      outcome: 'uncertain',
      usage: null,
      reservedUsd: 0.05,
    },
    { purpose: 'verification', outcome: 'failed', usage, reservedUsd: 0.1 },
    {
      purpose: 'discovery',
      outcome: 'refused-budget',
      usage: null,
      reservedUsd: 0.2,
    },
    { purpose: 'research', outcome: 'completed', usage, reservedUsd: 0.1 },
  ];

  test('bills every sent request and keeps research spend apart', () => {
    const ledger = costLedger(records, rates);
    const each = 2770 / 1e6;
    expect(ledger.reviewerUsd).toBeCloseTo(each * 2 + 0.05, 12);
    expect(ledger.failedAttemptUsd).toBeCloseTo(each + 0.05, 12);
    expect(ledger.researchUsd).toBeCloseTo(each, 12);
    expect(ledger.requests).toBe(3);
    expect(ledger.refused).toBe(1);
    expect(ledger.usageComplete).toBe(false);
    expect(ledger.inputTokens).toBe(2000);
    expect(ledger.cachedInputTokens).toBe(400);
    expect(ledger.cacheWriteTokens).toBe(600);
    expect(ledger.outputTokens).toBe(200);
    expect(ledger.reasoningTokens).toBe(80);
  });

  test('is complete when every request reported usage', () => {
    const ledger = costLedger(records.slice(0, 1), rates);
    expect(ledger.usageComplete).toBe(true);
    expect(ledger.failedAttemptUsd).toBe(0);
  });
});

describe('cache and defect economics', () => {
  test('the read share compares reads with writes', () => {
    expect(
      cacheReadShare({ cachedInputTokens: 30, cacheWriteTokens: 100 }),
    ).toBe(0.3);
    expect(
      cacheReadShare({ cachedInputTokens: 30, cacheWriteTokens: 0 }),
    ).toBeNull();
  });

  test('the break-even read share is 26.3% at the §9.5 rates', () => {
    expect(cacheBreakEvenShare(rates)).toBeCloseTo(0.263, 3);
    expect(() =>
      cacheBreakEvenShare({ ...rates, cachedInputPerMillion: 2 }),
    ).toThrow('less than input');
  });

  test('cost per defect is undefined when nothing was found', () => {
    expect(costPerDefect(3, 2)).toBe(1.5);
    expect(costPerDefect(3, 0)).toBeNull();
  });
});
