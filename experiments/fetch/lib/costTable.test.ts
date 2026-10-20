import { describe, expect, it } from 'vitest';
import { costRow, median, medianRows } from './costTable.ts';
import type { CostRow, PreparationCost } from './costTable.ts';
import { summarizeObjects } from './objectStore.ts';

const blob = (digit: string, size: number) => ({
  oid: digit.repeat(40),
  type: 'blob' as const,
  size,
  diskSize: size,
});

const prep: PreparationCost = {
  steps: [
    {
      acquired: summarizeObjects([
        { oid: 'c'.repeat(40), type: 'commit', size: 200, diskSize: 150 },
      ]),
      packBytesAdded: 300,
    },
    {
      acquired: summarizeObjects([blob('a', 10), blob('b', 20)]),
      packBytesAdded: 40,
    },
  ],
  cumulative: [1, 2, 3],
  incremental: [1],
  manifest: [1, 2, 3],
  filesReadForIndex: 2,
  bytesReadForIndex: 30,
  patchBytes: 500,
  patchMs: 4,
  wallClockMs: 60,
};

describe('costRow', () => {
  it('sums blob and pack bytes over every step', () => {
    expect(costRow('little', 'union', { ...prep, parseMs: 3 })).toEqual({
      history: 'little',
      scope: 'union',
      cumulativePaths: 3,
      incrementalPaths: 1,
      manifestPaths: 3,
      acquiredBlobs: 2,
      acquiredBlobBytes: 30,
      packBytes: 340,
      filesParsed: 2,
      bytesParsed: 30,
      parseMs: 3,
      patchBytes: 500,
      patchMs: 4,
      wallClockMs: 60,
    });
  });

  it('records no parse time when nothing was parsed', () => {
    expect(costRow('little', 'union', prep).parseMs).toBe(0);
  });
});

describe('median', () => {
  it.each([
    [[5, 1, 3], 3],
    [[4, 1, 3, 2], 3],
    [[7], 7],
    [[], 0],
  ])('of %j is %d', (values, expected) => {
    expect(median(values)).toBe(expected);
  });
});

describe('medianRows', () => {
  const run = (
    history: string,
    scope: string,
    ms: number,
    blobs = 1,
  ): CostRow => ({
    ...costRow(history, scope, prep),
    acquiredBlobs: blobs,
    parseMs: ms,
    patchMs: ms + 1,
    wallClockMs: ms + 2,
  });

  it('keeps the first run of each group and takes the median of each time', () => {
    const rows = medianRows([
      run('little', 'union', 10, 5),
      run('little', 'narrowed', 1),
      run('little', 'union', 30, 6),
      run('little', 'narrowed', 2),
      run('little', 'union', 20, 7),
      run('little', 'narrowed', 3),
    ]);
    expect(rows.map((r) => [r.history, r.scope])).toEqual([
      ['little', 'union'],
      ['little', 'narrowed'],
    ]);
    expect(rows[0]).toMatchObject({
      acquiredBlobs: 5,
      parseMs: 20,
      patchMs: 21,
      wallClockMs: 22,
    });
    expect(rows[1]).toMatchObject({ parseMs: 2, patchMs: 3, wallClockMs: 4 });
  });
});
