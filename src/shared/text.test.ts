import { describe, expect, it } from 'vitest';
import { thrown } from '../../tests/support/thrown.ts';
import { boundedUtf8, maxControlCharacterRatio, stripAnsi } from './text.ts';
import { ValidationError } from './validation.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function rejectionCode(bytes: Uint8Array, limit: number): string {
  const error = thrown(() => boundedUtf8(bytes, limit));
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).code;
}

describe('boundedUtf8', () => {
  it('returns the exact text of valid UTF-8 within the limit', () => {
    const text = 'const café = "x";\r\n\tlet y = 1;\f\n';
    expect(boundedUtf8(encode(text), 1000)).toBe(text);
  });

  it('keeps a byte order mark', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    expect(boundedUtf8(bytes, 4)).toBe(`${String.fromCodePoint(0xfeff)}a`);
  });

  it('accepts content exactly at the limit and empty content', () => {
    expect(boundedUtf8(encode('abcd'), 4)).toBe('abcd');
    expect(boundedUtf8(new Uint8Array(), 0)).toBe('');
  });

  it('refuses content over the limit in bytes, not characters', () => {
    expect(rejectionCode(encode('abcde'), 4)).toBe('content-too-large');
    expect(rejectionCode(encode('éé'), 3)).toBe('content-too-large');
  });

  it('refuses a NUL byte as binary', () => {
    expect(rejectionCode(encode('text\u0000more'), 100)).toBe('binary-content');
  });

  it('refuses malformed UTF-8', () => {
    expect(rejectionCode(new Uint8Array([0x61, 0xff, 0x62]), 10)).toBe(
      'invalid-utf8',
    );
    // An overlong encoding of "/".
    expect(rejectionCode(new Uint8Array([0xc0, 0xaf]), 10)).toBe(
      'invalid-utf8',
    );
    // A truncated multi-byte sequence.
    expect(rejectionCode(new Uint8Array([0x61, 0xe2, 0x82]), 10)).toBe(
      'invalid-utf8',
    );
  });

  it('refuses control-heavy content and allows a few control characters', () => {
    const allowed = Math.floor(100 * maxControlCharacterRatio);
    const light = `${'\u001B'.repeat(allowed)}${'a'.repeat(100 - allowed)}`;
    expect(boundedUtf8(encode(light), 1000)).toBe(light);
    const heavy = `${'\u0007'.repeat(allowed + 1)}${'a'.repeat(99 - allowed)}`;
    expect(rejectionCode(encode(heavy), 1000)).toBe('control-heavy-content');
    expect(rejectionCode(encode('a\u007F\u0085b'), 1000)).toBe(
      'control-heavy-content',
    );
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses the limit %s',
    (limit) => {
      expect(() => boundedUtf8(encode('a'), limit)).toThrow(RangeError);
    },
  );
});

describe('stripAnsi', () => {
  it.each([
    ['SGR colors', '\u001B[31mred\u001B[0m', 'red'],
    ['cursor movement', 'a\u001B[2Kb\u001B[1A', 'ab'],
    ['private-mode CSI', '\u001B[?25lhidden', 'hidden'],
    ['an 8-bit CSI', '\u009B31mred', 'red'],
    ['an OSC title ended by BEL', '\u001B]0;owned\u0007text', 'text'],
    [
      'an OSC hyperlink ended by ST',
      '\u001B]8;;https://x.test\u001B\\link\u001B]8;;\u001B\\',
      'link',
    ],
    ['an 8-bit OSC', '\u009D0;title\u009Ctext', 'text'],
    ['a DCS string', '\u001BPq#0;2;0;0;0\u001B\\after', 'after'],
    ['an APC string', '\u001B_payload\u001B\\after', 'after'],
    ['a two-character escape', 'a\u001BMb\u001Bcc', 'abc'],
    ['a character-set selection', '\u001B(Bplain', 'plain'],
    ['a stray escape', 'a\u001B', 'a'],
    ['a stray C1 control', `a${String.fromCodePoint(0x9b)}`, 'a'],
  ])('removes %s', (_label, input, expected) => {
    expect(stripAnsi(input)).toBe(expected);
  });

  it('keeps ordinary text, tabs, and line breaks', () => {
    const text = 'line 1\tcol\r\nline [2] ~ é';
    expect(stripAnsi(text)).toBe(text);
  });

  it('leaves no escape character behind in an unterminated OSC', () => {
    expect(stripAnsi('\u001B]0;title')).not.toContain('\u001B');
  });

  it('ends a string body at the next introducer', () => {
    expect(stripAnsi('\u009Dkept\u009Ddropped\u009Cafter')).toBe('keptafter');
    expect(stripAnsi('\u001B]kept\u0090dropped\u001B\\after')).toBe(
      'keptafter',
    );
  });
});
