import { describe, expect, it } from 'vitest';
import type { GitLogEntry, LazyFetch } from './gitCommand.ts';
import { noFullFetchScenario } from './noFullFetch.ts';
import { summarizeObjects } from './objectStore.ts';
import type { ScenarioRecord, StepRecord } from './scenarioRecord.ts';

const entry = (
  args: string[],
  lazyFetch: LazyFetch = 'disabled',
): GitLogEntry => ({
  cwd: '/repo',
  args,
  lazyFetch,
  status: 0,
  elapsedMs: 1,
});

const step = (status: number, objects: number): StepRecord => ({
  step: `status ${status}`,
  status,
  elapsedMs: 1,
  acquired: summarizeObjects(
    Array.from({ length: objects }, (_, index) => ({
      oid: String(index).repeat(40),
      type: 'blob' as const,
      size: 1,
      diskSize: 1,
    })),
  ),
  packBytesAdded: 0,
});

const scenario = (steps: StepRecord[]): ScenarioRecord => ({
  id: 'scenario',
  criteria: [1],
  title: 'title',
  passed: true,
  checks: [],
  steps,
});

const checks = (record: ScenarioRecord): Record<string, boolean> =>
  Object.fromEntries(record.checks.map((c) => [c.name, c.passed]));

describe('noFullFetchScenario', () => {
  it('passes a filtered run whose failures acquired nothing', () => {
    const record = noFullFetchScenario(
      [
        entry(['fetch', '--filter=blob:none', 'origin']),
        entry(['backfill', '--sparse'], 'enabled-for-this-process'),
        entry(['cat-file', 'blob', 'x']),
      ],
      [scenario([step(0, 3), step(1, 0)])],
    );
    expect(record.id).toBe('no-full-fetch');
    expect(record.passed).toBe(true);
    expect(record.checks[0]?.observed).toEqual({ fetches: 1, unfiltered: [] });
  });

  it('fails an unfiltered fetch, a failed step that acquired, and lazy fetch outside backfill', () => {
    const record = noFullFetchScenario(
      [
        entry(['fetch', 'origin']),
        entry(['cat-file', 'blob', 'x'], 'enabled-for-this-process'),
      ],
      [scenario([step(128, 1)])],
    );
    expect(record.passed).toBe(false);
    expect(checks(record)).toEqual({
      'every fetch the spike issued carried --filter=blob:none': false,
      'every failed step acquired no objects': false,
      'lazy fetch was enabled only for the backfill measurements': false,
    });
    expect(record.checks[1]?.observed).toEqual([
      { scenario: 'scenario', step: 'status 128', blobs: 1, objects: 1 },
    ]);
  });
});
