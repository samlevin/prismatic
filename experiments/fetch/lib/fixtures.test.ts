import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fastImportPath,
  fastImportStream,
  seededContent,
  sourceText,
} from './fixtures.ts';
import type { FixtureCommit, StreamedContent } from './fixtures.ts';

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('fastImportPath', () => {
  it.each([
    ['src/a.ts', 'src/a.ts'],
    ['src/sp ace.ts', 'src/sp ace.ts'],
    ['src/we*ird.ts', 'src/we*ird.ts'],
    ['src/trailing.ts ', '"src/trailing.ts "'],
    [' leading.ts', '" leading.ts"'],
    ['src/"q".ts', '"src/\\"q\\".ts"'],
    ['src/back\\slash.ts', '"src/back\\\\slash.ts"'],
    ['src/new\nline.ts', '"src/new\\012line.ts"'],
    ['src/café.ts', '"src/caf\\303\\251.ts"'],
  ])('writes %j as %j', (path, expected) => {
    expect(fastImportPath(path)).toBe(expected);
  });

  it('keeps bytes that are not UTF-8 exact', () => {
    expect(fastImportPath(Buffer.from([0x61, 0xff]))).toBe('"a\\377"');
  });
});

describe('fastImportStream', () => {
  it('writes commits with marks, parents and every kind of change', async () => {
    const streamed: StreamedContent = {
      length: 3,
      async *chunks() {
        yield Buffer.from('ab');
        yield Buffer.from('c');
      },
    };
    const commits: FixtureCommit[] = [
      {
        mark: 1,
        ref: 'refs/heads/main',
        parents: [],
        message: 'root',
        changes: [
          { path: 'a.ts', content: 'A' },
          { path: 'bin/x', mode: '100755', content: Buffer.from('X') },
          { path: 'big.bin', content: streamed },
          { path: 'link', mode: '120000', content: 'a.ts' },
          { path: 'sub', gitlink: '1'.repeat(40) },
        ],
      },
      {
        mark: 2,
        ref: 'refs/heads/main',
        parents: [1, 3],
        message: 'merge',
        changes: [{ path: 'a.ts', deleted: true }],
      },
    ];
    const text = (await collect(fastImportStream(commits))).toString();
    expect(text).toBe(
      [
        'commit refs/heads/main',
        'mark :1',
        'author Prismatic Spike <spike@example.invalid> 1700000001 +0000',
        'committer Prismatic Spike <spike@example.invalid> 1700000001 +0000',
        'data 4',
        'root',
        'deleteall',
        'M 100644 inline a.ts',
        'data 1',
        'A',
        'M 100755 inline bin/x',
        'data 1',
        'X',
        'M 100644 inline big.bin',
        'data 3',
        'abc',
        'M 120000 inline link',
        'data 4',
        'a.ts',
        `M 160000 ${'1'.repeat(40)} sub`,
        '',
        'commit refs/heads/main',
        'mark :2',
        'author Prismatic Spike <spike@example.invalid> 1700000002 +0000',
        'committer Prismatic Spike <spike@example.invalid> 1700000002 +0000',
        'data 5',
        'merge',
        'from :1',
        'merge :3',
        'D a.ts',
        '',
        'done',
        '',
      ].join('\n'),
    );
  });

  it('refuses streamed content of the wrong length', async () => {
    const short: StreamedContent = {
      length: 5,
      async *chunks() {
        yield Buffer.from('abc');
      },
    };
    await expect(
      collect(
        fastImportStream([
          {
            mark: 1,
            ref: 'refs/heads/main',
            parents: [],
            message: 'm',
            changes: [{ path: 'x', content: short }],
          },
        ]),
      ),
    ).rejects.toThrow(/wrong length/);
  });
});

describe('seededContent', () => {
  it('is deterministic, seed-specific and exactly the requested length', async () => {
    const length = 2 * 1024 * 1024 + 7;
    const first = await collect(seededContent('seed', length).chunks());
    const again = await collect(seededContent('seed', length).chunks());
    const other = await collect(seededContent('other', length).chunks());
    expect(first.length).toBe(length);
    expect(first.equals(again)).toBe(true);
    expect(first.equals(other)).toBe(false);
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      createHash('sha256').update(again).digest('hex'),
    );
  });

  it('yields nothing for zero bytes', async () => {
    expect((await collect(seededContent('seed', 0).chunks())).length).toBe(0);
  });
});

describe('sourceText', () => {
  it('produces distinct source of at least the requested size', () => {
    const text = sourceText('mod-1', 500);
    expect(text.length).toBeGreaterThanOrEqual(500);
    expect(text.startsWith('// mod-1\n')).toBe(true);
    expect(text).toContain('export const mod_1_0 = 0;');
    expect(sourceText('mod-2', 500)).not.toBe(text);
  });
});
