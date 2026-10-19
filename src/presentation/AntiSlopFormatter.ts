// Human-prose standards for model-authored text (§8.4). The phrases come from
// the stop-slop snapshot pinned under vendor/anti-slop/ or from §8.4 itself.
// format() removes only what carries no claim: an em dash between words, and
// filler openers or filler sentences at a sentence start. assertStyle()
// reports every violation, so assertStyle(format(text)) lists what format()
// left for the caller to reject. Code spans and fenced code are never read.

export type StyleRule =
  'em-dash' | 'filler' | 'self-reference' | 'jargon' | 'vague' | 'emoji';

export interface StyleViolation {
  readonly rule: StyleRule;
  // UTF-16 offsets into the checked text.
  readonly start: number;
  readonly end: number;
}

export type VendoredRuleFile =
  'references/phrases.md' | 'references/structures.md';

// opener: removed at a sentence start with its `,` or `:` and the space after.
// adverb: removed at a sentence start only when a comma follows it.
// sentence: removed when it is a whole sentence ending in `.` or `!`.
export type StyleFix = 'opener' | 'adverb' | 'sentence';

export interface StylePhrase {
  readonly rule: StyleRule;
  readonly text: string;
  // Absent: reported wherever it appears, never removed.
  readonly fix?: StyleFix;
  // Absent: the phrase comes from §8.4.
  readonly source?: VendoredRuleFile;
}

const phrasesMd = 'references/phrases.md';
const structuresMd = 'references/structures.md';

const filler = (
  text: string,
  source: VendoredRuleFile,
  fix?: StyleFix,
): StylePhrase => ({ rule: 'filler', text, source, ...(fix && { fix }) });

// The upstream adverb list without `just`, `deeply`, `inherently`, and
// `inevitably`, which carry technical meaning ("just added", "deeply nested").
const adverbs = [
  'really',
  'literally',
  'genuinely',
  'honestly',
  'simply',
  'actually',
  'truly',
  'fundamentally',
  'interestingly',
  'importantly',
  'crucially',
];

export const stylePhrases: readonly StylePhrase[] = [
  filler("Here's the thing:", phrasesMd, 'opener'),
  filler('The uncomfortable truth is', phrasesMd, 'opener'),
  filler('It turns out', phrasesMd, 'opener'),
  filler('Let me be clear', phrasesMd, 'opener'),
  filler('The truth is,', phrasesMd, 'opener'),
  filler("I'll say it again:", phrasesMd, 'opener'),
  filler("I'm going to be honest", phrasesMd, 'opener'),
  filler('Can we talk about', phrasesMd),
  filler("Here's what I find interesting", phrasesMd, 'opener'),
  filler("Here's the problem though", phrasesMd, 'opener'),
  filler('Full stop.', phrasesMd, 'sentence'),
  filler('Let that sink in.', phrasesMd, 'sentence'),
  filler('This matters because', phrasesMd),
  filler('Make no mistake', phrasesMd, 'opener'),
  filler("Here's why that matters", phrasesMd, 'opener'),
  ...adverbs.map((adverb) => filler(adverb, phrasesMd, 'adverb')),
  filler('At its core', phrasesMd, 'opener'),
  filler("It's worth noting", phrasesMd, 'opener'),
  // Often literal in code review: "At the end of the day, the job runs."
  filler('At the end of the day', phrasesMd),
  filler('When it comes to', phrasesMd),
  filler('In a world where', phrasesMd),
  filler('The reality is', phrasesMd, 'opener'),
  filler('Hint:', phrasesMd, 'opener'),
  filler('Plot twist:', phrasesMd, 'opener'),
  filler('Spoiler:', phrasesMd, 'opener'),
  filler('You already know this, but', phrasesMd),
  filler('The rest of this essay', phrasesMd),
  filler('Let me walk you through', phrasesMd),
  filler("In this section, we'll", phrasesMd),
  filler("As we'll see", phrasesMd),
  filler('I want to explore', phrasesMd),
  filler('Think about it:', structuresMd, 'opener'),
  filler("Here's what I mean:", structuresMd, 'opener'),
  filler("And that's okay.", structuresMd, 'sentence'),
  { rule: 'filler', text: 'To be honest', fix: 'opener' },
  { rule: 'filler', text: 'Needless to say', fix: 'opener' },
  ...[
    'I hope this helps',
    'Hope this helps',
    'Let me know if you have any questions',
    'Happy to help',
    'Great question',
    'Great catch',
    'Good catch',
    'Nice catch',
    'Great job',
    'Good job',
    'Nice work',
    'Well done',
  ].map((text): StylePhrase => ({ rule: 'filler', text, fix: 'sentence' })),
  { rule: 'self-reference', text: 'As an AI language model', fix: 'opener' },
  { rule: 'self-reference', text: 'As an AI assistant', fix: 'opener' },
  { rule: 'self-reference', text: 'As an AI', fix: 'opener' },
  // `navigate`, `unpack`, `landscape`, `moving forward`, and `on the same
  // page` are left out: code review uses them literally (browser navigation,
  // tuple unpacking, page orientation, a cursor, two modals).
  ...[
    'Lean into',
    'Game-changer',
    'Double down',
    'Deep dive',
    'Take a step back',
    'Circle back',
  ].map((text): StylePhrase => ({ rule: 'jargon', text, source: phrasesMd })),
  ...[
    'The reasons are structural',
    'The implications are significant',
    'This is the deepest problem',
    'The stakes are high',
    'The consequences are real',
  ].map((text): StylePhrase => ({ rule: 'vague', text, source: phrasesMd })),
  ...[
    'you may want to consider',
    'you might want to consider',
    'you could consider',
    'it may be worth considering',
    'it might be worth considering',
  ].map((text): StylePhrase => ({ rule: 'vague', text })),
];

