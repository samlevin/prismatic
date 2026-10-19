// Adversarial model output for AntiSlopFormatter. A prompt injection in
// reviewed code can steer what the model writes, so the formatter must stay
// linear on hostile shapes and must never rewrite code it quotes. The fixture
// corpus in #139 will supply more of these; until then the cases are listed
// here.
import { describe, expect, it } from 'vitest';
import { AntiSlopFormatter } from '../../src/presentation/AntiSlopFormatter.ts';

const formatter = new AntiSlopFormatter();
const size = 200_000;

describe('hostile shapes finish quickly', () => {
  it.each([
    [
      'backtick runs of growing length',
      () => {
        let text = '';
        for (let length = 1; text.length < size; length += 1) {
          text += `${'`'.repeat(length)} x `;
        }
        return text;
      },
    ],
    ['unmatched single backticks', () => '` really '.repeat(size / 10)],
    ['unclosed fences', () => '```\nx\n'.repeat(size / 6)],
    [
      'spaces around em dashes',
      () => `a${' '.repeat(size)}—${' '.repeat(size)}b`,
    ],
    ['em dashes only', () => '—'.repeat(size)],
    [
      'unspaced em dashes in one long token',
      () => `${'ab—'.repeat(size / 3)}1`,
    ],
    [
      'long tokens around one em dash',
      () => `${'a'.repeat(size)}—${'b'.repeat(size)}`,
    ],
    ['chained openers', () => 'Honestly, '.repeat(size / 10)],
    ['sentence ends', () => '. '.repeat(size / 2)],
    ['filler sentences', () => 'Great job! '.repeat(size / 11)],
    ['bare capital I', () => 'I '.repeat(size / 2)],
    ['first-person pronouns', () => 'I think '.repeat(size / 8)],
    ['emoji', () => '🚀'.repeat(size / 2)],
    ['phrase prefixes', () => "Here's the ".repeat(size / 11)],
  ])('%s', (_label, build) => {
    const text = build();
    const started = performance.now();
    formatter.assertStyle(text);
    formatter.assertStyle(formatter.format(text));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('quoted code is never rewritten', () => {
  it.each([
    [
      'an injected instruction in a code span',
      'Hint: run `rm -rf / — Great job!` now.',
      'run `rm -rf / — Great job!` now.',
    ],
    [
      'a code span spanning lines',
      'Honestly, `a\nHint: b—c` ok',
      '`a\nHint: b—c` ok',
    ],
    [
      'a fence inside a list item',
      '- Hint: see\n  ```\n  Great job! a—b\n  ```',
      '- see\n  ```\n  Great job! a—b\n  ```',
    ],
    ['a tilde fence', '~~~\nHonestly, x — y\n~~~', '~~~\nHonestly, x — y\n~~~'],
  ])('%s', (_label, input, expected) => {
    expect(formatter.format(input)).toBe(expected);
  });
});

describe('unusual text passes through', () => {
  it.each([
    ['an unpaired surrogate', 'Honestly, a\uD800—b', 'a\uD800—b'],
    [
      'control characters',
      'Hint: \u0007bell — x\u001B[2J',
      '\u0007bell, x\u001B[2J',
    ],
    ['a zero-width joiner', 'a\u200D—b', 'a\u200D—b'],
    ['an empty string', '', ''],
  ])('%s', (_label, input, expected) => {
    expect(formatter.format(input)).toBe(expected);
  });
});
