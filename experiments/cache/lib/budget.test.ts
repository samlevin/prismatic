import { describe, expect, test } from 'vitest';
import { EvaluationBudget } from './budget.ts';

describe('EvaluationBudget', () => {
  test('reserves, settles from measured cost and releases the rest', () => {
    const budget = new EvaluationBudget(1);
    expect(budget.reserve('a', 0.4)).toBe(true);
    expect(budget.remainingUsd).toBeCloseTo(0.6, 10);
    budget.settle('a', 0.1);
    expect(budget.snapshot()).toEqual({
      limitUsd: 1,
      settledUsd: 0.1,
      heldUsd: 0,
      remainingUsd: 0.9,
      refused: 0,
    });
  });

  test('keeps the whole reservation when the charge is unknown', () => {
    const budget = new EvaluationBudget(1);
    budget.reserve('a', 0.4);
    budget.settle('a', undefined);
    expect(budget.snapshot()).toMatchObject({ heldUsd: 0.4, settledUsd: 0 });
    expect(budget.remainingUsd).toBeCloseTo(0.6, 10);
  });

  test('refuses a reservation that does not fit and counts it', () => {
    const budget = new EvaluationBudget(0.5);
    expect(budget.reserve('a', 0.3)).toBe(true);
    expect(budget.reserve('b', 0.3)).toBe(false);
    expect(budget.snapshot().refused).toBe(1);
    expect(budget.reserve('b', 0.2)).toBe(true);
  });

  test('rejects misuse', () => {
    expect(() => new EvaluationBudget(0)).toThrow(RangeError);
    expect(() => new EvaluationBudget(Number.NaN)).toThrow(RangeError);
    const budget = new EvaluationBudget(1);
    budget.reserve('a', 0.1);
    expect(() => budget.reserve('a', 0.1)).toThrow('a is already reserved.');
    expect(() => budget.reserve('b', -1)).toThrow(RangeError);
    expect(() => budget.reserve('c', Number.NaN)).toThrow(RangeError);
    expect(() => budget.settle('z', 0)).toThrow('z is not reserved.');
  });
});
