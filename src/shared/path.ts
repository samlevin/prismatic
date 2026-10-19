// Repository paths. A repository path is the exact name Git stores for a tree
// entry: relative, slash-separated, and compared byte for byte. These checks
// refuse a path rather than repair it. They never fold case, apply Unicode
// normalization, or strip characters, so a path that passes is returned
// unchanged and still names the same Git entry.
import { ValidationError } from './validation.ts';

// Git limits a path to PATH_MAX bytes on Linux.
export const maxRepoPathBytes = 4096;

// C0 and C1 controls (including NUL, newline, and DEL), the backslash, which
// Windows tools and some parsers treat as a separator, and the bidirectional
// formatting characters that make a name display differently from its bytes,
// and the zero-width code points HFS+ ignores when it compares names.
const forbiddenCharacters =
  // eslint-disable-next-line no-control-regex -- control characters are the point
  /[\u0000-\u001F\u007F-\u009F\\\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u200C\u206A-\u206F\uFEFF]|\u200D/u;

// `C:` at the start reads as a drive-relative path on Windows.
const drivePrefix = /^[A-Za-z]:/;

function invalid(reason: string): never {
  throw new ValidationError('invalid-path', `Repository path ${reason}.`);
}

// `.git` in any case, with the trailing dots and spaces Windows ignores or an
// NTFS stream suffix such as `::$INDEX_ALLOCATION`, and its NTFS short name,
// all reach the repository metadata directory on some file system.
function isGitDirectoryName(segment: string): boolean {
  const name = (segment.toLowerCase().split(':')[0] ?? '').replace(
    /[. ]+$/,
    '',
  );
  return name === '.git' || name === 'git~1';
}

export function normalizeRepoPath(path: unknown): string {
  if (typeof path !== 'string') invalid('must be a string');
  if (path.length === 0) invalid('must not be empty');
  if (!path.isWellFormed()) invalid('must be well-formed Unicode');
  if (Buffer.byteLength(path, 'utf8') > maxRepoPathBytes) {
    invalid(`must not exceed ${maxRepoPathBytes} bytes`);
  }
  if (forbiddenCharacters.test(path)) {
    invalid(
      'must not contain control characters, backslashes, or bidirectional formatting characters',
    );
  }
  if (path.startsWith('/') || drivePrefix.test(path)) {
    invalid('must be relative to the repository root');
  }
  for (const segment of path.split('/')) {
    if (segment === '') invalid('must not contain empty segments');
    if (segment === '.' || segment === '..') {
      invalid('must not contain . or .. segments');
    }
    if (isGitDirectoryName(segment)) {
      invalid('must not name the .git directory');
    }
  }
  return path;
}

// Groups of distinct paths, or distinct leading directories of paths, that
// are equal after Unicode NFC normalization. Two such names are separate Git
// entries but collapse into one file on a normalizing file system such as
// macOS, so neither can be trusted to mean what it says. Each group lists the
// exact names in code unit order; groups are ordered by their first name.
// Every input must already pass normalizeRepoPath.
export function findNormalizationCollisions(
  paths: Iterable<string>,
): string[][] {
  const namesByKey = new Map<string, Set<string>>();
  for (const path of paths) {
    normalizeRepoPath(path);
    let end = path.indexOf('/');
    for (;;) {
      const prefix = end === -1 ? path : path.slice(0, end);
      const key = prefix.normalize('NFC');
      const names = namesByKey.get(key) ?? new Set<string>();
      names.add(prefix);
      namesByKey.set(key, names);
      if (end === -1) break;
      end = path.indexOf('/', end + 1);
    }
  }
  const groups: string[][] = [];
  for (const names of namesByKey.values()) {
    if (names.size > 1) groups.push([...names].sort());
  }
  return groups.sort((a, b) => compareCodeUnits(a[0] ?? '', b[0] ?? ''));
}

export function assertNoNormalizationCollisions(paths: Iterable<string>): void {
  const groups = findNormalizationCollisions(paths);
  if (groups.length > 0) {
    throw new ValidationError(
      'path-normalization-collision',
      `${groups.length} group(s) of repository paths differ only by Unicode normalization.`,
    );
  }
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
