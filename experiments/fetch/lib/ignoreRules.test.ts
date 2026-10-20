import { describe, expect, it } from 'vitest';
import type { TreeEntry } from './inventory.ts';
import {
  ignoreFileMaxBytes,
  parseCheckIgnore,
  selectIgnoreFiles,
} from './ignoreRules.ts';

const entry = (
  path: string,
  digit: string,
  overrides: Partial<TreeEntry> = {},
): TreeEntry => ({
  path,
  mode: '100644',
  type: 'blob',
  oid: digit.repeat(40),
  ...overrides,
});

describe('selectIgnoreFiles', () => {
  const sizes = new Map([
    ['1'.repeat(40), 10],
    ['2'.repeat(40), 20],
    ['3'.repeat(40), ignoreFileMaxBytes],
    ['4'.repeat(40), ignoreFileMaxBytes + 1],
    ['5'.repeat(40), 5],
    ['6'.repeat(40), 6],
  ]);
  const sizeOf = (oid: string) => sizes.get(oid);

  it('admits bounded regular .gitignore blobs at any depth', () => {
    const files = selectIgnoreFiles(
      [
        entry('.gitignore', '1'),
        entry('src/app.ts', '2'),
        entry('src/.gitignore', '3'),
        entry('src/not.gitignore', '5'),
      ],
      sizeOf,
    );
    expect(files.admitted.map((e) => e.path)).toEqual([
      '.gitignore',
      'src/.gitignore',
    ]);
    expect(files.refused).toEqual([]);
  });

  it('refuses oversized, unsized, executable and symlinked rules files', () => {
    const files = selectIgnoreFiles(
      [
        entry('big/.gitignore', '4'),
        entry('unsized/.gitignore', '7'),
        entry('exec/.gitignore', '5', { mode: '100755' }),
        entry('link/.gitignore', '6', { mode: '120000' }),
      ],
      sizeOf,
    );
    expect(files.admitted).toEqual([]);
    expect(files.refused.map((e) => e.path)).toEqual([
      'big/.gitignore',
      'unsized/.gitignore',
      'exec/.gitignore',
      'link/.gitignore',
    ]);
  });

  it('skips a directory or submodule named .gitignore', () => {
    const files = selectIgnoreFiles(
      [
        entry('a/.gitignore', '1', { type: 'tree', mode: '040000' }),
        entry('b/.gitignore', '1', { type: 'commit', mode: '160000' }),
      ],
      sizeOf,
    );
    expect(files).toEqual({ admitted: [], refused: [] });
  });
});

describe('parseCheckIgnore', () => {
  it('returns the NUL-separated paths', () => {
    expect(
      parseCheckIgnore(Buffer.from('src/a.ts\0src/sp ace.ts\0src/café.ts\0')),
    ).toEqual(['src/a.ts', 'src/sp ace.ts', 'src/café.ts']);
  });

  it('returns nothing when nothing is ignored', () => {
    expect(parseCheckIgnore(Buffer.alloc(0))).toEqual([]);
  });
});
