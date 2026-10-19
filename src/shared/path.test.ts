import { describe, expect, it } from 'vitest';
import { thrown } from '../../tests/support/thrown.ts';
import {
  assertNoNormalizationCollisions,
  findNormalizationCollisions,
  maxRepoPathBytes,
  normalizeRepoPath,
} from './path.ts';
import { ValidationError } from './validation.ts';

const char = (codePoint: number): string => String.fromCodePoint(codePoint);
// "café" with a precomposed é (NFC) and with e plus a combining acute (NFD).
const cafeNfc = `caf${char(0xe9)}`;
const cafeNfd = `cafe${char(0x301)}`;

function rejection(path: unknown): ValidationError {
  const error = thrown(() => normalizeRepoPath(path));
  expect(error).toBeInstanceOf(ValidationError);
  return error as ValidationError;
}

describe('normalizeRepoPath', () => {
  it.each([
    'README.md',
    'src/index.ts',
    'src/a b/c d.ts',
    'src/.github-like/x.ts',
    'src/.gitignore',
    'src/.gitkeep',
    'docs/..notes.md',
    'name with $(shell) `meta` ; | & chars.ts',
    'Src/File.TS',
    `${cafeNfc}/menu.ts`,
    `${cafeNfd}/menu.ts`,
    'src/a:b.ts',
  ])('returns the valid path %j unchanged', (path) => {
    expect(normalizeRepoPath(path)).toBe(path);
  });

  it('keeps the exact Unicode form instead of normalizing it', () => {
    expect(normalizeRepoPath(cafeNfd)).toBe(cafeNfd);
    expect(normalizeRepoPath(cafeNfd)).not.toBe(cafeNfc);
  });

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a parent traversal', '../secret.ts'],
    ['a nested traversal', 'src/../../secret.ts'],
    ['a trailing traversal', 'src/..'],
    ['a current-directory segment', './src/a.ts'],
    ['a lone dot', '.'],
    ['an empty segment', 'src//a.ts'],
    ['a trailing slash', 'src/'],
    ['a NUL byte', 'src/a.ts\u0000.png'],
    ['a newline', 'src/a\nb.ts'],
    ['a carriage return', 'src/a\rb.ts'],
    ['a tab', 'src/a\tb.ts'],
    ['an escape character', 'src/\u001B[31ma.ts'],
    ['DEL', 'src/a\u007F.ts'],
    ['a C1 control', `src/a${char(0x85)}.ts`],
    ['a backslash separator', 'src\\a.ts'],
    ['a backslash traversal', '..\\secret.ts'],
    ['a UNC path', '\\\\server\\share\\a.ts'],
    ['a drive-absolute path', 'C:/Windows/a.ts'],
    ['a drive-relative path', 'c:secret.ts'],
    ['a right-to-left override', `src/a${char(0x202e)}st.ts`],
    ['a left-to-right isolate', `src/a${char(0x2066)}.ts`],
    ['an Arabic letter mark', `src/a${char(0x61c)}.ts`],
    ['an unpaired surrogate', 'src/a\uD800.ts'],
    ['the .git directory', '.git/config'],
    ['a nested .git directory', 'vendor/.git/hooks/pre-commit'],
    ['.git in another case', '.GiT/config'],
    ['.git with a trailing dot', '.git./config'],
    ['.git with a trailing space', '.git /config'],
    ['the NTFS short name of .git', 'GIT~1/config'],
    ['.git with an NTFS stream suffix', '.git::$INDEX_ALLOCATION/config'],
    ['.git with a named stream', 'sub/.GIT:stream/config'],
    ['a zero-width non-joiner HFS+ ignores', `.${char(0x200c)}git/config`],
    ['a zero-width joiner', `src/a${char(0x200d)}.ts`],
    ['a deprecated format character', `src/a${char(0x206a)}.ts`],
    ['a byte order mark', `${char(0xfeff)}src/a.ts`],
  ])('refuses %s', (_label, path) => {
    expect(rejection(path).code).toBe('invalid-path');
  });

  it('refuses the empty string and non-strings', () => {
    expect(rejection('').code).toBe('invalid-path');
    expect(rejection(undefined).code).toBe('invalid-path');
    expect(rejection(42).code).toBe('invalid-path');
  });

  it('measures the length limit in UTF-8 bytes', () => {
    const ascii = 'a'.repeat(maxRepoPathBytes);
    expect(normalizeRepoPath(ascii)).toBe(ascii);
    expect(rejection(`${ascii}b`).code).toBe('invalid-path');
    // 2,048 two-byte characters fill the limit; one more ASCII byte exceeds it.
    const wide = char(0xe9).repeat(maxRepoPathBytes / 2);
    expect(normalizeRepoPath(wide)).toBe(wide);
    expect(rejection(`${wide}a`).code).toBe('invalid-path');
  });

  it('does not echo the rejected path in the message', () => {
    expect(rejection('../private-name.ts').message).not.toContain(
      'private-name',
    );
  });
});

describe('findNormalizationCollisions', () => {
  it('finds files that differ only by Unicode normalization', () => {
    expect(
      findNormalizationCollisions([`src/${cafeNfc}.ts`, `src/${cafeNfd}.ts`]),
    ).toEqual([[`src/${cafeNfc}.ts`, `src/${cafeNfd}.ts`].sort()]);
  });

  it('finds directories that differ only by normalization', () => {
    expect(
      findNormalizationCollisions([`${cafeNfc}/a.ts`, `${cafeNfd}/b.ts`]),
    ).toEqual([[cafeNfc, cafeNfd].sort()]);
  });

  it('reports nothing for distinct or repeated exact paths', () => {
    expect(
      findNormalizationCollisions([
        'src/a.ts',
        'src/a.ts',
        'src/b.ts',
        `${cafeNfd}/a.ts`,
        `${cafeNfd}/b.ts`,
      ]),
    ).toEqual([]);
  });

  it('does not fold case', () => {
    expect(findNormalizationCollisions(['src/A.ts', 'src/a.ts'])).toEqual([]);
  });

  it('orders groups by their first name', () => {
    const groups = findNormalizationCollisions([
      `z/${cafeNfd}`,
      `z/${cafeNfc}`,
      `a/${cafeNfc}`,
      `a/${cafeNfd}`,
    ]);
    expect(groups.map((group) => group[0]?.slice(0, 1))).toEqual(['a', 'z']);
  });

  it('validates every path', () => {
    expect(
      (
        thrown(() =>
          findNormalizationCollisions(['ok.ts', '../x.ts']),
        ) as ValidationError
      ).code,
    ).toBe('invalid-path');
  });
});

describe('assertNoNormalizationCollisions', () => {
  it('passes distinct paths', () => {
    expect(() =>
      assertNoNormalizationCollisions(['src/a.ts', 'src/b.ts']),
    ).not.toThrow();
  });

  it('throws for a collision without naming the paths', () => {
    const error = thrown(() =>
      assertNoNormalizationCollisions([cafeNfc, cafeNfd]),
    ) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('path-normalization-collision');
    expect(error.message).not.toContain('caf');
  });
});
