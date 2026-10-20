import { describe, expect, it } from 'vitest';
import { classifyAncestry, historyCompleteFrom } from './ancestry.ts';
import type { AncestryProbe } from './ancestry.ts';

interface Script {
  readonly fetchable?: boolean;
  // The prior head becomes reachable after this many deepen steps.
  readonly reachableAfter?: number;
  // The history is complete after this many deepen steps.
  readonly completeAfter?: number;
  readonly deepenFailsAt?: number;
}

function scripted(script: Script): AncestryProbe & { deepens: number[] } {
  let steps = 0;
  const deepens: number[] = [];
  return {
    deepens,
    fetchPrior: () => Promise.resolve(script.fetchable ?? true),
    isAncestor: () =>
      Promise.resolve(
        script.reachableAfter !== undefined && steps >= script.reachableAfter,
      ),
    historyComplete: () =>
      Promise.resolve(
        script.completeAfter !== undefined && steps >= script.completeAfter,
      ),
    deepen: (commits) => {
      steps += 1;
      deepens.push(commits);
      return Promise.resolve(script.deepenFailsAt !== steps);
    },
  };
}

const options = { maxSteps: 4, commitsPerStep: 25 };

describe('classifyAncestry', () => {
  it('reports an unfetchable prior head as unknown without deepening', async () => {
    const probe = scripted({ fetchable: false, reachableAfter: 0 });
    expect(await classifyAncestry(probe, options)).toEqual({
      ancestry: 'unknown',
      reason: 'prior-unfetchable',
      deepenSteps: 0,
    });
    expect(probe.deepens).toEqual([]);
  });

  it('proves an ancestor that is already reachable', async () => {
    expect(
      await classifyAncestry(scripted({ reachableAfter: 0 }), options),
    ).toEqual({
      ancestry: 'ancestor',
      reason: 'reachable',
      deepenSteps: 0,
    });
  });

  it('deepens in bounded steps until the prior head is reachable', async () => {
    const probe = scripted({ reachableAfter: 3 });
    expect(await classifyAncestry(probe, options)).toEqual({
      ancestry: 'ancestor',
      reason: 'reachable',
      deepenSteps: 3,
    });
    expect(probe.deepens).toEqual([25, 25, 25]);
  });

  it('reports rewritten only once the history is complete', async () => {
    expect(
      await classifyAncestry(scripted({ completeAfter: 2 }), options),
    ).toEqual({
      ancestry: 'rewritten',
      reason: 'not-reachable-in-complete-history',
      deepenSteps: 2,
    });
  });

  it('reports unknown when the step bound runs out', async () => {
    const probe = scripted({ reachableAfter: 10 });
    expect(await classifyAncestry(probe, options)).toEqual({
      ancestry: 'unknown',
      reason: 'deepen-bound',
      deepenSteps: 4,
    });
    expect(probe.deepens).toHaveLength(4);
  });

  it('reports unknown when a deepen fails', async () => {
    expect(
      await classifyAncestry(
        scripted({ reachableAfter: 3, deepenFailsAt: 2 }),
        options,
      ),
    ).toEqual({ ancestry: 'unknown', reason: 'deepen-failed', deepenSteps: 2 });
  });
});

describe('historyCompleteFrom', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const tip = 'c'.repeat(40);

  it('is complete when the store is not shallow', () => {
    expect(historyCompleteFrom(`${a}\n${b}\n`, '')).toBe(true);
  });

  it('ignores a shallow boundary the two commits never reach', () => {
    expect(historyCompleteFrom(`${a}\n${b}\n`, `${tip}\n`)).toBe(true);
  });

  it('is incomplete when a listed commit is a shallow boundary', () => {
    expect(historyCompleteFrom(`${a}\n${b}\n`, `${tip}\n${b}\n`)).toBe(false);
  });
});
