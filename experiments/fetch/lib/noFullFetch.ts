// The audit that closes every run: a fetch without the blob filter would be
// a full download, and a failed step that acquired objects would mean a
// failure widened the scope.
import type { GitLogEntry } from './gitCommand.ts';
import { ScenarioBuilder } from './scenarioRecord.ts';
import type { ScenarioRecord } from './scenarioRecord.ts';

export function noFullFetchScenario(
  log: readonly GitLogEntry[],
  records: readonly ScenarioRecord[],
): ScenarioRecord {
  const s = new ScenarioBuilder(
    'no-full-fetch',
    [3, 5],
    'No failure widens the scope, and no fetch ever omits the blob filter',
  );
  const fetches = log.filter((entry) => entry.args.includes('fetch'));
  const unfiltered = fetches.filter(
    (entry) => !entry.args.includes('--filter=blob:none'),
  );
  s.check(
    'every fetch the spike issued carried --filter=blob:none',
    unfiltered.length === 0,
    {
      fetches: fetches.length,
      unfiltered: unfiltered.map((e) => e.args.join(' ')),
    },
  );
  const failed = records.flatMap((record) =>
    record.steps
      .filter((step) => step.status !== 0)
      .map((step) => ({
        scenario: record.id,
        step: step.step,
        blobs: step.acquired.byType.blob.count,
        objects: step.acquired.objects.length,
      })),
  );
  s.check(
    'every failed step acquired no objects',
    failed.every((step) => step.objects === 0),
    failed,
  );
  const lazy = log.filter((entry) => entry.lazyFetch !== 'disabled');
  s.check(
    'lazy fetch was enabled only for the backfill measurements',
    lazy.every((entry) => entry.args.includes('backfill')),
    lazy.map((e) => e.args.join(' ')),
  );
  return s.build();
}