const emDash = '\u2014';
const wordCharacter = /[\p{L}\p{N}_]/u;
const emDashBefore = /[\p{L}\p{N}`)"'\u2019\u201D]/u;
const emDashAfter = /[\p{L}\p{N}`("'\u2018\u201C]/u;
const digit = /\p{N}/u;
const capital = /\p{Lu}/u;
const tokenEdge = /[\s\u2014]/;
const horizontalSpace = /[ \t]/;
const emoji = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\u{FE0F}/gu;
// A contraction, or a bare `I` before a verb, so `Type I` and `the I in SOLID`
// pass.
const firstPerson = new RegExp(
  `(?<![\\p{L}\\p{N}_/-])I(?:['\u2019](?:m|ve|d|ll)(?![\\p{L}\\p{N}_/-])|(?=\\s+(?:${[
    'am',
    'was',
    'have',
    'had',
    'think',
    'thought',
    'believe',
    'noticed',
    'found',
    'see',
    'saw',
    'would',
    'will',
    'can',
    'could',
    'should',
    'might',
    'may',
    'must',
    'recommend',
    'suggest',
    'feel',
    'want',
    'hope',
    'need',
    'agree',
    'assume',
    'guess',
    'looked',
    'checked',
    'reviewed',
    'ran',
    'tested',
    'tried',
    'missed',
    'also',
    'just',
    'did',
    'do',
    'don',
  ].join('|')})(?![\\p{L}\\p{N}_])))`,
  'gu',
);
// An English function word left at a sentence start is capitalized. Any other
// word, which may be an identifier such as `npm` or `x`, keeps its case.
const functionWord = new RegExp(
  `(?:${[
    'the',
    'an',
    'this',
    'that',
    'these',
    'those',
    'it',
    'its',
    'each',
    'every',
    'all',
    'both',
    'some',
    'any',
    'no',
    'none',
    'there',
    'here',
    'when',
    'if',
    'after',
    'before',
    'because',
    'since',
    'so',
    'for',
    'in',
    'on',
    'at',
    'with',
    'without',
    'to',
    'from',
    'by',
    'as',
    'once',
    'unless',
    'while',
    'we',
    'you',
    'they',
    'only',
    'most',
    'many',
    'other',
    'another',
  ].join('|')})(?![\\p{L}\\p{N}_$/(-]|\\.[\\p{L}\\p{N}_])`,
  'uy',
);
// The end of each match is a sentence start: the text start or a line start,
// past any list, quote, or heading marker, or the space after `.`, `!`, `?`.
const sentenceBoundary =
  /(?:^|\n)[ \t]*(?:(?:[-*+>]|\d{1,9}[.)]|#{1,6})[ \t]+)?|[.!?]["'\u2019\u201D)\]]*[ \t]+/g;
const sentenceEnd = /[.!]+/y;
const clauseMark = /[,:]/y;
const comma = /,/y;
const trailingSpace = /[ \t]+|(?=\n|$)/y;
// Fences at any indent, and lines indented like code blocks, count as code. A
// list item's indented prose is then left alone, which is the safe side.
const fenceOpen = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
const indentedLine = /^(?: {4}|\t)[^\n]*$/gm;

interface CompiledPhrase {
  readonly phrase: StylePhrase;
  readonly anywhere: RegExp;
  readonly sticky: RegExp;
}

function phrasePattern(text: string): string {
  const body = text
    .split(/\s+/)
    .map((word) =>
      word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]"),
    )
    .join('\\s+');
  const end = wordCharacter.test(text.slice(-1)) ? '(?![\\p{L}\\p{N}_])' : '';
  return `(?<![\\p{L}\\p{N}_])${body}${end}`;
}

const compiled: readonly CompiledPhrase[] = stylePhrases.map((phrase) => {
  const pattern = phrasePattern(phrase.text);
  // `As an AI` matches only as written, so "runs as an AI agent" passes.
  const flags = phrase.rule === 'self-reference' ? 'u' : 'iu';
  return {
    phrase,
    anywhere: new RegExp(pattern, `g${flags}`),
    sticky: new RegExp(pattern, `y${flags}`),
  };
});

const removable = compiled.filter((entry) => entry.phrase.fix !== undefined);

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export class AntiSlopFormatter {
  // Returns the text with every safe fix applied. Everything else, including
  // a filler phrase inside a sentence and an em dash between digits or at a
  // line edge, stays exactly as written.
  format(text: string): string {
    const prose = proseMask(text);
    const edits = [...openerEdits(text, prose), ...emDashEdits(text, prose)];
    edits.sort((a, b) => a.start - b.start);
    let result = '';
    let position = 0;
    for (const edit of edits) {
      result += text.slice(position, edit.start) + edit.replacement;
      position = edit.end;
    }
    return result + text.slice(position);
  }

  // Every violation in the text, ordered by position.
  assertStyle(text: string): readonly StyleViolation[] {
    const prose = proseMask(text);
    const found: StyleViolation[] = [];
    const add = (rule: StyleRule, start: number, end: number): void => {
      if (isProse(prose, start, end)) found.push({ rule, start, end });
    };
    for (const { phrase, anywhere } of compiled) {
      for (const match of text.matchAll(anywhere)) {
        add(phrase.rule, match.index, match.index + match[0].length);
      }
    }
    for (const match of text.matchAll(firstPerson)) {
      add('self-reference', match.index, match.index + match[0].length);
    }
    for (const match of text.matchAll(emoji)) {
      add('emoji', match.index, match.index + match[0].length);
    }
    for (let index = text.indexOf(emDash); index !== -1;) {
      add('em-dash', index, index + 1);
      index = text.indexOf(emDash, index + 1);
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    // "As an AI language model" also matches "As an AI"; report it once.
    const reachedEnd = new Map<StyleRule, number>();
    return found.filter((violation) => {
      if ((reachedEnd.get(violation.rule) ?? -1) >= violation.end) return false;
      reachedEnd.set(violation.rule, violation.end);
      return true;
    });
  }
}

// Marks the characters outside fenced code blocks and inline code spans. A
// backtick run opens a span only if a run of the same length closes it before
// the next fenced block.
function proseMask(text: string): Uint8Array {
  const prose = new Uint8Array(text.length).fill(1);
  fenceOpen.lastIndex = 0;
  for (let open = fenceOpen.exec(text); open; open = fenceOpen.exec(text)) {
    const marker = open[1] ?? '';
    const closing = new RegExp(
      `^[ \\t]*${marker.startsWith('~') ? '~' : '`'}{${marker.length},}[ \\t]*$`,
      'gm',
    );
    closing.lastIndex = fenceOpen.lastIndex;
    const close = closing.exec(text);
    const end = close ? close.index + close[0].length : text.length;
    prose.fill(0, open.index, end);
    fenceOpen.lastIndex = end;
  }
  for (const line of text.matchAll(indentedLine)) {
    prose.fill(0, line.index, line.index + line[0].length);
  }
  const fencedBefore = new Uint32Array(text.length + 1);
  let fenced = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!prose[index]) fenced += 1;
    fencedBefore[index + 1] = fenced;
  }
  type Run = readonly [number, RegExpExecArray];
  const runs: Run[] = [...text.matchAll(/`+/g)]
    .filter((run) => prose[run.index])
    .map((run, index) => [index, run]);
  const closers = new Map<number, Run>();
  const lastOfLength = new Map<number, Run>();
  for (const run of runs.toReversed()) {
    const later = lastOfLength.get(run[1][0].length);
    if (later) closers.set(run[0], later);
    lastOfLength.set(run[1][0].length, run);
  }
  let consumedThrough = -1;
  for (const [index, open] of runs) {
    const closer = closers.get(index);
    if (index <= consumedThrough || !closer) continue;
    const [closeIndex, close] = closer;
    if (fencedBefore[close.index] !== fencedBefore[open.index]) continue;
    prose.fill(0, open.index, close.index + close[0].length);
    consumedThrough = closeIndex;
  }
  return prose;
}

function isProse(prose: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (!prose[index]) return false;
  }
  return true;
}

function stickyEnd(
  pattern: RegExp,
  text: string,
  index: number,
): number | undefined {
  pattern.lastIndex = index;
  return pattern.test(text) ? pattern.lastIndex : undefined;
}

// Removes filler openers and filler sentences at each sentence start, one
// after another, and capitalizes the plain word left at the start.
function openerEdits(text: string, prose: Uint8Array): Edit[] {
  const edits: Edit[] = [];
  let removedThrough = 0;
  for (const boundary of text.matchAll(sentenceBoundary)) {
    const sentenceStart = boundary.index + boundary[0].length;
    // A boundary inside text an earlier start already removed is done.
    if (sentenceStart < removedThrough) continue;
    let position = sentenceStart;
    for (let end = removableEnd(text, prose, position); end !== undefined;) {
      position = end;
      end = removableEnd(text, prose, position);
    }
    if (position === sentenceStart) continue;
    removedThrough = position;
    let start = sentenceStart;
    if (position === text.length || text[position] === '\n') {
      while (start > 0 && horizontalSpace.test(text.charAt(start - 1))) {
        start -= 1;
      }
    }
    const capitalize =
      prose[position] === 1 &&
      stickyEnd(functionWord, text, position) !== undefined;
    edits.push(
      capitalize
        ? {
            start,
            end: position + 1,
            replacement: text.charAt(position).toUpperCase(),
          }
        : { start, end: position, replacement: '' },
    );
  }
  return edits;
}

// Where a removable phrase at `position` ends, past its separator and the
// spaces after it, or undefined when none starts there.
function removableEnd(
  text: string,
  prose: Uint8Array,
  position: number,
): number | undefined {
  for (const { phrase, sticky } of removable) {
    const phraseEnd = stickyEnd(sticky, text, position);
    if (phraseEnd === undefined) continue;
    const separated = separatorEnd(phrase, text, phraseEnd);
    if (separated === undefined) continue;
    const end = stickyEnd(trailingSpace, text, separated);
    if (end !== undefined && isProse(prose, position, end)) return end;
  }
  return undefined;
}

function separatorEnd(
  phrase: StylePhrase,
  text: string,
  index: number,
): number | undefined {
  switch (phrase.fix) {
    case 'sentence':
      return /[.!]$/.test(phrase.text)
        ? index
        : stickyEnd(sentenceEnd, text, index);
    case 'adverb':
      return stickyEnd(comma, text, index);
    default:
      return /[,:]$/.test(phrase.text)
        ? index
        : stickyEnd(clauseMark, text, index);
  }
}

// An em dash between two words becomes a comma. One at a line edge or beside
// punctuation stays. So does one that may mark a range: between digits, or
// unspaced beside a token with a digit or before a capital (`v1—v3`,
// `Monday—Friday`).
function emDashEdits(text: string, prose: Uint8Array): Edit[] {
  const edits: Edit[] = [];
  for (let index = text.indexOf(emDash); index !== -1;) {
    let start = index;
    let end = index + 1;
    while (start > 0 && horizontalSpace.test(text.charAt(start - 1)))
      start -= 1;
    while (horizontalSpace.test(text.charAt(end))) end += 1;
    const before = text.charAt(start - 1);
    const after = text.charAt(end);
    const unspaced = start === index && end === index + 1;
    if (
      isProse(prose, start, end) &&
      emDashBefore.test(before) &&
      emDashAfter.test(after) &&
      !(digit.test(before) && digit.test(after)) &&
      !(unspaced && (rangeLike(text, index) || capital.test(after)))
    ) {
      edits.push({ start, end, replacement: ', ' });
    }
    index = text.indexOf(emDash, index + 1);
  }
  return edits;
}

// Whether the token on either side of the em dash at `index` holds a number.
// Tokens end at whitespace or another em dash, so each scan stays local.
function rangeLike(text: string, index: number): boolean {
  for (
    let at = index - 1;
    at >= 0 && !tokenEdge.test(text.charAt(at));
    at -= 1
  ) {
    if (digit.test(text.charAt(at))) return true;
  }
  for (
    let at = index + 1;
    at < text.length && !tokenEdge.test(text.charAt(at));
    at += 1
  ) {
    if (digit.test(text.charAt(at))) return true;
  }
  return false;
}
