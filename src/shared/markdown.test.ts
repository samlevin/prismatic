import { describe, expect, it } from 'vitest';
import { escapeMarkdown } from './markdown.ts';

describe('escapeMarkdown', () => {
  it('leaves letters, digits, spaces, and slashes alone', () => {
    expect(escapeMarkdown('src/Main file 2/index')).toBe(
      'src/Main file 2/index',
    );
  });

  it.each([
    ['emphasis', '*bold* _it_', '\\*bold\\* \\_it\\_'],
    ['a code span', '`code`', '\\`code\\`'],
    ['a link', '[x](https://e.test)', '\\[x\\]\\(https\\://e\\.test\\)'],
    ['an image', '![i](u)', '\\!\\[i\\]\\(u\\)'],
    ['a heading', '# Title', '\\#&#8203; Title'],
    ['a list item', '- item', '\\- item'],
    ['a table cell break', 'a | b', 'a \\| b'],
    ['strikethrough', '~~x~~', '\\~\\~x\\~\\~'],
    ['an emoji shortcode', ':rocket:', '\\:rocket\\:'],
    ['math', '$x^2$', '\\$x\\^2\\$'],
    ['a backslash', 'a\\b', 'a\\\\b'],
    ['a footnote', '[^1]', '\\[\\^1\\]'],
  ])('escapes %s', (_label, input, expected) => {
    expect(escapeMarkdown(input)).toBe(expected);
  });

  it('turns HTML special characters into entities', () => {
    expect(escapeMarkdown('<img src=x onerror=alert(1)> & <!-- c -->')).toBe(
      '&lt;img src\\=x onerror\\=alert\\(1\\)&gt; &amp; &lt;\\!\\-\\- c \\-\\-&gt;',
    );
  });

  it('breaks mentions with a zero-width space', () => {
    expect(escapeMarkdown('@octocat and @org/team')).toBe(
      '@&#8203;octocat and @&#8203;org/team',
    );
  });

  it('breaks issue references with a zero-width space', () => {
    expect(escapeMarkdown('fix-#12 owner/repo#12 GH-12 gh-7')).toBe(
      'fix\\-\\#&#8203;12 owner/repo\\#&#8203;12 GH\\-&#8203;12 gh\\-&#8203;7',
    );
  });

  it('keeps the result on one line', () => {
    expect(escapeMarkdown('a\nb\r\nc\td')).toBe('a b  c d');
  });

  it('removes terminal escape sequences', () => {
    expect(escapeMarkdown('\u001B[31mred\u001B[0m')).toBe('red');
  });

  it('keeps non-ASCII text', () => {
    expect(escapeMarkdown('café 東京')).toBe('café 東京');
  });
});
