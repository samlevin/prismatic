import { describe, expect, test } from 'vitest';
import {
  binomialCdf,
  binomialLowerBound,
  binomialUpperBound,
  clopperPearson,
  clusterBootstrap,
  poissonCdf,
  poissonRateInterval,
  quantile,
  seededRandom,
  union,
} from './intervals.ts';

describe('distribution functions', () => {
  test('binomialCdf matches direct sums and its edges', () => {
    expect(binomialCdf(1, 2, 0.5)).toBeCloseTo(0.75, 12);
    expect(binomialCdf(3, 10, 0.3)).toBeCloseTo(0.6496107184, 9);
    expect(binomialCdf(-1, 5, 0.5)).toBe(0);
    expect(binomialCdf(5, 5, 0.5)).toBe(1);
    expect(binomialCdf(2, 5, 0)).toBe(1);
    expect(binomialCdf(2, 5, 1)).toBe(0);
    // Large n does not underflow.
    expect(binomialCdf(5000, 10000, 0.5)).toBeCloseTo(0.504, 3);
  });

  test('poissonCdf matches direct sums and its edges', () => {
    expect(poissonCdf(0, 2)).toBeCloseTo(Math.exp(-2), 12);
    expect(poissonCdf(2, 2)).toBeCloseTo(5 * Math.exp(-2), 12);
    expect(poissonCdf(-1, 2)).toBe(0);
    expect(poissonCdf(3, 0)).toBe(1);
  });
});

describe('exact intervals', () => {
  test('the zero-event upper bound is the rule of three', () => {
    expect(binomialUpperBound(0, 100)).toBeCloseTo(1 - 0.05 ** (1 / 100), 9);
    expect(binomialUpperBound(0, 100)).toBeLessThan(3 / 100);
    expect(binomialUpperBound(10, 10)).toBe(1);
    expect(binomialUpperBound(0, 0)).toBe(1);
    expect(binomialLowerBound(0, 10)).toBe(0);
  });

  test('Clopper-Pearson matches published values', () => {
    const half = clopperPearson(5, 10);
    expect(half.lower).toBeCloseTo(0.187086, 5);
    expect(half.upper).toBeCloseTo(0.812914, 5);
    const none = clopperPearson(0, 10);
    expect(none.lower).toBe(0);
    expect(none.upper).toBeCloseTo(1 - 0.025 ** (1 / 10), 9);
    const all = clopperPearson(10, 10);
    expect(all.lower).toBeCloseTo(0.025 ** (1 / 10), 9);
    expect(all.upper).toBe(1);
  });

  test('the Poisson interval matches Garwood values and scales by exposure', () => {
    const zero = poissonRateInterval(0, 1);
    expect(zero.lower).toBe(0);
    expect(zero.upper).toBeCloseTo(-Math.log(0.025), 6);
    const five = poissonRateInterval(5, 1);
    expect(five.lower).toBeCloseTo(1.623486, 5);
    expect(five.upper).toBeCloseTo(11.668332, 5);
    const perPr = poissonRateInterval(5, 10);
    expect(perPr.lower).toBeCloseTo(0.1623486, 6);
    expect(perPr.upper).toBeCloseTo(1.1668332, 6);
  });

  test('refuses invalid arguments', () => {
    expect(() => binomialUpperBound(-1, 5)).toThrow('Successes');
    expect(() => binomialUpperBound(1.5, 5)).toThrow('Successes');
    expect(() => binomialUpperBound(1, -5)).toThrow('Trials');
    expect(() => binomialUpperBound(6, 5)).toThrow('cannot exceed');
    expect(() => binomialLowerBound(6, 5)).toThrow('cannot exceed');
    expect(() => binomialUpperBound(1, 5, 1)).toThrow('Confidence');
    expect(() => clopperPearson(1, 5, 0)).toThrow('Confidence');
    expect(() => poissonRateInterval(1, 0)).toThrow('Exposure');
    expect(() => poissonRateInterval(-1, 1)).toThrow('Count');
    expect(() => poissonRateInterval(1, 1, 2)).toThrow('Confidence');
  });
});

describe('resampling helpers', () => {
  test('seededRandom is deterministic and in [0, 1)', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const values = Array.from({ length: 1000 }, () => a());
    expect(values).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(seededRandom(8)()).not.toBe(values[0]);
  });

  test('quantile uses the nearest rank', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(sorted, 0.5)).toBe(5);
    expect(quantile(sorted, 0.95)).toBe(10);
    expect(quantile(sorted, 0)).toBe(1);
    expect(() => quantile([], 0.5)).toThrow('No values');
    expect(() => quantile(sorted, 1.5)).toThrow('Quantile');
  });

  test('clusterBootstrap is reproducible and keeps clusters whole', () => {
    const clusters = [
      { found: 1, total: 1 },
      { found: 0, total: 3 },
      { found: 2, total: 2 },
      { found: 1, total: 4 },
    ];
    const ratio = (sample: readonly (typeof clusters)[number][]): number =>
      sample.reduce((t, c) => t + c.found, 0) /
      sample.reduce((t, c) => t + c.total, 0);
    const first = clusterBootstrap(clusters, ratio, { resamples: 2000 });
    expect(first).toEqual(
      clusterBootstrap(clusters, ratio, { resamples: 2000 }),
    );
    expect(first?.lower).toBeLessThan(0.4);
    expect(first?.upper).toBeGreaterThan(0.4);
    const values = Array.from({ length: 30 }, (_, index) => index * 1.37);
    const mean = (sample: readonly number[]): number =>
      sample.reduce((t, v) => t + v, 0) / sample.length;
    expect(
      clusterBootstrap(values, mean, { resamples: 500, seed: 1 }),
    ).not.toEqual(clusterBootstrap(values, mean, { resamples: 500, seed: 2 }));
  });

  test('clusterBootstrap returns null without data or a denominator', () => {
    expect(clusterBootstrap([], () => 1)).toBeNull();
    expect(clusterBootstrap([1, 2], () => null, { resamples: 10 })).toBeNull();
    expect(() => clusterBootstrap([1], () => 1, { confidence: 1 })).toThrow(
      'Confidence',
    );
  });

  test('union spans both intervals', () => {
    expect(
      union({ lower: 0.2, upper: 0.5 }, { lower: 0.1, upper: 0.4 }),
    ).toEqual({ lower: 0.1, upper: 0.5 });
    expect(union(null, { lower: 0, upper: 1 })).toEqual({ lower: 0, upper: 1 });
    expect(union({ lower: 0, upper: 1 }, null)).toEqual({ lower: 0, upper: 1 });
    expect(union(null, null)).toBeNull();
  });
});
