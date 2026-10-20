import { describe, expect, it } from 'vitest';
import { parseCatFileBatch } from './catFile.ts';

const oid = (digit: string): string => digit.repeat(40);

describe('parseCatFileBatch', () => {
  it('splits objects by their declared size, newlines in content included', () => {
    const output = Buffer.concat([
      Buffer.from(`${oid('a')} blob 5\nab\ncd\n`),
      Buffer.from(`${oid('b')} blob 0\n\n`),
      Buffer.from(`${oid('c')} blob 3\n`),
      Buffer.from([0, 255, 10]),
      Buffer.from('\n'),
    ]);
    const blobs = parseCatFileBatch(output);
    expect([...blobs.keys()]).toEqual([oid('a'), oid('b'), oid('c')]);
    expect(blobs.get(oid('a'))?.toString()).toBe('ab\ncd');
    expect(blobs.get(oid('b'))?.length).toBe(0);
    expect([...(blobs.get(oid('c')) ?? [])]).toEqual([0, 255, 10]);
  });

  it('returns nothing for empty output', () => {
    expect(parseCatFileBatch(Buffer.alloc(0)).size).toBe(0);
  });

  it.each([`${oid('a')} missing\n`, `${oid('a')} tree 3\nabc\n`])(
    'refuses the header in %j',
    (text) => {
      expect(() => parseCatFileBatch(Buffer.from(text))).toThrow(
        /Unexpected cat-file header/,
      );
    },
  );
});
