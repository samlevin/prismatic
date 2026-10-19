import { describe, expect, it } from 'vitest';
import { buildRepository, encodeObject } from './repositoryObjects.ts';
import { securityScenario } from './scenarios.ts';
import type { FixtureRepository } from './types.ts';

const oneCommit = (
  changes: FixtureRepository['commits'][number]['changes'],
  refs: FixtureRepository['refs'] = { 'refs/heads/main': 'c' },
): FixtureRepository => ({
  defaultBranch: 'main',
  commits: [{ label: 'c', parents: [], message: 'm', changes }],
  refs,
});

describe('encodeObject', () => {
  it('hashes objects the way Git does', () => {
    expect(encodeObject('blob', Buffer.alloc(0)).id).toBe(
      'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
    );
    expect(encodeObject('tree', Buffer.alloc(0)).id).toBe(
      '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    );
    expect(encodeObject('blob', Buffer.from('hello\n')).id).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
  });
});

describe('buildRepository', () => {
  it('gives the same history the same object IDs every time', () => {
    const scenario = securityScenario('diverged-head').repository;
    expect(buildRepository(scenario).commits).toEqual(
      buildRepository(scenario).commits,
    );
  });

  it('refuses paths Git cannot store', () => {
    expect(() =>
      buildRepository(oneCommit({ 'a//b.ts': { kind: 'file', content: '' } })),
    ).toThrow(/empty segment or NUL/);
    expect(() =>
      buildRepository(oneCommit({ 'a\0.ts': { kind: 'file', content: '' } })),
    ).toThrow(/empty segment or NUL/);
  });

  it('refuses a path that is both a file and a directory', () => {
    const file = { kind: 'file', content: '' } as const;
    expect(() => buildRepository(oneCommit({ a: file, 'a/b': file }))).toThrow(
      /both a file and a directory/,
    );
    expect(() => buildRepository(oneCommit({ 'a/b': file, a: file }))).toThrow(
      /both a file and a directory/,
    );
  });

  it('refuses a submodule commit that is not a SHA-1 object ID', () => {
    expect(() =>
      buildRepository(
        oneCommit({ lib: { kind: 'submodule', commit: 'HEAD' } }),
      ),
    ).toThrow(/not SHA-1/);
  });

  it('refuses bad refs and a missing default branch', () => {
    const file = { 'a.ts': { kind: 'file', content: '' } } as const;
    expect(() =>
      buildRepository(oneCommit(file, { 'refs/heads/main': 'missing' })),
    ).toThrow(/unknown commit/);
    expect(() =>
      buildRepository(oneCommit(file, { 'refs/heads/../x': 'c' })),
    ).toThrow(/invalid/);
    expect(() => buildRepository(oneCommit(file, { HEAD: 'c' }))).toThrow(
      /invalid/,
    );
    expect(() =>
      buildRepository(oneCommit(file, { 'refs/heads/other': 'c' })),
    ).toThrow(/default branch main has no ref/);
  });
});

// The written repositories must read correctly with the real Git, under the
// same locked-down environment the product uses. These calls are local and
// never reach a network.
