import { describe, expect, it } from 'vitest';
import type { Candidate } from './admission.ts';
import { unionManifest } from './inventory.ts';
import type { ChangedPath } from './inventory.ts';
import {
  hiddenReviewablePaths,
  manifestCandidates,
  selectManifest,
} from './plan.ts';

const zero = '0'.repeat(40);
const oid = (digit: string): string => digit.repeat(40);

function change(
  path: string,
  status: ChangedPath['status'],
  oldOid: string,
  newOid: string,
): ChangedPath {
  return {
    path,
    status,
    oldMode: status === 'A' ? '000000' : '100644',
    newMode: status === 'D' ? '000000' : '100644',
    oldOid: status === 'A' ? zero : oldOid,
    newOid: status === 'D' ? zero : newOid,
  };
}

const manifest = unionManifest(
  [
    change('src/added.ts', 'A', zero, oid('1')),
    change('src/deleted.ts', 'D', oid('2'), zero),
    change('src/both.ts', 'M', oid('3'), oid('4')),
    change('src/old-round.ts', 'M', oid('5'), oid('6')),
    change('src/evidence.ts', 'M', oid('7'), oid('8')),
  ],
  [
    change('src/both.ts', 'M', oid('9'), oid('4')),
    change('src/reverted.ts', 'M', oid('a'), oid('b')),
    change('src/new-in-delta.ts', 'A', zero, oid('c')),
  ],
);
const paths = (entries: readonly { path: string }[]): string[] =>
  entries.map((entry) => entry.path);

describe('selectManifest', () => {
  it('keeps the whole union manifest for the union scope', () => {
    expect(selectManifest(manifest, 'union', new Set(), true)).toBe(manifest);
  });

  it('keeps everything when there is no frontier', () => {
    expect(selectManifest(manifest, 'narrowed', new Set(), false)).toBe(
      manifest,
    );
  });

  it('narrows to the delta and the evidence paths', () => {
    expect(
      paths(
        selectManifest(
          manifest,
          'narrowed',
          new Set(['src/evidence.ts']),
          true,
        ),
      ),
    ).toEqual([
      'src/both.ts',
      'src/evidence.ts',
      'src/new-in-delta.ts',
      'src/reverted.ts',
    ]);
  });
});

describe('manifestCandidates', () => {
  const sizes = new Map([[oid('4'), 40]]);
  const candidates = manifestCandidates(
    manifest,
    { head: 'H', mergeBase: 'M', frontier: 'F' },
    (id) => sizes.get(id),
  );
  const sides = (path: string): string[] =>
    candidates
      .filter((candidate) => candidate.path === path)
      .map((candidate) => `${candidate.revision}:${candidate.oid[0] ?? ''}`);

  it('takes the head side of every path that still exists', () => {
    expect(sides('src/added.ts')).toEqual(['H:1']);
  });

  it('takes only the merge-base side of a deleted path', () => {
    expect(sides('src/deleted.ts')).toEqual(['M:2']);
  });

  it('takes head, merge-base and frontier sides of a path changed in both diffs', () => {
    expect(sides('src/both.ts')).toEqual(['H:4', 'M:3', 'F:9']);
  });

  it('takes head and frontier sides of a reverted path', () => {
    expect(sides('src/reverted.ts')).toEqual(['H:b', 'F:a']);
  });

  it('takes no frontier side of a path added since the frontier', () => {
    expect(sides('src/new-in-delta.ts')).toEqual(['H:c']);
  });

  it('records the advertised size, or none', () => {
    expect(
      candidates.find((c) => c.path === 'src/both.ts' && c.revision === 'H')
        ?.advertisedSize,
    ).toBe(40);
    expect(
      candidates.find((c) => c.path === 'src/added.ts')?.advertisedSize,
    ).toBeUndefined();
  });

  it('takes no frontier side without a frontier', () => {
    const withoutFrontier = manifestCandidates(
      manifest,
      { head: 'H', mergeBase: 'M' },
      () => 1,
    );
    expect(withoutFrontier.some((c) => c.revision === 'F')).toBe(false);
  });

  it('skips an entry with neither change', () => {
    expect(
      manifestCandidates(
        [{ path: 'x.ts' }],
        { head: 'H', mergeBase: 'M' },
        () => 1,
      ),
    ).toEqual([]);
  });
});

describe('hiddenReviewablePaths', () => {
  const at = (path: string, mode = '100644'): Candidate => ({
    path,
    revision: 'H',
    mode,
    oid: oid('1'),
    advertisedSize: 10,
  });
  const candidates = [
    at('src/hidden.ts'),
    at('src/always.ts'),
    at('assets/data.json'),
    at('src/link.ts', '120000'),
    { ...at('src/base-only.ts'), revision: 'B' },
  ];

  it('reports only reviewable paths hidden by head rules alone', () => {
    const ignoredAt = new Map<string, string[]>([
      ['src/hidden.ts', ['H']],
      ['src/always.ts', ['B', 'H']],
      ['assets/data.json', ['H']],
      ['src/link.ts', ['H']],
      ['src/base-only.ts', ['H']],
      ['src/merge-base.ts', ['M']],
    ]);
    expect(hiddenReviewablePaths(ignoredAt, 'H', 'B', candidates)).toEqual([
      'src/hidden.ts',
    ]);
  });
});
