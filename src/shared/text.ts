// Untrusted text. boundedUtf8 decides whether bytes are text at all before
// anything reads them as text; stripAnsi removes terminal escape sequences so
// logged text cannot move the cursor, rewrite earlier lines, retitle the
// terminal, or plant hyperlinks.
import { ValidationError } from './validation.ts';

// Content where more than this share of characters are control characters
// other than tab, line feed, form feed, and carriage return is not treated
// as text.
export const maxControlCharacterRatio = 0.1;

// Decodes bytes as strict UTF-8 and returns the exact text, byte order mark
// included. Refuses content longer than `limit` bytes, content with a NUL byte
// (Git's own binary test), malformed UTF-8, and control-heavy content.
export function boundedUtf8(bytes: Uint8Array, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('limit must be a non-negative safe integer.');
  }
  if (bytes.byteLength > limit) {
    throw new ValidationError(
      'content-too-large',
      `Content exceeds the ${limit}-byte limit.`,
    );
  }
  if (bytes.includes(0)) {
    throw new ValidationError('binary-content', 'Content contains a NUL byte.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ValidationError('invalid-utf8', 'Content is not valid UTF-8.');
  }
  let characters = 0;
  let controls = 0;
  for (const character of text) {
    characters += 1;
    if (isDisallowedControl(character.codePointAt(0) ?? 0)) controls += 1;
  }
  if (controls > characters * maxControlCharacterRatio) {
    throw new ValidationError(
      'control-heavy-content',
      'Content has too many control characters to be text.',
    );
  }
  return text;
}

function isDisallowedControl(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a) return false;
  if (codePoint === 0x0c || codePoint === 0x0d) return false;
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

// ECMA-48 sequences in their 7-bit (ESC-prefixed) and 8-bit (C1) forms:
// string controls (OSC, DCS, SOS, PM, APC) up to their terminator, control
// sequences (CSI) up to their final byte, and the remaining escape sequences.
// A string body stops at the next introducer as well as at a terminator, so
// unterminated introducers each scan only up to the next one and the whole
// replacement stays linear.
const escapeSequences = new RegExp(
  [
    '(?:\\u001B[\\]PX^_]|[\\u0090\\u0098\\u009D\\u009E\\u009F])[^\\u0007\\u001B\\u0090\\u0098\\u009C-\\u009F]*(?:\\u0007|\\u001B\\\\|\\u009C)',
    '(?:\\u001B\\[|\\u009B)[\\u0030-\\u003F]*[\\u0020-\\u002F]*[\\u0040-\\u007E]',
    '\\u001B[\\u0020-\\u002F]*[\\u0030-\\u007E]',
  ].join('|'),
  'g',
);

// An escape or C1 control left over from a truncated or malformed sequence.
// eslint-disable-next-line no-control-regex -- control characters are the point
const strayControls = /[\u001B\u0080-\u009F]/g;

// Removes terminal escape sequences, then any escape or C1 control character
// a malformed sequence left behind. Other text, including tabs and line
// breaks, is kept.
export function stripAnsi(text: string): string {
  return text.replace(escapeSequences, '').replace(strayControls, '');
}
