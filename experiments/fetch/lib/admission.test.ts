import { describe, expect, it } from 'vitest';
import {
  defaultPolicy,
  maxCandidateBlobBytes,
  planAdmission,
} from './admission.ts';
import type { Candidate } from './admission.ts';

const oid = (n: number): string => n.toString(16).padStart(40, '1');

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  path: 'src/a.ts',
  revision: 'head',
  mode: '100644',
  oid: oid(1),
  advertisedSize: 100,
  ...overrides,
});

describe('planAdmission', () => {
  it('admits a regular source file of known size', () => {
    const plan = planAdmission([candidate()], new Set());
    expect(plan.admitted).toHaveLength(1);
    expect(plan.oids).toEqual([oid(1)]);
    expect(plan.plannedBytes).toBe(100);
    expect(plan.excluded).toEqual([]);
  });

  it.each([
    ['deleted', { oid: '0'.repeat(40) }],
    ['deleted', { mode: '000000' }],
    ['symlink', { mode: '120000' }],
    ['submodule', { mode: '160000' }],
    ['not-regular', { mode: '040000' }],
    ['prohibited-directory', { path: 'node_modules/x/a.ts' }],
    ['prohibited-directory', { path: 'src/generated/a.ts' }],
    ['extension', { path: 'README.md' }],
    ['extension', { path: 'src/.ts' }],
    ['extension', { path: 'Makefile' }],
    ['ignored', { path: 'src/ignored.ts' }],
    ['unknown-size', { advertisedSize: undefined }],
    ['oversized', { advertisedSize: maxCandidateBlobBytes + 1 }],
  ] as const)('excludes for %s', (reason, overrides) => {
    const plan = planAdmission(
      [candidate(overrides)],
      new Set(['src/ignored.ts']),
    );
    expect(plan.admitted).toEqual([]);
    expect(plan.oids).toEqual([]);
    expect(plan.excluded).toEqual([
      {
        path: 'path' in overrides ? overrides.path : 'src/a.ts',
        revision: 'head',
        reason,
      },
    ]);
  });

  it('accepts an executable source file and matches extensions case-insensitively', () => {
    const plan = planAdmission(
      [candidate({ mode: '100755', path: 'src/A.TS' })],
      new Set(),
    );
    expect(plan.admitted).toHaveLength(1);
  });

  it('accepts a file exactly at the per-blob cap', () => {
    const plan = planAdmission(
      [candidate({ advertisedSize: maxCandidateBlobBytes })],
      new Set(),
    );
    expect(plan.admitted).toHaveLength(1);
  });

  it('deduplicates identical blobs across revisions', () => {
    const plan = planAdmission(
      [candidate({ revision: 'head' }), candidate({ revision: 'base' })],
      new Set(),
    );
    expect(plan.admitted).toHaveLength(2);
    expect(plan.oids).toEqual([oid(1)]);
    expect(plan.plannedBytes).toBe(100);
  });

  it('skips any blob that would exceed the aggregate cap and keeps admitting smaller ones', () => {
    const policy = { ...defaultPolicy, maxAggregateBytes: 250 };
    const plan = planAdmission(
      [
        candidate({ oid: oid(1), path: 'src/a.ts' }),
        candidate({ oid: oid(2), path: 'src/b.ts' }),
        candidate({ oid: oid(3), path: 'src/c.ts' }),
        candidate({ oid: oid(1), path: 'src/a-copy.ts' }),
        candidate({ oid: oid(4), path: 'src/d.ts', advertisedSize: 50 }),
      ],
      new Set(),
      policy,
    );
    expect(plan.oids).toEqual([oid(1), oid(2), oid(4)]);
    expect(plan.plannedBytes).toBe(250);
    expect(plan.excluded).toEqual([
      { path: 'src/c.ts', revision: 'head', reason: 'aggregate-budget' },
    ]);
    expect(plan.admitted.map((c) => c.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/a-copy.ts',
      'src/d.ts',
    ]);
  });
});
