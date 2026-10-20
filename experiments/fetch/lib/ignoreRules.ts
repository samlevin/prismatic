// Ignore rules for metadata admission (§5.1). Only `.gitignore` blobs that
// are regular, non-executable files with a known advertised size within
// ignoreFileMaxBytes are read; every other one is refused and reported.
// Admitted rules are written to a scratch repository and evaluated there
// with `git check-ignore --no-index -z`.
import type { TreeEntry } from './inventory.ts';

export const ignoreFileMaxBytes = 64 * 1024;

export interface IgnoreFiles {
  readonly admitted: readonly TreeEntry[];
  readonly refused: readonly TreeEntry[];
}

export function selectIgnoreFiles(
  entries: readonly TreeEntry[],
  sizeOf: (oid: string) => number | undefined,
): IgnoreFiles {
  const admitted: TreeEntry[] = [];
  const refused: TreeEntry[] = [];
  for (const entry of entries) {
    if (
      entry.type !== 'blob' ||
      (entry.path !== '.gitignore' && !entry.path.endsWith('/.gitignore'))
    )
      continue;
    const size = sizeOf(entry.oid);
    if (
      entry.mode === '100644' &&
      size !== undefined &&
      size <= ignoreFileMaxBytes
    )
      admitted.push(entry);
    else refused.push(entry);
  }
  return { admitted, refused };
}

export function parseCheckIgnore(output: Buffer): string[] {
  return output
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '');
}
