// Inline Markdown escaping for metadata the reviewer controls but did not
// write, such as paths, branch names, check names, and rule names, when it is
// placed in GitHub-flavored Markdown outside a code span.
import { stripAnsi } from './text.ts';

// Characters with Markdown meaning, backslash-escaped: emphasis, code, links,
// images, headings, lists, block quotes, tables, strikethrough, footnotes,
// emoji shortcodes, and math.
const escapedPunctuation = new Set('\\`*_{}[]()#+-.!|~^=:$"'.split(''));

// Line breaks, tabs, and other control characters, which could end the
// current table row or list item, become one space each.
// eslint-disable-next-line no-control-regex -- control characters are the point
const controlCharacters = /[\u0000-\u001F\u007F]/g;

// Returns a single line of text that renders as itself. HTML special
// characters become entities, so no tag or comment is opened. A zero-width
// space follows every @, so a name never becomes a mention that notifies
// someone.
export function escapeMarkdown(text: string): string {
  let result = '';
  for (const character of stripAnsi(text).replace(controlCharacters, ' ')) {
    switch (character) {
      case '&':
        result += '&amp;';
        break;
      case '<':
        result += '&lt;';
        break;
      case '>':
        result += '&gt;';
        break;
      case '@':
        result += '@&#8203;';
        break;
      default:
        result += escapedPunctuation.has(character)
          ? `\\${character}`
          : character;
    }
  }
  return result;
}
