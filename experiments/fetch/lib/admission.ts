// Metadata-only admission and byte planning (§5.1, §5.4). A candidate blob
// is admitted for acquisition only when its tree entry is a regular file
// with a reviewed extension outside the prohibited directories, it is not
// ignored, and its advertised size is known and within the per-blob cap.
// The plan deduplicates object IDs across revisions and skips any blob that
// would exceed the aggregate cap; it never reads content.

export const defaultExtensions: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.vue',
  '.svelte',
  '.astro',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.cs',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hpp',
  '.hh',
  '.swift',
  '.rb',
  '.php',
  '.scala',
  '.sc',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.hs',
  '.lua',
  '.dart',
  '.sql',
];

export const defaultProhibitedDirectories: readonly string[] = [
  'node_modules',
  'vendor',
  'dist',
  'build',
  'generated',
  '.git',
];

// §5.4 hard maxima.
export const maxCandidateBlobBytes = 256 * 1024;
export const maxPlannedAcquisitionBytes = 100 * 1024 * 1024;

export interface AdmissionPolicy {
  readonly extensions: ReadonlySet<string>;
  readonly prohibitedDirectories: ReadonlySet<string>;
  readonly maxBlobBytes: number;
  readonly maxAggregateBytes: number;
}

export const defaultPolicy: AdmissionPolicy = {
  extensions: new Set(defaultExtensions),
  prohibitedDirectories: new Set(defaultProhibitedDirectories),
  maxBlobBytes: maxCandidateBlobBytes,
  maxAggregateBytes: maxPlannedAcquisitionBytes,
};

export interface Candidate {
  readonly path: string;
  // The revision the blob belongs to, for the record only.
  readonly revision: string;
  readonly mode: string;
  readonly oid: string;
  // Advertised by the remote (GitHub tree API or the fixture server), never
  // by the blobless local store.
  readonly advertisedSize: number | undefined;
}

export type ExclusionReason =
  | 'deleted'
  | 'symlink'
  | 'submodule'
  | 'not-regular'
  | 'extension'
  | 'prohibited-directory'
  | 'ignored'
  | 'unknown-size'
  | 'oversized'
  | 'aggregate-budget';

export interface Exclusion {
  readonly path: string;
  readonly revision: string;
  readonly reason: ExclusionReason;
}

export interface AdmissionPlan {
  readonly admitted: readonly Candidate[];
  readonly excluded: readonly Exclusion[];
  // Distinct blob IDs to acquire, in first-admitted order.
  readonly oids: readonly string[];
  readonly plannedBytes: number;
}

const zeroOid = /^0+$/;

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

function metadataReason(
  candidate: Candidate,
  policy: AdmissionPolicy,
  ignored: ReadonlySet<string>,
): ExclusionReason | undefined {
  if (zeroOid.test(candidate.oid) || candidate.mode === '000000')
    return 'deleted';
  if (candidate.mode === '120000') return 'symlink';
  if (candidate.mode === '160000') return 'submodule';
  if (candidate.mode !== '100644' && candidate.mode !== '100755')
    return 'not-regular';
  const directories = candidate.path.split('/').slice(0, -1);
  if (directories.some((name) => policy.prohibitedDirectories.has(name)))
    return 'prohibited-directory';
  if (!policy.extensions.has(extensionOf(candidate.path))) return 'extension';
  if (ignored.has(candidate.path)) return 'ignored';
  if (candidate.advertisedSize === undefined) return 'unknown-size';
  if (candidate.advertisedSize > policy.maxBlobBytes) return 'oversized';
  return undefined;
}

export function planAdmission(
  candidates: Iterable<Candidate>,
  ignored: ReadonlySet<string>,
  policy: AdmissionPolicy = defaultPolicy,
): AdmissionPlan {
  const admitted: Candidate[] = [];
  const excluded: Exclusion[] = [];
  const oids: string[] = [];
  const planned = new Set<string>();
  let plannedBytes = 0;
  for (const candidate of candidates) {
    const reason = metadataReason(candidate, policy, ignored);
    if (reason !== undefined) {
      excluded.push({
        path: candidate.path,
        revision: candidate.revision,
        reason,
      });
      continue;
    }
    if (!planned.has(candidate.oid)) {
      // metadataReason has already refused an unknown size.
      const size = candidate.advertisedSize as number;
      if (plannedBytes + size > policy.maxAggregateBytes) {
        excluded.push({
          path: candidate.path,
          revision: candidate.revision,
          reason: 'aggregate-budget',
        });
        continue;
      }
      planned.add(candidate.oid);
      oids.push(candidate.oid);
      plannedBytes += size;
    }
    admitted.push(candidate);
  }
  return { admitted, excluded, oids, plannedBytes };
}
