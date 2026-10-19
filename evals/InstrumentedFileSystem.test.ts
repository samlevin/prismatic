import { describe, expect, it } from 'vitest';
import {
  FileSystemError,
  InstrumentedFileSystem,
  lexicalPath,
  maxSymlinkHops,
} from './InstrumentedFileSystem.ts';

const file = (content: string, executable = false) =>
  ({ kind: 'file', content, executable }) as const;
const link = (target: string) => ({ kind: 'symlink', target }) as const;

const fixture = () =>
  new InstrumentedFileSystem(
    {
      '.env': file('SECRET=1'),
      'src/index.ts': file('export {};'),
      'src/run.sh': file('#!/bin/sh', true),
      'src/bytes.bin': { kind: 'file', content: new Uint8Array([0, 1, 2]) },
      'src/chain-1.ts': link('chain-2.ts'),
      'src/chain-2.ts': link('../.env'),
      'src/escape.ts': link('../../etc/passwd'),
      'src/absolute.ts': link('/etc/passwd'),
      'src/loop-a.ts': link('loop-b.ts'),
      'src/loop-b.ts': link('loop-a.ts'),
      'src/root': link('..'),
      'src/dangling.ts': link('missing.ts'),
      'vendor/lib': { kind: 'submodule', commit: 'a'.repeat(40) },
      'src/../outside.ts': file('x'),
      'nul\0.ts': file('x'),
    },
    { hostFiles: { '/etc/passwd': 'root:x:0:0' } },
  );

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FileSystemError) return error.code;
    throw error;
  }
  return 'ok';
};

describe('lexicalPath', () => {
  it('collapses dot segments without leaving the root', () => {
    expect(lexicalPath('a/./b/../c', '/repo')).toBe('/repo/a/c');
    expect(lexicalPath('/../../etc//passwd')).toBe('/etc/passwd');
    expect(lexicalPath('')).toBe('/');
  });
});

describe('InstrumentedFileSystem', () => {
  it('reads files relative to the root and records the real path', async () => {
    const fs = fixture();
    expect(new TextDecoder().decode(await fs.readFile('src/index.ts'))).toBe(
      'export {};',
    );
    expect(await fs.readFile('/repo/src/bytes.bin')).toEqual(
      new Uint8Array([0, 1, 2]),
    );
    expect(fs.accesses[0]).toEqual({
      operation: 'readFile',
      path: 'src/index.ts',
      resolved: '/repo/src/index.ts',
      content: true,
    });
  });

  it('follows symlink chains, escapes, and absolute targets like the kernel', async () => {
    const fs = fixture();
    await fs.readFile('src/chain-1.ts');
    await fs.readFile('src/escape.ts');
    await fs.readFile('src/absolute.ts');
    await fs.readFile('src/root/src/root/.env');
    expect(fs.accesses.map((access) => access.resolved)).toEqual([
      '/repo/.env',
      '/etc/passwd',
      '/etc/passwd',
      '/repo/.env',
    ]);
    expect(await fs.realpath('src/root')).toBe('/repo');
  });

  it('fails a symlink loop with ELOOP after the kernel limit', async () => {
    const fs = fixture();
    expect(await code(fs.readFile('src/loop-a.ts'))).toBe('ELOOP');
    expect(maxSymlinkHops).toBe(40);
    expect(fs.accesses.at(-1)).toMatchObject({ resolved: null, content: true });
  });

  it('refuses to follow a final symlink when asked not to, as O_NOFOLLOW does', async () => {
    const fs = fixture();
    expect(await code(fs.readFile('src/chain-1.ts', { noFollow: true }))).toBe(
      'ELOOP',
    );
    expect(await fs.readFile('src/index.ts', { noFollow: true })).toBeDefined();
  });

  it('reports missing paths, directories, and invalid names', async () => {
    const fs = fixture();
    expect(await code(fs.readFile('src/missing.ts'))).toBe('ENOENT');
    expect(await code(fs.readFile('src/dangling.ts'))).toBe('ENOENT');
    expect(await code(fs.readFile('src'))).toBe('EISDIR');
    expect(await code(fs.readFile('src/index.ts/x'))).toBe('ENOTDIR');
    expect(await code(fs.readFile(''))).toBe('ENOENT');
    expect(await code(fs.readFile('nul\0.ts'))).toBe('EINVAL');
    expect(await code(fs.readlink('src/index.ts'))).toBe('EINVAL');
    expect(await code(fs.readdir('src/index.ts'))).toBe('ENOTDIR');
  });

  it('does not mount names no filesystem can hold', async () => {
    const fs = fixture();
    expect(fs.unmounted).toEqual(['nul\0.ts', 'src/../outside.ts']);
    expect(await code(fs.readFile('outside.ts'))).toBe('ENOENT');
  });

  it('answers metadata calls without counting them as content reads', async () => {
    const fs = fixture();
    expect(await fs.lstat('src/chain-1.ts')).toEqual({
      type: 'symlink',
      size: 'chain-2.ts'.length,
      executable: false,
    });
    expect(await fs.stat('src/chain-1.ts')).toEqual({
      type: 'file',
      size: 'SECRET=1'.length,
      executable: false,
    });
    expect(await fs.stat('src/run.sh')).toMatchObject({ executable: true });
    expect(await fs.stat('vendor/lib')).toEqual({
      type: 'directory',
      size: 0,
      executable: false,
    });
    expect(await fs.readlink('src/chain-1.ts')).toBe('chain-2.ts');
    expect(await fs.readdir('/')).toEqual(['etc', 'repo']);
    expect(await fs.readdir('vendor/lib')).toEqual([]);
    expect(fs.accesses.every((access) => !access.content)).toBe(true);
  });

  it('returns copies, so a caller cannot change the fixture', async () => {
    const fs = fixture();
    const bytes = await fs.readFile('src/bytes.bin');
    bytes[0] = 9;
    expect((await fs.readFile('src/bytes.bin'))[0]).toBe(0);
  });

  it('refuses a tree that puts a file where a directory goes', () => {
    expect(
      () =>
        new InstrumentedFileSystem({
          a: file('x'),
          'a/b': file('y'),
        }),
    ).toThrow(/Cannot mount below the file/);
  });

  it('mounts at a chosen root', async () => {
    const fs = new InstrumentedFileSystem(
      { 'a.ts': file('x') },
      { root: '/work/./tree/' },
    );
    expect(fs.root).toBe('/work/tree');
    expect(await fs.realpath('a.ts')).toBe('/work/tree/a.ts');
  });
});
