// The §5.4 fixture guarantee: a repository with a 2 GiB tree and a 10-file
// change downloads under 100 MiB.
import { seededContent, sourceText } from '../lib/fixtures.ts';
import type { FixtureChange, FixtureCommit } from '../lib/fixtures.ts';
import type { Lab } from './lab.ts';
import { prepare } from './prepare.ts';
import { ScenarioBuilder } from './record.ts';
import type { ScenarioRecord } from './record.ts';

const assetCount = 512;
const assetBytes = 4 * 1024 * 1024;
const sourceCount = 200;
const changedCount = 10;
const budgetBytes = 100 * 1024 * 1024;

function largeFixture(): FixtureCommit[] {
  const base: FixtureChange[] = [{ path: '.gitignore', content: 'dist/\n' }];
  for (let index = 0; index < assetCount; index += 1)
    base.push({
      path: `assets/blob-${String(index).padStart(4, '0')}.bin`,
      content: seededContent(`asset ${index}`, assetBytes),
    });
  for (let index = 0; index < sourceCount; index += 1)
    base.push({
      path: `src/module${index}.ts`,
      content: sourceText(`module${index}`, 4000),
    });
  const changes: FixtureChange[] = [];
  for (let index = 0; index < changedCount; index += 1)
    changes.push({
      path: `src/module${index * 17}.ts`,
      content: `${sourceText(`module${index * 17}`, 4000)}export const changed${index} = true;\n`,
    });
  return [
    {
      mark: 1,
      ref: 'refs/heads/main',
      parents: [],
      message: 'base with a 2 GiB tree',
      changes: base,
    },
    {
      mark: 2,
      ref: 'refs/heads/pr',
      parents: [1],
      message: 'pr: change 10 files',
      changes,
    },
  ];
}

export async function largeScenario(lab: Lab): Promise<ScenarioRecord> {
  const s = new ScenarioBuilder(
    'large-2gib-10-files',
    [3],
    '2 GiB tree, 10-file change: download stays under 100 MiB',
  );
  const generated = performance.now();
  const server = await lab.createServer('large', largeFixture());
  const generationMs = Math.round(performance.now() - generated);
  const serverPackBytes = await lab.packBytes(server.dir);
  const base = server.commits.get(1) as string;
  const head = server.commits.get(2) as string;
  const sizes = new Map<string, number>();
  for (const commit of [base, head])
    for (const [oid, size] of await lab.advertisedSizes(server, commit))
      sizes.set(oid, size);
  const treeBytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  s.check(
    'the fixture tree holds at least 2 GiB of blobs',
    treeBytes >= 2 * 1024 ** 3,
    { treeBytes, serverPackBytes },
  );

  const client = await lab.createClient('large', server.url);
  const prep = await prepare(lab, client, {
    revisions: { head, mergeBase: base, baseTip: base },
    scope: 'union',
    sizeOf: (oid) => sizes.get(oid),
  });
  for (const step of prep.steps) s.step({ record: step });
  const stageA = prep.steps[0];
  s.check(
    'stage A acquires no blobs',
    stageA?.acquired.byType.blob.count === 0,
    stageA?.acquired.byType,
  );
  const steps = prep.steps;
  const packBytes = steps.reduce((sum, step) => sum + step.packBytesAdded, 0);
  const blobBytes = steps.reduce(
    (sum, step) => sum + step.acquired.byType.blob.bytes,
    0,
  );
  s.check(
    'exactly the planned blobs arrive',
    prep.acquisition.exact,
    prep.acquisition,
  );
  s.check(
    'ten changed files become eligible',
    prep.eligible.length === changedCount,
    prep.eligible,
  );
  s.check('downloaded pack bytes stay under 100 MiB', packBytes < budgetBytes, {
    packBytes,
    blobBytes,
  });
  s.data({
    generationMs,
    treeBytes,
    serverPackBytes,
    packBytes,
    blobBytes,
    prepareWallClockMs: prep.wallClockMs,
    plannedBytes: prep.planned.plannedBytes,
  });
  return s.build();
}
