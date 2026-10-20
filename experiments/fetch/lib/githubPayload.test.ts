import { describe, expect, it } from 'vitest';
import { addTreeSizes, field, sha } from './githubPayload.ts';

describe('field', () => {
  it('follows a key path through objects', () => {
    expect(field({ head: { sha: 'x' } }, 'head', 'sha')).toBe('x');
  });

  it('returns undefined when the path leaves the objects', () => {
    expect(field({ head: null }, 'head', 'sha')).toBeUndefined();
    expect(field('text', 'length')).toBeUndefined();
    expect(field({}, 'head')).toBeUndefined();
  });
});

describe('sha', () => {
  it('accepts a 40-character lowercase hex ID', () => {
    expect(sha('a'.repeat(40), 'head SHA')).toBe('a'.repeat(40));
  });

  it.each([
    undefined,
    7,
    'A'.repeat(40),
    'a'.repeat(39),
    `${'a'.repeat(40)}\n`,
  ])('refuses %j', (value) => {
    expect(() => sha(value, 'head SHA')).toThrow(
      'GitHub returned no valid head SHA.',
    );
  });
});

describe('addTreeSizes', () => {
  it('adds blob sizes and skips other or malformed entries', () => {
    const sizes = new Map([['0'.repeat(40), 1]]);
    const truncated = addTreeSizes(
      {
        tree: [
          { type: 'blob', sha: 'a'.repeat(40), size: 10 },
          { type: 'tree', sha: 'b'.repeat(40) },
          { type: 'commit', sha: 'c'.repeat(40), size: 3 },
          { type: 'blob', sha: 'd'.repeat(40), size: '4' },
          { type: 'blob', size: 5 },
          null,
        ],
        truncated: false,
      },
      sizes,
    );
    expect(truncated).toBe(false);
    expect([...sizes]).toEqual([
      ['0'.repeat(40), 1],
      ['a'.repeat(40), 10],
    ]);
  });

  it('reports a truncated response', () => {
    expect(addTreeSizes({ tree: [], truncated: true }, new Map())).toBe(true);
  });

  it('adds nothing from a response without a tree', () => {
    const sizes = new Map<string, number>();
    expect(addTreeSizes({ message: 'Not Found' }, sizes)).toBe(false);
    expect(sizes.size).toBe(0);
  });
});
