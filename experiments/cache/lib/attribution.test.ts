import { describe, expect, test } from 'vitest';
import { attribute } from './attribution.ts';

const boundaries = [
  { afterBlock: 1 as const, prefixTokens: 2000 },
  { afterBlock: 2 as const, prefixTokens: 4000 },
  { afterBlock: 4 as const, prefixTokens: 15000 },
];

describe('attribute', () => {
  test('is always labeled inferred', () => {
    expect(attribute(0, 0, boundaries, 0.02).basis).toBe('inferred');
  });

  test('a cold write reaches the furthest boundary and reads nothing', () => {
    expect(attribute(0, 15010, boundaries, 0.02)).toEqual({
      basis: 'inferred',
      read: { kind: 'none' },
      write: { kind: 'boundary', afterBlock: 4, offsetTokens: 10 },
    });
  });

  test('a partial hit reads to an earlier boundary and writes the rest', () => {
    const result = attribute(3990, 11000, boundaries, 0.02);
    expect(result.read).toEqual({
      kind: 'boundary',
      afterBlock: 2,
      offsetTokens: -10,
    });
    expect(result.write).toEqual({
      kind: 'boundary',
      afterBlock: 4,
      offsetTokens: -10,
    });
  });

  test('a counter far from every boundary stays unmatched', () => {
    expect(attribute(9000, 0, boundaries, 0.02)).toEqual({
      basis: 'inferred',
      read: { kind: 'unmatched', nearestOffsetTokens: 5000 },
      write: { kind: 'none' },
    });
    expect(attribute(1024, 0, [], 0.02).read).toEqual({
      kind: 'unmatched',
      nearestOffsetTokens: null,
    });
  });
});
