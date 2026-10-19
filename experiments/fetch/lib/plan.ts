// The pure planning steps of stage B: which manifest paths a round plans
// to acquire, which blob of each path at which revision is a candidate, and
// which ignored paths are the §5.1 hidden-reviewable condition. The spike's
// stage B (spike/prepare.ts) runs Git around these.
import { planAdmission } from './admission.ts';
import type { AdmissionPolicy, Candidate } from './admission.ts';
import { defaultPolicy } from './admission.ts';
import type { ManifestEntry } from './inventory.ts';

export type PlanScope = 'union' | 'narrowed';

// `union` is the whole §5.4 manifest. `narrowed` keeps the paths changed
// since the frontier and the paths that carry an open finding's evidence;
// without a frontier there is no delta, so it keeps everything.
export function selectManifest(
  manifest: readonly ManifestEntry[],
  scope: PlanScope,
  evidencePaths: ReadonlySet<string>,
  hasFrontier: boolean,
): readonly ManifestEntry[] {
  if (scope === 'union' || !hasFrontier) return manifest;
  return manifest.filter(
    (entry) => entry.incremental !== undefined || evidencePaths.has(entry.path),
  );
}

export interface PlanRevisions {
  readonly head: string;
  readonly mergeBase: string;
  readonly frontier?: string;
}

// Every blob a patch over the manifest can read: the head side of each path
// that still exists, the merge-base side of each cumulative change that had
// one, and the frontier side of each incremental change that had one.
export function manifestCandidates(
  manifest: readonly ManifestEntry[],
  revisions: PlanRevisions,
  sizeOf: (oid: string) => number | undefined,
): Candidate[] {
  const candidates: Candidate[] = [];
  const add = (path: string, revision: string, mode: string, oid: string) =>
    candidates.push({ path, revision, mode, oid, advertisedSize: sizeOf(oid) });
  for (const entry of manifest) {
    const change = entry.cumulative ?? entry.incremental;
    if (change === undefined) continue;
    if (change.status !== 'D')
      add(entry.path, revisions.head, change.newMode, change.newOid);
    if (entry.cumulative !== undefined && entry.cumulative.status !== 'A')
      add(
        entry.path,
        revisions.mergeBase,
        entry.cumulative.oldMode,
        entry.cumulative.oldOid,
      );
    if (
      entry.incremental !== undefined &&
      entry.incremental.status !== 'A' &&
      revisions.frontier !== undefined
    )
      add(
        entry.path,
        revisions.frontier,
        entry.incremental.oldMode,
        entry.incremental.oldOid,
      );
  }
  return candidates;
}

// A changed path that head's ignore rules hide and the trusted base tip's
// rules do not, and that would otherwise have been admitted at head.
export function hiddenReviewablePaths(
  ignoredAt: ReadonlyMap<string, readonly string[]>,
  head: string,
  baseTip: string,
  candidates: readonly Candidate[],
  policy: AdmissionPolicy = defaultPolicy,
): string[] {
  const hidden: string[] = [];
  for (const [path, revisions] of ignoredAt) {
    if (!revisions.includes(head) || revisions.includes(baseTip)) continue;
    const atHead = candidates.filter(
      (candidate) => candidate.path === path && candidate.revision === head,
    );
    if (planAdmission(atHead, new Set(), policy).admitted.length > 0)
      hidden.push(path);
  }
  return hidden.sort();
}
