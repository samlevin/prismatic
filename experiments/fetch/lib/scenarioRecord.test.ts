import { describe, expect, it } from 'vitest';
import { summarizeObjects } from './objectStore.ts';
import { ScenarioBuilder } from './scenarioRecord.ts';
import type { StepRecord } from './scenarioRecord.ts';

const record: StepRecord = {
  step: 'fetch',
  status: 0,
  elapsedMs: 3,
  acquired: summarizeObjects([]),
  packBytesAdded: 0,
};

describe('ScenarioBuilder', () => {
  it('passes only when every check passes', () => {
    const s = new ScenarioBuilder('id', [1, 2], 'title');
    expect(s.check('first', true)).toBe(true);
    expect(s.check('second', false, { seen: 1 })).toBe(false);
    expect(s.build()).toEqual({
      id: 'id',
      criteria: [1, 2],
      title: 'title',
      passed: false,
      checks: [
        { name: 'first', passed: true, observed: undefined },
        { name: 'second', passed: false, observed: { seen: 1 } },
      ],
      steps: [],
    });
  });

  it('does not pass without checks', () => {
    expect(new ScenarioBuilder('id', [], 'title').build().passed).toBe(false);
  });

  it('records steps in order and returns what it was given', () => {
    const s = new ScenarioBuilder('id', [1], 'title');
    const measured = { value: 'result', record };
    expect(s.step(measured)).toBe(measured);
    s.step({ record: { ...record, step: 'second' } });
    s.check('ok', true);
    s.data({ table: [] });
    const built = s.build();
    expect(built.passed).toBe(true);
    expect(built.steps.map((step) => step.step)).toEqual(['fetch', 'second']);
    expect(built.data).toEqual({ table: [] });
  });
});
