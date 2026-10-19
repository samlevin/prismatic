import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { securityScenario } from '../../evals/fixtures/security/scenarios.ts';
import type { FixtureRepository } from '../../evals/fixtures/security/types.ts';
import {
  buildRepository,
  encodeObject,
  writeBareRepository,
} from './fixtureRepository.ts';

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
describe('writeBareRepository with real Git', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'prism-fixture-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const git = (gitDir: string, ...args: string[]): string =>
    execFileSync('git', ['--git-dir', gitDir, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    });

  const write = (id: string) => {
    const built = buildRepository(securityScenario(id).repository);
    const gitDir = path.join(directory, id);
    writeBareRepository(gitDir, built);
    return { built, gitDir };
  };

  it('writes a history Git reads and verifies', () => {
    const { built, gitDir } = write('diverged-head');
    expect(git(gitDir, 'fsck', '--strict', '--no-dangling')).toBe('');
    expect(git(gitDir, 'rev-parse', 'HEAD').trim()).toBe(
      built.commits['base-tip'],
    );
    expect(
      git(gitDir, 'merge-base', 'refs/heads/main', 'refs/pull/114/head').trim(),
    ).toBe(built.commits['fork-point']);
    // The two-dot comparison from the base tip is the wrong one: it reports
    // main-only changes as if the pull request made them.
    expect(
      git(
        gitDir,
        'diff',
        '--name-only',
        'refs/heads/main',
        'refs/pull/114/head',
      ),
    ).toBe('src/math.ts\nsrc/new-on-main.ts\nsrc/util.ts\n');
    expect(
      git(
        gitDir,
        'diff',
        '--name-only',
        'refs/heads/main...refs/pull/114/head',
      ),
    ).toBe('src/math.ts\n');
  });

  it('stores symlinks, gitlinks, and executables with their Git modes', () => {
    const { gitDir } = write('git-config-and-filters');
    expect(
      git(gitDir, 'ls-tree', 'refs/pull/109/head', '.githooks/post-checkout'),
    ).toMatch(/^100755 blob /);
    const links = write('symlink-chains').gitDir;
    expect(
      git(links, 'ls-tree', 'refs/pull/101/head', 'src/loop-a.ts'),
    ).toMatch(/^120000 blob /);
    expect(
      git(links, 'cat-file', '-p', 'refs/pull/101/head:src/escape.ts'),
    ).toBe('../../../../etc/passwd');
    const modules = write('submodule').gitDir;
    expect(git(modules, 'ls-tree', 'refs/pull/108/head', 'vendor/lib')).toMatch(
      /^160000 commit /,
    );
  });

  it('keeps hostile tree entry names exactly as written', () => {
    const { gitDir } = write('hostile-names');
    const names = git(
      gitDir,
      '-c',
      'core.quotePath=false',
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      'refs/pull/105/head',
    )
      .split('\0')
      .filter(Boolean);
    expect(names).toContain('src/../../escape.ts');
    expect(names).toContain('../outside.ts');
    expect(names).toContain('src/line\nbreak.ts');
    expect(names).toContain(
      `src/cafe${String.fromCodePoint(0x301)}/handler.ts`,
    );
    expect(names).toContain(`src/caf${String.fromCodePoint(0xe9)}/handler.ts`);
  });
});
