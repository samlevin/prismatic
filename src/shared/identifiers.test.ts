import { describe, expect, it } from 'vitest';
import { thrown } from '../../tests/support/thrown.ts';
import { isSha, parseSha } from './identifiers.ts';
import { ValidationError } from './validation.ts';

const sha1 = '0123456789abcdef0123456789abcdef01234567';
const sha256 = `${sha1}0123456789abcdef01234567`;

describe('parseSha', () => {
  it('accepts full SHA-1 and SHA-256 object names unchanged', () => {
    expect(parseSha(sha1)).toBe(sha1);
    expect(parseSha(sha256)).toBe(sha256);
    expect(isSha(sha1)).toBe(true);
  });

  it.each([
    ['an abbreviated name', sha1.slice(0, 12)],
    ['uppercase digits', sha1.toUpperCase()],
    ['a trailing newline', `${sha1}\n`],
    ['surrounding spaces', ` ${sha1} `],
    ['a length between the two formats', `${sha1}00`],
    ['a non-hex digit', `${sha1.slice(0, 39)}g`],
    ['the empty string', ''],
    ['a ref name', 'refs/heads/main'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 40],
    ['an object', { sha: sha1 }],
  ])('refuses %s', (_label, input) => {
    const error = thrown(() => parseSha(input));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ code: 'invalid-sha' });
    expect(isSha(input)).toBe(false);
  });

  it('does not echo the rejected input in the message', () => {
    const error = thrown(() => parseSha('not-a-sha-value')) as Error;
    expect(error.message).not.toContain('not-a-sha-value');
  });
});
