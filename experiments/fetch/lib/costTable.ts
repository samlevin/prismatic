// The preparation-cost table ADR 0004 cites: one row per prepare run, then
// one row per history level and plan, with the counts of the first run and
// the median of each time.
import type { AcquiredObjects } from './objectStore.ts';

export interface PreparationCost {
  readonly steps: readonly {
    readonly acquired: AcquiredObjects;
    readonly packBytesAdded: number;
  }[];
  readonly cumulative: readonly unknown[];
  readonly incremental: readonly unknown[];
  readonly manifest: readonly unknown[];
  readonly filesReadForIndex: number;
  readonly bytesReadForIndex: number;
  readonly parseMs?: number;
  readonly patchBytes: number;
  readonly patchMs: number;
  readonly wallClockMs: number;
}

export interface CostRow {
  readonly history: string;
  readonly scope: string;
  readonly cumulativePaths: number;
  readonly incrementalPaths: number;
  readonly manifestPaths: number;
  readonly acquiredBlobs: number;
  readonly acquiredBlobBytes: number;
  readonly packBytes: number;
  readonly filesParsed: number;
  readonly bytesParsed: number;
  readonly parseMs: number;
  readonly patchBytes: number;
  readonly patchMs: number;
  readonly wallClockMs: number;
}

export function costRow(
  history: string,
  scope: string,
  prep: PreparationCost,
): CostRow {
  let acquiredBlobs = 0;
  let acquiredBlobBytes = 0;
  let packBytes = 0;
  for (const step of prep.steps) {
    acquiredBlobs += step.acquired.byType.blob.count;
    acquiredBlobBytes += step.acquired.byType.blob.bytes;
    packBytes += step.packBytesAdded;
  }
  return {
    history,
    scope,
    cumulativePaths: prep.cumulative.length,
    incrementalPaths: prep.incremental.length,
    manifestPaths: prep.manifest.length,
    acquiredBlobs,
    acquiredBlobBytes,
    packBytes,
    filesParsed: prep.filesReadForIndex,
    bytesParsed: prep.bytesReadForIndex,
    parseMs: prep.parseMs ?? 0,
    patchBytes: prep.patchBytes,
    patchMs: prep.patchMs,
    wallClockMs: prep.wallClockMs,
  };
}

// The upper median, so the result is always a measured value.
export function median(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

export function medianRows(runs: readonly CostRow[]): CostRow[] {
  const groups = new Map<string, CostRow[]>();
  for (const run of runs) {
    const key = JSON.stringify([run.history, run.scope]);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map((same) => ({
    ...(same[0] as CostRow),
    parseMs: median(same.map((r) => r.parseMs)),
    patchMs: median(same.map((r) => r.patchMs)),
    wallClockMs: median(same.map((r) => r.wallClockMs)),
  }));
}
