import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AntiSlopFormatter,
  stylePhrases,
  type StyleRule,
} from './AntiSlopFormatter.ts';

const formatter = new AntiSlopFormatter();
const format = (text: string): string => formatter.format(text);
const rules = (text: string): StyleRule[] =>
  formatter.assertStyle(text).map((violation) => violation.rule);

describe('format: em dashes', () => {
  it.each([
    ['joins two words with a comma', 'retries—each one', 'retries, each one'],
    ['drops the spaces around it', 'retries — each one', 'retries, each one'],
    [
      'turns a dash pair into commas',
      'The cache—which holds tokens—expires.',
      'The cache, which holds tokens, expires.',
    ],
    ['follows a code span', '`submit`—not `retry`', '`submit`, not `retry`'],
    ['follows a closing quote', '"ok"— then', '"ok", then'],
  ])('%s', (_label, input, expected) => {
    expect(format(input)).toBe(expected);
  });

  it.each([
    ['between digits, where it may mean a range', 'pages 10—20'],
    ['between versions', 'v1—v3'],
    ['between dotted versions', '3.x—4.x'],
    ['before a capital', 'Monday—Friday'],
    ['spaced between dates', 'Jan 2024 — Mar 2025'],
    ['spaced between versions', 'v1 — v3'],
    ['spaced between dotted versions', '3.x — 4.x'],
    ['spaced before a capital', 'Monday — Friday'],
    ['in a pair whose other half stays', 'the fix—Redis caching—works'],
    ['at a line start', '— the author'],
    ['at a line end', 'the end —\nnext'],
    ['beside punctuation', 'one,— two'],
    ['doubled', 'one——two'],
    ['inside a code span', 'use `a—b` here'],
    ['inside a fenced block', '```\nx—y\n```'],
  ])('leaves one %s', (_label, input) => {
    expect(format(input)).toBe(input);
    expect(rules(format(input)).includes('em-dash')).toBe(!input.includes('`'));
  });

  it.each([
    [
      'after a phrase with no separator',
      'It turns out that — x',
      'It turns out that, x',
    ],
    ['after a removed opener', 'Hint: — x', '— x'],
  ])('never leaves a stray comma %s', (_label, input, expected) => {
    expect(format(input)).toBe(expected);
  });
});

describe('format: filler at a sentence start', () => {
  it.each([
    [
      'an opener with its colon',
      "Here's the thing: the lock leaks.",
      'The lock leaks.',
    ],
    [
      'a curly apostrophe',
      'Here’s the thing: the lock leaks.',
      'The lock leaks.',
    ],
    [
      'a vendored opener with a colon',
      "It's worth noting: the key is reused.",
      'The key is reused.',
    ],
    [
      'a vendored opener with a comma',
      'It turns out, the key is reused.',
      'The key is reused.',
    ],
    [
      'an opener with a comma',
      'Make no mistake, the key is reused.',
      'The key is reused.',
    ],
    ['a sentence adverb', 'Actually, the key is reused.', 'The key is reused.'],
    [
      'an AI self-identification',
      'As an AI language model, the key is reused.',
      'The key is reused.',
    ],
    [
      'after another sentence',
      'It fails. Honestly, the key is reused.',
      'It fails. The key is reused.',
    ],
    ['in a list item', '- Hint: the key leaks.', '- The key leaks.'],
    ['in a numbered item', '1. Hint: the key leaks.', '1. The key leaks.'],
    ['in a quote', '> Hint: the key leaks.', '> The key leaks.'],
    [
      'on a later line',
      'Line one\nHint: the key leaks.',
      'Line one\nThe key leaks.',
    ],
    ['one after another', "Honestly, here's the thing: it leaks.", 'It leaks.'],
    ['before a function word at a sentence end', 'Hint: it.', 'It.'],
    ['in any letter case', "HERE'S THE THING: it leaks.", 'It leaks.'],
  ])('removes %s', (_label, input, expected) => {
    expect(format(input)).toBe(expected);
  });

  it.each([
    [
      'an identifier',
      "It's worth noting, npm_config is unset.",
      'npm_config is unset.',
    ],
    ['a one-letter name', 'Hint: x is null.', 'x is null.'],
    ['a plain word', 'Hint: null is returned.', 'null is returned.'],
    ['a verb', 'Hint: reuse the key.', 'reuse the key.'],
    ['a function word glued to a name', 'Hint: the.x field.', 'the.x field.'],
    ['a dotted name', 'Hint: os.path is wrong.', 'os.path is wrong.'],
    ['a call', 'Hint: retry() loops.', 'retry() loops.'],
    ['a code span', 'Hint: `retry` loops.', '`retry` loops.'],
    ['a word with digits', 'Hint: i18n breaks.', 'i18n breaks.'],
    ['a capital', 'Hint: The key leaks.', 'The key leaks.'],
  ])('keeps the case of %s left at the start', (_label, input, expected) => {
    expect(format(input)).toBe(expected);
  });

  it.each([
    ['without its separator', 'It turns out to be null.'],
    ['inside a sentence', 'The value is actually null.'],
    ['as an adverb without a comma', 'Actually the value is null.'],
    ['with a colon but no space', 'Hint:x is null.'],
    ['inside a code span', '`Hint: x` is null.'],
    ['in a fenced block', '```\nHint: x\n```'],
    ['after a code span', '`x` Hint: y'],
    ['a filler sentence with more words', 'Great job fixing the leak.'],
    ['followed by that', "It's worth noting that the key is reused."],
    [
      'where that is not a conjunction',
      'It turns out that way because the cache is cold.',
    ],
    [
      'that is often literal',
      'At the end of the day, the cron job deletes stale sessions.',
    ],
    ['as an AI phrase in lower case', 'As an ai, it leaks.'],
  ])('keeps a phrase %s', (_label, input) => {
    expect(format(input)).toBe(input);
  });
});

