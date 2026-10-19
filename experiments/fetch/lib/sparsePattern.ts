// Escaped, rooted sparse-checkout patterns and literal pathspecs for exact
// repository paths. Non-cone sparse patterns use gitignore syntax, so every
// character that syntax gives a meaning to is escaped and the pattern is
// anchored at the root; the result matches the one path it was built from.
// A path that cannot be written on one line, or that fails
// normalizeRepoPath, is refused instead.
import { normalizeRepoPath } from '../../../src/shared/path.ts';

export type PatternResult =
  | { readonly ok: true; readonly pattern: string }
  | { readonly ok: false; readonly reason: 'invalid-path' };

// `*`, `?` and `[` are wildcards, `]` closes a class, and `\` escapes. `!`
// and `#` only matter at the start of a pattern, which is always `/` here,
// but escaping them everywhere is harmless and keeps the rule simple.
const special = /[*?[\]\\!#]/g;

export function sparsePatternFor(path: string): PatternResult {
  let checked: string;
  try {
    checked = normalizeRepoPath(path);
  } catch {
    return { ok: false, reason: 'invalid-path' };
  }
  const escaped = checked
    .replace(special, (character) => `\\${character}`)
    // Git strips unescaped trailing spaces from a pattern line.
    .replace(/ +$/, (spaces) => '\\ '.repeat(spaces.length));
  return { ok: true, pattern: `/${escaped}` };
}

export interface SparseFile {
  readonly content: string;
  readonly refused: readonly string[];
}

// The contents of `info/sparse-checkout` for a set of admitted paths. Paths
// it cannot represent are listed in `refused` and left out of the scope.
export function sparseFileFor(paths: Iterable<string>): SparseFile {
  const lines: string[] = [];
  const refused: string[] = [];
  for (const path of paths) {
    const result = sparsePatternFor(path);
    if (result.ok) lines.push(result.pattern);
    else refused.push(path);
  }
  return { content: lines.map((line) => `${line}\n`).join(''), refused };
}

// A pathspec that names exactly one path, whatever characters it contains.
export function literalPathspec(path: string): string {
  return `:(literal)${normalizeRepoPath(path)}`;
}
