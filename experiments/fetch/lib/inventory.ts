// Parsers for the metadata the fetch plan is built from: `git ls-tree -r -z`
// (optionally with `-l`) and `git diff --raw --no-renames -z`. Both need
// trees only, so they run on a blobless store. Paths arrive as raw bytes; a
// path that is not valid UTF-8 or fails normalizeRepoPath is reported, never
// repaired, because a repaired name would no longer match the Git entry.
import { normalizeRepoPath } from '../../../src/shared/path.ts';

export type PathDecoding =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: 'invalid-utf8' | 'invalid-path' };

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export function decodeRepoPath(bytes: Uint8Array): PathDecoding {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return { ok: false, reason: 'invalid-utf8' };
  }
  try {
    return { ok: true, path: normalizeRepoPath(text) };
  } catch {
    return { ok: false, reason: 'invalid-path' };
  }
}

// One rejected name. Only its byte length and a hex prefix are kept, so a
// hostile name never reaches a log as text.
export interface RejectedName {
  readonly reason: 'invalid-utf8' | 'invalid-path';
  readonly byteLength: number;
  readonly hexPrefix: string;
}

function rejectedName(
  bytes: Uint8Array,
  reason: RejectedName['reason'],
): RejectedName {
  return {
    reason,
    byteLength: bytes.length,
    hexPrefix: Buffer.from(bytes.subarray(0, 16)).toString('hex'),
  };
}

function* nulFields(buffer: Buffer): Generator<Buffer> {
  let start = 0;
  while (start < buffer.length) {
    const end = buffer.indexOf(0, start);
    if (end === -1) throw new Error('Output does not end with NUL.');
    yield buffer.subarray(start, end);
    start = end + 1;
  }
}

export interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly oid: string;
  // Present with `-l` for a blob whose object is local. Git prints `BAD`
  // for a blob the blobless store lacks, and `-` for trees and gitlinks;
  // both become undefined.
  readonly size?: number;
}

export interface TreeListing {
  readonly entries: readonly TreeEntry[];
  readonly rejected: readonly RejectedName[];
}

const treeLine =
  /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}(?:[0-9a-f]{24})?)(?: +(\d+|-|BAD))?$/;

export function parseLsTree(output: Buffer): TreeListing {
  const entries: TreeEntry[] = [];
  const rejected: RejectedName[] = [];
  for (const record of nulFields(output)) {
    const tab = record.indexOf(9);
    if (tab === -1) throw new Error('ls-tree record has no tab.');
    const match = treeLine.exec(record.subarray(0, tab).toString('latin1'));
    if (match === null) throw new Error('Unexpected ls-tree record.');
    const [, mode, type, oid, size] = match;
    const nameBytes = record.subarray(tab + 1);
    const decoded = decodeRepoPath(nameBytes);
    if (!decoded.ok) {
      rejected.push(rejectedName(nameBytes, decoded.reason));
      continue;
    }
    entries.push({
      path: decoded.path,
      mode: mode as string,
      type: type as TreeEntry['type'],
      oid: oid as string,
      ...(size !== undefined && /^\d+$/.test(size)
        ? { size: Number(size) }
        : {}),
    });
  }
  return { entries, rejected };
}

export type ChangeStatus = 'A' | 'D' | 'M' | 'T';

export interface ChangedPath {
  readonly path: string;
  readonly status: ChangeStatus;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldOid: string;
  readonly newOid: string;
}

export interface RawDiff {
  readonly changes: readonly ChangedPath[];
  readonly rejected: readonly RejectedName[];
}

const rawHeader =
  /^:(\d{6}) (\d{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([ADMT])$/;

// `git diff --raw --no-renames -z` prints the header and the path as two
// NUL-terminated fields. Rename and copy records have two paths; they cannot
// appear with --no-renames, so meeting one is an error.
export function parseRawDiff(output: Buffer): RawDiff {
  const changes: ChangedPath[] = [];
  const rejected: RejectedName[] = [];
  const fields = nulFields(output);
  for (const header of fields) {
    const match = rawHeader.exec(header.toString('latin1'));
    if (match === null)
      throw new Error('Unexpected raw diff header; renames must be off.');
    const name = fields.next();
    if (name.done === true) throw new Error('Raw diff record has no path.');
    const [, oldMode, newMode, oldOid, newOid, status] = match;
    const decoded = decodeRepoPath(name.value);
    if (!decoded.ok) {
      rejected.push(rejectedName(name.value, decoded.reason));
      continue;
    }
    changes.push({
      path: decoded.path,
      status: status as ChangeStatus,
      oldMode: oldMode as string,
      newMode: newMode as string,
      oldOid: oldOid as string,
      newOid: newOid as string,
    });
  }
  return { changes, rejected };
}

export interface ManifestEntry {
  readonly path: string;
  readonly cumulative?: ChangedPath;
  readonly incremental?: ChangedPath;
}

// The §5.4 provisional manifest: every path changed between the merge-base
// and head, plus every path changed since the last reviewed head. A file
// reverted to its merge-base content has no cumulative change but stays in
// the manifest through its incremental one.
export function unionManifest(
  cumulative: readonly ChangedPath[],
  incremental: readonly ChangedPath[] = [],
): readonly ManifestEntry[] {
  const byPath = new Map<string, ManifestEntry>();
  for (const change of cumulative)
    byPath.set(change.path, { path: change.path, cumulative: change });
  for (const change of incremental) {
    const existing = byPath.get(change.path);
    byPath.set(change.path, {
      ...(existing ?? { path: change.path }),
      incremental: change,
    });
  }
  return [...byPath.values()].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
}