describe('format: filler sentences', () => {
  it.each([
    ['at the start', 'Great job! The fix works.', 'The fix works.'],
    ['at the end', 'The fix works. I hope this helps.', 'The fix works.'],
    ['from the vendored list', 'It leaks. Let that sink in.', 'It leaks.'],
    ['with repeated marks', 'Nice work!! It leaks.', 'It leaks.'],
    [
      'before a line break',
      'It leaks. Happy to help.\nNext line.',
      'It leaks.\nNext line.',
    ],
    ['as the whole text', 'Well done.', ''],
    ['with its list marker', 'Para\n- Great catch!', 'Para'],
    ['with its numbered marker', 'Para\n1. Great job!\nNext', 'Para\nNext'],
    ['with its heading marker', '## Great job!', ''],
    ['with its line break', 'Para\nGreat job!\nNext', 'Para\nNext'],
    ['on two lines in a row', 'Para\nGreat job!\nNice work!', 'Para\n'],
    ['after another one', 'Great job! Nice work! It leaks.', 'It leaks.'],
    ['in a run of them', 'Full stop. Let that sink in.', ''],
  ])('removes one %s', (_label, input, expected) => {
    expect(format(input)).toBe(expected);
  });
});

describe('format: factual content', () => {
  const samples = [
    "Here's the thing: `submitPayment` retries 3 times—each with a new key. Great job!",
    'It turns out that pages 10—20 are skipped when `limit` is 0.',
    'As an AI, I think the 2 calls in `a.ts` race. I hope this helps.',
    '```ts\nconst x = 1; // Hint: keep\n```\nHonestly, line 4 is wrong.',
    'Actually, `foo`—`bar` both return 404.',
    'Actually—the key leaks.',
    "Honestly, as an AI, I can't run the tests.",
  ];

  it.each(samples)('keeps every code span and number in %j', (sample) => {
    const output = format(sample);
    for (const token of sample.match(/`[^`]+`|\d+/g) ?? []) {
      expect(output).toContain(token);
    }
  });

  it.each(samples)('is stable when run twice on %j', (sample) => {
    expect(format(format(sample))).toBe(format(sample));
  });

  it('removes an opener an em dash fix exposes', () => {
    expect(format('Actually—the key leaks.')).toBe('The key leaks.');
  });

  it('removes a self-identification a removed opener left in lower case', () => {
    expect(format("Honestly, as an AI, I can't run the tests.")).toBe(
      "I can't run the tests.",
    );
  });

  it('keeps a dash pair split across a soft line break', () => {
    expect(format('The fix—added in\nv2—works.')).toBe(
      'The fix—added in\nv2—works.',
    );
  });

  it('converts a dash in one paragraph when another keeps its own', () => {
    expect(format('a—b\n\n2—3')).toBe('a, b\n\n2—3');
  });

  it('leaves clean text unchanged', () => {
    const clean =
      '`submitPayment` generates a new key on each retry, so a 5xx after success charges twice.';
    expect(format(clean)).toBe(clean);
    expect(formatter.assertStyle(clean)).toEqual([]);
  });
});

describe('assertStyle', () => {
  it('reports each violation with its rule and offsets', () => {
    const text =
      'The key—as I think—is a game-changer 🚀. You might want to consider a lock.';
    expect(
      formatter
        .assertStyle(text)
        .map(({ rule, start, end }) => [rule, text.slice(start, end)]),
    ).toEqual([
      ['em-dash', '—'],
      ['self-reference', 'I'],
      ['em-dash', '—'],
      ['jargon', 'game-changer'],
      ['emoji', '🚀'],
      ['vague', 'You might want to consider'],
    ]);
  });

  it('reports what format cannot fix', () => {
    const text = "The lock is really held. Here's what I mean: 2010—2020.";
    expect(rules(format(text))).toEqual(['filler', 'em-dash']);
  });

  it('reports what format would fix in the raw text', () => {
    expect(rules("Here's the thing: it leaks. Great job!")).toEqual([
      'filler',
      'filler',
    ]);
  });

  it('reports a nested self-identification once', () => {
    expect(rules('As an AI language model, it leaks.')).toEqual([
      'self-reference',
    ]);
  });

  it.each([
    ['I/O', 'The I/O path leaks.'],
    ['AI', 'The AI client leaks.'],
    ['a code span', 'Call `I` and `honestly` and `🚀`.'],
    ['a fenced block', '~~~\nI really — 🚀\n~~~'],
    ['a fence with a longer close', '```\nI\n````\nok'],
    [
      'an indented fence in a list item',
      '- a\n    ```\n    Foo — Bar 🚀\n    ```',
    ],
    ['an indented code block', 'Run:\n\n    really — I think'],
    ['AI in a sentence', 'It runs as an AI agent.'],
    ['literal motion', 'The cursor keeps moving forward.'],
    ['literal layout', 'Two modals open on the same page.'],
    ['a Roman numeral', 'Type I errors rise.'],
    ['a letter', 'The I in SOLID stands for interfaces.'],
  ])('ignores %s', (_label, text) => {
    expect(formatter.assertStyle(text)).toEqual([]);
  });

  it.each([
    ["I'm", "I'm sure it leaks."],
    ['I’ve', 'I’ve seen it leak.'],
    ['I before a verb', 'I think it leaks.'],
  ])('reports the contraction %s', (_label, text) => {
    expect(rules(text)).toEqual(['self-reference']);
  });

  it('reads an unmatched backtick as text', () => {
    expect(rules('a ` really b')).toEqual(['filler']);
  });

  it('pairs backtick runs by length', () => {
    expect(rules('``a ` really`` honestly')).toEqual(['filler']);
  });

  it('runs an unclosed fence to the end', () => {
    expect(rules('ok\n```\nreally\nhonestly')).toEqual([]);
  });

  it('does not pair a code span across a fenced block', () => {
    expect(rules('a ` b\n```\nc\n```\nreally ` d')).toEqual(['filler']);
  });
});

describe('vendored rules', () => {
  const vendor = new URL('../../vendor/anti-slop/', import.meta.url);
  const read = (path: string): Buffer => readFileSync(new URL(path, vendor));
  const manifest = JSON.parse(read('manifest.json').toString('utf8')) as {
    readonly repository: string;
    readonly commit: string;
    readonly license: string;
    readonly files: Readonly<Record<string, string>>;
  };
  const normalize = (text: string): string =>
    text.toLowerCase().replace(/’/g, "'");

  it('pins one upstream commit', () => {
    expect(manifest.repository).toBe(
      'https://github.com/hardikpandya/stop-slop',
    );
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.license).toBe('MIT');
  });

  it('lists every vendored file with its checksum', () => {
    const root = fileURLToPath(vendor);
    const present = readdirSync(path.join(root, 'stop-slop'), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => !entry.isDirectory())
      .map((entry) =>
        path
          .relative(root, path.join(entry.parentPath, entry.name))
          .split(path.sep)
          .join('/'),
      )
      .sort();
    expect(present).toEqual(Object.keys(manifest.files).sort());
    for (const [path, checksum] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(read(path)).digest('hex'), path).toBe(
        checksum,
      );
    }
  });

  it('quotes every vendored phrase from its source file', () => {
    const sourced = stylePhrases.filter((phrase) => phrase.source);
    expect(sourced.length).toBeGreaterThan(0);
    for (const phrase of sourced) {
      const file = normalize(
        read(`stop-slop/${phrase.source}`).toString('utf8'),
      );
      expect(file, phrase.text).toContain(normalize(phrase.text));
    }
    expect(read('stop-slop/references/structures.md').toString()).toContain(
      'No em dashes at all.',
    );
  });

  it('attributes the snapshot in NOTICE', () => {
    const notice = readFileSync(
      new URL('../../NOTICE', import.meta.url),
      'utf8',
    );
    const license = read('stop-slop/LICENSE').toString('utf8');
    expect(notice).toContain(manifest.repository);
    expect(notice).toContain(manifest.commit);
    expect(notice).toContain(license.trim());
  });
});
