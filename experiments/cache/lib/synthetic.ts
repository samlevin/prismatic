// Seeded synthetic material for the cache spike. Nothing here is real code or
// a real review: the spike measures prefix-cache behavior, so the content only
// has to be deterministic, tokenize roughly like source and prose, and be long
// enough to clear the provider's minimum cacheable prefix. Every run renders
// the same bytes from the same seeds.
import { createHash } from 'node:crypto';

export interface SyntheticFile {
  readonly path: string;
  readonly text: string;
  // Git blob ID of the text, as §9.3 serializes it beside the path.
  readonly blobId: string;
}

// mulberry32: small, fast, and deterministic across platforms.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const words = [
  'account',
  'balance',
  'cursor',
  'digest',
  'entry',
  'frontier',
  'gateway',
  'handle',
  'index',
  'journal',
  'ledger',
  'manifest',
  'notice',
  'offset',
  'payload',
  'quota',
  'record',
  'shard',
  'token',
  'window',
] as const;

// random() is in [0, 1), so the index is always in range.
function pick(random: () => number): string {
  return words[Math.floor(random() * words.length)] as string;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function gitBlobId(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

export function syntheticFile(path: string, text: string): SyntheticFile {
  return { path, text, blobId: gitBlobId(text) };
}

// A TypeScript-like module of `functions` small exported functions.
export function syntheticSource(
  path: string,
  seed: number,
  functions: number,
): SyntheticFile {
  const random = seededRandom(seed);
  const lines: string[] = [`// ${path}: synthetic module ${seed}`];
  for (let i = 0; i < functions; i += 1) {
    const name = `${pick(random)}${capitalize(pick(random))}${i}`;
    const first = pick(random);
    const second = pick(random);
    const limit = Math.floor(random() * 900) + 100;
    lines.push(
      '',
      `export function ${name}(${first}: number, ${second}Count: number): number {`,
      `  const scaled = ${first} * ${limit} + ${second}Count;`,
      `  if (scaled > ${limit * 7}) return scaled - ${limit};`,
      `  return Math.max(0, scaled % ${limit + 3});`,
      '}',
    );
  }
  return syntheticFile(path, `${lines.join('\n')}\n`);
}

// The same file with one line changed at `fraction` of its length (0 is the
// first body line, 1 the last), so a changed byte lands early or late.
export function editSource(
  file: SyntheticFile,
  fraction: number,
  marker: string,
): SyntheticFile {
  const lines = file.text.split('\n');
  const bodies = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith('  const scaled'));
  if (bodies.length === 0) {
    throw new RangeError(`${file.path} has no line to edit.`);
  }
  const clamped = Math.min(1, Math.max(0, fraction));
  // The clamped fraction always selects an existing body line.
  const { index } = bodies[Math.round(clamped * (bodies.length - 1))] as {
    readonly index: number;
  };
  lines[index] = `  const scaled = 0; // edited: ${marker}`;
  return syntheticFile(file.path, lines.join('\n'));
}

// Rule-like prose of `paragraphs` paragraphs of eight sentences each.
export function syntheticProse(seed: number, paragraphs: number): string {
  const random = seededRandom(seed);
  const out: string[] = [];
  for (let p = 0; p < paragraphs; p += 1) {
    const sentences: string[] = [];
    for (let s = 0; s < 8; s += 1) {
      sentences.push(
        `Each ${pick(random)} that reaches the ${pick(random)} must keep its ${pick(random)} and ${pick(random)} unchanged unless the ${pick(random)} records why.`,
      );
    }
    out.push(sentences.join(' '));
  }
  return `${out.join('\n\n')}\n`;
}

// A 40-hex-character identifier derived from a label, standing in for a
// commit SHA in block 5 provenance.
export function syntheticSha(label: string): string {
  return createHash('sha1').update(label).digest('hex');
}
