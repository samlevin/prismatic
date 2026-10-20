// Inline Markdown escaping for metadata the reviewer controls but did not
// write, such as paths, branch names, check names, and rule names, when it is
// placed in GitHub-flavored Markdown outside a code span.
import { stripAnsi } from './text.ts';

// Characters with Markdown meaning, backslash-escaped: emphasis, code, links,
// images, lists, block quotes, tables, strikethrough, footnotes, emoji
// shortcodes, and math. `#` and `-`, which also start headings and lists,
// have their own cases below.
const escapedPunctuation = new Set('\\`*_{}[]()+.!|~^=:$"'.split(''));

// Line breaks, tabs, and other control characters, which could end the
// current table row or list item, become one space each.
// eslint-disable-next-line no-control-regex -- control characters are the point
const controlCharacters = /[\u0000-\u001F\u007F]/g;

// Returns a single line of text that renders as itself. HTML special
// characters become entities, so no tag or comment is opened. GitHub finds
// mentions and issue references after rendering, where backslashes are gone,
// so a zero-width space follows every @, every #, and the - of GH-.
export function escapeMarkdown(text: string): string {
  let result = '';
  // The two characters before this one; slicing the growing result is quadratic.
  let previous = '';
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
      case '#':
        result += '\\#&#8203;';
        break;
      case '-':
        result += /^gh$/i.test(previous) ? '\\-&#8203;' : '\\-';
        break;
      default:
        result += escapedPunctuation.has(character)
          ? `\\${character}`
          : character;
    }
    previous = previous.slice(-1) + character;
  }
  return result;
}
