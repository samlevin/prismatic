// Deterministic fixture repositories, written as a `git fast-import` stream.
// The spike never commits fixture repositories: it generates them in the
// container's /tmp from these descriptions, so every run starts from the same
// object IDs. Large files are streamed from a seeded generator, so the 2 GiB
// fixture never sits in memory.
import { createCipheriv, createHash } from 'node:crypto';

export interface StreamedContent {
  readonly length: number;
  chunks(): AsyncIterable<Buffer>;
}

export type FixtureChange =
  | {
      readonly path: string | Buffer;
      readonly mode?: '100644' | '100755' | '120000';
      readonly content: string | Buffer | StreamedContent;
    }
  | { readonly path: string | Buffer; readonly gitlink: string }
  | { readonly path: string | Buffer; readonly deleted: true };

export interface FixtureCommit {
  // fast-import marks start at 1 and must be unique.
  readonly mark: number;
  readonly ref: string;
  // Marks of the parents; the first becomes `from`. An empty list starts a
  // root commit.
  readonly parents: readonly number[];
  readonly message: string;
  readonly changes: readonly FixtureChange[];
}

// Fixed identity and clock, so object IDs are the same on every run.
const identity = 'Prismatic Spike <spike@example.invalid>';
const epoch = 1_700_000_000;

// Printable ASCII that neither starts nor ends with a space.
const plainPath = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

// fast-import takes a path as the rest of the line, or C-quoted when it
// contains a quote, backslash, control byte or non-ASCII byte, or has a space
// at either end. Quoting every unusual byte as octal keeps hostile names
// byte-exact.
export function fastImportPath(path: string | Buffer): string {
  const bytes = typeof path === 'string' ? Buffer.from(path, 'utf8') : path;
  const text = bytes.toString('latin1');
  if (plainPath.test(text) && !text.includes('"') && !text.includes('\\'))
    return text;
  let quoted = '"';
  for (const byte of bytes) {
    if (byte === 0x22) quoted += '\\"';
    else if (byte === 0x5c) quoted += '\\\\';
    else if (byte >= 0x20 && byte < 0x7f) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${quoted}"`;
}

function isStreamed(
  content: string | Buffer | StreamedContent,
): content is StreamedContent {
  return typeof content !== 'string' && !Buffer.isBuffer(content);
}

async function* changeLines(change: FixtureChange): AsyncGenerator<Buffer> {
  const path = fastImportPath(change.path);
  if ('deleted' in change) {
    yield Buffer.from(`D ${path}\n`);
    return;
  }
  if ('gitlink' in change) {
    yield Buffer.from(`M 160000 ${change.gitlink} ${path}\n`);
    return;
  }
  const mode = change.mode ?? '100644';
  if (isStreamed(change.content)) {
    yield Buffer.from(
      `M ${mode} inline ${path}\ndata ${change.content.length}\n`,
    );
    let written = 0;
    for await (const chunk of change.content.chunks()) {
      written += chunk.length;
      yield chunk;
    }
    if (written !== change.content.length)
      throw new Error(`Streamed content for ${path} had the wrong length.`);
    yield Buffer.from('\n');
    return;
  }
  const data = Buffer.isBuffer(change.content)
    ? change.content
    : Buffer.from(change.content, 'utf8');
  yield Buffer.from(`M ${mode} inline ${path}\ndata ${data.length}\n`);
  yield data;
  yield Buffer.from('\n');
}

export async function* fastImportStream(
  commits: Iterable<FixtureCommit>,
): AsyncGenerator<Buffer> {
  for (const commit of commits) {
    const message = Buffer.from(commit.message, 'utf8');
    const time = `${epoch + commit.mark} +0000`;
    const [from, ...merges] = commit.parents;
    yield Buffer.from(
      [
        `commit ${commit.ref}`,
        `mark :${commit.mark}`,
        `author ${identity} ${time}`,
        `committer ${identity} ${time}`,
        `data ${message.length}`,
        '',
      ].join('\n'),
    );
    yield message;
    yield Buffer.from('\n');
    if (from === undefined) yield Buffer.from('deleteall\n');
    else yield Buffer.from(`from :${from}\n`);
    for (const merge of merges) yield Buffer.from(`merge :${merge}\n`);
    for (const change of commit.changes) yield* changeLines(change);
    yield Buffer.from('\n');
  }
  yield Buffer.from('done\n');
}

const chunkBytes = 1024 * 1024;

// Incompressible bytes from AES-128-CTR keyed by the seed, so a file is the
// same on every run and its pack size equals its content size.
export function seededContent(seed: string, length: number): StreamedContent {
  return {
    length,
    async *chunks() {
      const key = createHash('sha256').update(seed).digest().subarray(0, 16);
      const cipher = createCipheriv('aes-128-ctr', key, Buffer.alloc(16));
      const zeros = Buffer.alloc(chunkBytes);
      let remaining = length;
      while (remaining > 0) {
        const size = Math.min(remaining, chunkBytes);
        yield cipher.update(zeros.subarray(0, size));
        remaining -= size;
      }
    },
  };
}

// Source-like text of about `bytes` bytes, distinct per seed, so a fixture
// file has a realistic size and compresses like code.
export function sourceText(seed: string, bytes: number): string {
  const lines: string[] = [`// ${seed}`];
  let size = lines[0]?.length ?? 0;
  for (let index = 0; size < bytes; index += 1) {
    const line = `export const ${seed.replace(/[^A-Za-z0-9]/g, '_')}_${index} = ${(index * 7919) % 104729};`;
    lines.push(line);
    size += line.length + 1;
  }
  return `${lines.join('\n')}\n`;
}
