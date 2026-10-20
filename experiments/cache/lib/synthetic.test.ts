import { describe, expect, test } from 'vitest';
import {
  editSource,
  gitBlobId,
  seededRandom,
  syntheticFile,
  syntheticProse,
  syntheticSha,
  syntheticSource,
} from './synthetic.ts';

describe('seededRandom', () => {
  test('repeats its sequence for a seed and stays in [0, 1)', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const values = Array.from({ length: 50 }, () => a());
    expect(values).toEqual(Array.from({ length: 50 }, () => b()));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(seededRandom(8)()).not.toBe(values[0]);
  });
});

describe('gitBlobId', () => {
  test('matches git hash-object', () => {
    expect(gitBlobId('hello\n')).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
    expect(gitBlobId('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});

describe('syntheticSource', () => {
  test('is deterministic, LF-terminated, and has the requested functions', () => {
    const file = syntheticSource('src/a.ts', 3, 5);
    expect(syntheticSource('src/a.ts', 3, 5)).toEqual(file);
    expect(file.text.endsWith('\n')).toBe(true);
    expect(file.text).not.toContain('\r');
    expect(file.text.match(/^export function /gm)).toHaveLength(5);
    expect(file.blobId).toBe(gitBlobId(file.text));
    expect(syntheticSource('src/a.ts', 4, 5).text).not.toBe(file.text);
  });
});

describe('editSource', () => {
  const file = syntheticSource('src/a.ts', 3, 10);
  const changed = (edited: string): number[] => {
    const before = file.text.split('\n');
    return edited
      .split('\n')
      .flatMap((line, i) => (line === before[i] ? [] : [i]));
  };

  test('changes exactly one line, early or late by fraction', () => {
    const early = editSource(file, 0, 'x');
    const late = editSource(file, 1, 'x');
    expect(changed(early.text)).toHaveLength(1);
    expect(changed(late.text)).toHaveLength(1);
    expect(changed(early.text)[0]).toBeLessThan(changed(late.text)[0] ?? 0);
    expect(early.blobId).not.toBe(file.blobId);
    expect(early.text.endsWith('\n')).toBe(true);
  });

  test('clamps the fraction', () => {
    expect(editSource(file, -3, 'x')).toEqual(editSource(file, 0, 'x'));
    expect(editSource(file, 9, 'x')).toEqual(editSource(file, 1, 'x'));
  });

  test('refuses a file with no editable line', () => {
    expect(() => editSource(syntheticFile('a.md', 'prose\n'), 0, 'x')).toThrow(
      RangeError,
    );
  });
});

describe('syntheticProse and syntheticSha', () => {
  test('prose has the requested paragraphs and repeats per seed', () => {
    const prose = syntheticProse(1, 3);
    expect(prose.trimEnd().split('\n\n')).toHaveLength(3);
    expect(syntheticProse(1, 3)).toBe(prose);
  });

  test('a SHA stand-in is 40 hex characters and label-specific', () => {
    expect(syntheticSha('a')).toMatch(/^[0-9a-f]{40}$/);
    expect(syntheticSha('a')).not.toBe(syntheticSha('b'));
  });
});
