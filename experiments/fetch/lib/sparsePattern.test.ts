import { describe, expect, it } from 'vitest';
import {
  literalPathspec,
  sparseFileFor,
  sparsePatternFor,
} from './sparsePattern.ts';

describe('sparsePatternFor', () => {
  it.each([
    ['src/a.ts', '/src/a.ts'],
    ['src/we*ird.ts', '/src/we\\*ird.ts'],
    ['src/q?.ts', '/src/q\\?.ts'],
    ['src/[br].ts', '/src/\\[br\\].ts'],
    ['!bang.ts', '/\\!bang.ts'],
    ['#hash.ts', '/\\#hash.ts'],
    ['src/trailing.ts  ', '/src/trailing.ts\\ \\ '],
    ['src/sp ace.ts', '/src/sp ace.ts'],
    ['src/café.ts', '/src/café.ts'],
  ])('writes %j as %j', (path, pattern) => {
    expect(sparsePatternFor(path)).toEqual({ ok: true, pattern });
  });

  it.each(['src/new\nline.ts', '../escape.ts', '/abs.ts', 'a\\b.ts', ''])(
    'refuses %j',
    (path) => {
      expect(sparsePatternFor(path)).toEqual({
        ok: false,
        reason: 'invalid-path',
      });
    },
  );
});

describe('sparseFileFor', () => {
  it('writes one pattern per line and lists the refused paths', () => {
    expect(sparseFileFor(['a.ts', 'b\n.ts', 'c*.ts'])).toEqual({
      content: '/a.ts\n/c\\*.ts\n',
      refused: ['b\n.ts'],
    });
  });
});

describe('literalPathspec', () => {
  it('prefixes the literal magic', () => {
    expect(literalPathspec('src/*.ts')).toBe(':(literal)src/*.ts');
  });

  it('refuses an invalid path', () => {
    expect(() => literalPathspec('../x.ts')).toThrow();
  });
});
