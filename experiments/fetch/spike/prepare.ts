// Stage B as §5.4 describes it, built from the spike's primitives: blobless
// commits, raw changed paths, the union manifest, ignore rules, metadata
// admission, exact blob acquisition, the content probe, and the patches.
// Each step's acquired objects are recorded. `scope: narrowed` is the
// pipeline reorder P0.8 is asked to evaluate: it plans acquisition from the
// incremental delta and the open findings' evidence paths only.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { planAdmission } from '../lib/admission.ts';
import type { AdmissionPlan, Candidate } from '../lib/admission.ts';
import { unionManifest } from '../lib/inventory.ts';
import type {
  ChangedPath,
  ManifestEntry,
  RejectedName,
} from '../lib/inventory.ts';
import { compareBlobSets, summarizeObjects } from '../lib/objectStore.ts';
import type { SetComparison, StoredObject } from '../lib/objectStore.ts';
import { probeContent } from '../lib/probe.ts';
import { literalPathspec } from '../lib/sparsePattern.ts';
import { nodeSpawner } from '../lib/processRunner.ts';
import type { Client, Lab, StepRecord } from './lab.ts';

export const ignoreFileMaxBytes = 64 * 1024;
export const acquisitionBatchSize = 5000;
const astGrepPath = '/usr/local/bin/ast-grep';

export interface Revisions {
  readonly head: string;
  readonly mergeBase: string;
  readonly baseTip: string;
  readonly frontier?: string;
}

export interface Finding {
  readonly id: string;
  readonly path: string;
  // lastAttempt.sha, the finding's assessment baseline.
  readonly baseline: string;
}

export interface PrepareOptions {
  readonly revisions: Revisions;
  readonly findings?: readonly Finding[];
  readonly scope: 'union' | 'narrowed';
  // Advertised blob size by object ID, from the remote.
  readonly sizeOf: (oid: string) => number | undefined;
  // Commits already fetched by an earlier stage.
  readonly skipCommitFetch?: boolean;
  // Parse every eligible head file with the pinned ast-grep, to measure
  // what indexing the manifest costs.
  readonly parse?: boolean;
}

export interface IgnoreResult {
  readonly ignoredAt: ReadonlyMap<string, readonly string[]>;
  readonly ignoreFiles: number;
  readonly refusedIgnoreFiles: readonly string[];
}

export interface Preparation {
  readonly steps: readonly StepRecord[];
  readonly cumulative: readonly ChangedPath[];
  readonly incremental: readonly ChangedPath[];
  readonly rejectedNames: readonly RejectedName[];
  readonly manifest: readonly ManifestEntry[];
  readonly planned: AdmissionPlan;
  readonly acquisition: SetComparison;
  readonly acquiredBlobs: readonly StoredObject[];
  readonly eligible: readonly string[];
  readonly probeRejected: readonly { path: string; contentClass: string }[];
  readonly hiddenReviewable: readonly string[];
  readonly ignored: IgnoreResult;
  readonly filesReadForIndex: number;
  readonly bytesReadForIndex: number;
  readonly parseMs?: number;
  readonly patchBytes: number;
  readonly patchMs: number;
  readonly wallClockMs: number;
}

// Materializes only the bounded `.gitignore` blobs of one revision as
// regular files in a scratch repository, then asks `git check-ignore
// --no-index` about the candidate paths. Nothing else from the revision is
// written to disk.
export async function evaluateIgnores(
  lab: Lab,
  client: Client,
  revisions: readonly string[],
  paths: readonly string[],
  sizeOf: (oid: string) => number | undefined,
  steps: StepRecord[],
): Promise<IgnoreResult> {
  const ignoredAt = new Map<string, string[]>();
  const refused: string[] = [];
  let ignoreFiles = 0;
  for (const revision of new Set(revisions)) {
    const listing = await lab.lsTree(client.dir, revision);
    const rules = listing.entries.filter(
      (entry) =>
        entry.type === 'blob' &&
        (entry.path === '.gitignore' || entry.path.endsWith('/.gitignore')),
    );
    const admitted = rules.filter((entry) => {
      const size = sizeOf(entry.oid);
      const ok =
        entry.mode === '100644' &&
        size !== undefined &&
        size <= ignoreFileMaxBytes;
      if (!ok) refused.push(`${revision.slice(0, 12)}:${entry.path}`);
      return ok;
    });
    if (admitted.length > 0) {
      const acquired = await lab.acquireBlobs(
        client,
        `ignore rules at ${revision.slice(0, 12)}`,
        [...new Set(admitted.map((entry) => entry.oid))],
      );
      steps.push(acquired.record);
    }
    const blobs = await lab.readBlobs(
      client.dir,
      admitted.map((entry) => entry.oid),
      admitted.length * ignoreFileMaxBytes,
    );
    const scratch = lab.scratchDir(`ignore-${revision.slice(0, 12)}`);
    await lab.git.ok(lab.root, ['init', '--quiet', scratch]);
    for (const entry of admitted) {
      const target = path.join(scratch, ...entry.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, blobs.get(entry.oid) ?? Buffer.alloc(0), {
        flag: 'wx',
      });
      ignoreFiles += 1;
    }
    const result = await lab.git.run(
      scratch,
      ['check-ignore', '--no-index', '--stdin', '-z'],
      {
        input: paths.map((p) => `${p}\0`).join(''),
      },
    );
    if (result.status !== 0 && result.status !== 1)
      throw new Error(`check-ignore failed: ${result.stderr}`);
    for (const ignored of result.stdout.toString('utf8').split('\0')) {
      if (ignored === '') continue;
      ignoredAt.set(ignored, [...(ignoredAt.get(ignored) ?? []), revision]);
    }
  }
  return { ignoredAt, ignoreFiles, refusedIgnoreFiles: refused };
}

async function blobAt(lab: Lab, repo: string, revision: string, file: string) {
  const listing = await lab.git.ok(repo, [
    'ls-tree',
    '-z',
    '--full-tree',
    revision,
    '--',
    literalPathspec(file),
  ]);
  const match = /^(\d{6}) blob ([0-9a-f]{40})\t/.exec(
    listing.stdout.toString('utf8'),
  );
  return match === null
    ? undefined
    : { mode: match[1] as string, oid: match[2] as string };
}

export async function prepare(
  lab: Lab,
  client: Client,
  options: PrepareOptions,
): Promise<Preparation> {
  const started = performance.now();
  const steps: StepRecord[] = [];
  const { head, mergeBase, baseTip, frontier } = options.revisions;
  const findings = options.findings ?? [];
  const baselines = [...new Set(findings.map((finding) => finding.baseline))];
  if (options.skipCommitFetch !== true) {
    const stageA = await lab.fetchCommits(
      client,
      'stage A: base tip commit and trees',
      [baseTip],
      { depth: 1 },
    );
    steps.push(stageA.record);
    if (stageA.value.status !== 0) throw new Error(stageA.record.stderr);
    const commits = [
      ...new Set([
        head,
        mergeBase,
        ...(frontier ? [frontier] : []),
        ...baselines,
      ]),
    ];
    const fetched = await lab.fetchCommits(
      client,
      'stage B commits and trees',
      commits,
      { depth: 1 },
    );
    steps.push(fetched.record);
    if (fetched.value.status !== 0) throw new Error(fetched.record.stderr);
  }

  const cumulativeDiff = await lab.rawDiff(client.dir, mergeBase, head);
  const incrementalDiff = frontier
    ? await lab.rawDiff(client.dir, frontier, head)
    : { changes: [], rejected: [] };
  const fullManifest = unionManifest(
    cumulativeDiff.changes,
    incrementalDiff.changes,
  );
  const findingPaths = new Set(findings.map((finding) => finding.path));
  const deltaPaths = new Set(
    incrementalDiff.changes.map((change) => change.path),
  );
  const manifest =
    options.scope === 'union'
      ? fullManifest
      : fullManifest.filter(
          (entry) =>
            deltaPaths.has(entry.path) ||
            findingPaths.has(entry.path) ||
            frontier === undefined,
        );

  // Ignore rules from the trusted base tip and from head decide admission;
  // the merge-base rules also apply to old-side reads.
  const ignored = await evaluateIgnores(
    lab,
    client,
    [baseTip, head, mergeBase],
    manifest.map((entry) => entry.path),
    options.sizeOf,
    steps,
  );
  const ignoredPaths = new Set(ignored.ignoredAt.keys());

  const candidates: Candidate[] = [];
  const add = (
    entry: string,
    revision: string,
    mode: string,
    oid: string,
  ): void => {
    candidates.push({
      path: entry,
      revision,
      mode,
      oid,
      advertisedSize: options.sizeOf(oid),
    });
  };
  for (const entry of manifest) {
    const change = entry.cumulative ?? entry.incremental;
    if (change === undefined) continue;
    if (change.status !== 'D')
      add(entry.path, head, change.newMode, change.newOid);
    if (entry.cumulative && entry.cumulative.status !== 'A')
      add(
        entry.path,
        mergeBase,
        entry.cumulative.oldMode,
        entry.cumulative.oldOid,
      );
    if (entry.incremental && entry.incremental.status !== 'A' && frontier)
      add(
        entry.path,
        frontier,
        entry.incremental.oldMode,
        entry.incremental.oldOid,
      );
  }
  // Baseline-side blobs of the paths that carry a finding's evidence.
  for (const finding of findings) {
    const blob = await blobAt(lab, client.dir, finding.baseline, finding.path);
    if (blob) add(finding.path, finding.baseline, blob.mode, blob.oid);
  }
  const planned = planAdmission(candidates, ignoredPaths);

  const acquiredBlobs: StoredObject[] = [];
  for (
    let index = 0;
    index < planned.oids.length;
    index += acquisitionBatchSize
  ) {
    const batch = planned.oids.slice(index, index + acquisitionBatchSize);
    const acquired = await lab.acquireBlobs(
      client,
      `admitted blobs ${index / acquisitionBatchSize + 1}`,
      batch,
    );
    steps.push(acquired.record);
    if (acquired.value.status !== 0) throw new Error(acquired.record.stderr);
    acquiredBlobs.push(
      ...acquired.record.acquired.objects.filter((o) => o.type === 'blob'),
    );
  }
  const acquisition = compareBlobSets(
    planned.oids,
    summarizeObjects(acquiredBlobs),
  );

  // Probe the head side; a binary or LFS pointer never becomes eligible.
  const headSide = planned.admitted.filter(
    (candidate) => candidate.revision === head,
  );
  const bodies = await lab.readBlobs(
    client.dir,
    [...new Set(headSide.map((candidate) => candidate.oid))],
    planned.plannedBytes,
  );
  const eligible: string[] = [];
  const probeRejected: { path: string; contentClass: string }[] = [];
  let bytesReadForIndex = 0;
  for (const candidate of headSide) {
    const body = bodies.get(candidate.oid) ?? Buffer.alloc(0);
    const probe = probeContent(body);
    if (probe.contentClass === 'text') {
      eligible.push(candidate.path);
      bytesReadForIndex += body.length;
    } else
      probeRejected.push({
        path: candidate.path,
        contentClass: probe.contentClass,
      });
  }

  let parseMs: number | undefined;
  if (options.parse === true && eligible.length > 0) {
    // Regular files with neutral names in a fresh directory: the pinned
    // ast-grep parses each one fully looking for a pattern that never
    // matches, so the time is parse time, not output time.
    const scratch = lab.scratchDir('parse');
    await mkdir(scratch, { recursive: true });
    const eligibleBodies = headSide.filter((candidate) =>
      eligible.includes(candidate.path),
    );
    let index = 0;
    for (const candidate of eligibleBodies) {
      index += 1;
      await writeFile(
        path.join(scratch, `${index}.ts`),
        bodies.get(candidate.oid) ?? Buffer.alloc(0),
        { flag: 'wx' },
      );
    }
    const parsed = await nodeSpawner(
      astGrepPath,
      [
        'run',
        '--lang',
        'typescript',
        '--pattern',
        'prismaticSpikeNeverMatches($A)',
        scratch,
      ],
      {
        cwd: scratch,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: scratch },
        timeoutMs: 5 * 60 * 1000,
        maxOutputBytes: 1024 * 1024,
      },
    );
    if (parsed.status !== 0 && parsed.status !== 1)
      throw new Error(`ast-grep failed: ${parsed.stderr}`);
    parseMs = Math.round(parsed.elapsedMs);
  }

  // Patches over literal eligible paths only. Old-side blobs of eligible
  // paths were admitted with them.
  const patchStarted = performance.now();
  let patchBytes = 0;
  if (eligible.length > 0) {
    const pathspecs = eligible.map(literalPathspec);
    const diffArgs = [
      'diff',
      '-p',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
    ];
    const cumulativePatch = await lab.git.ok(client.dir, [
      ...diffArgs,
      mergeBase,
      head,
      '--',
      ...pathspecs,
    ]);
    patchBytes += cumulativePatch.stdout.length;
    if (frontier) {
      const incrementalEligible = eligible
        .filter((p) => deltaPaths.has(p))
        .map(literalPathspec);
      if (incrementalEligible.length > 0) {
        const incrementalPatch = await lab.git.ok(client.dir, [
          ...diffArgs,
          frontier,
          head,
          '--',
          ...incrementalEligible,
        ]);
        patchBytes += incrementalPatch.stdout.length;
      }
    }
  }
  const patchMs = performance.now() - patchStarted;

  // A changed path ignored only under head's rules, which would otherwise be
  // eligible, is the §5.1 hidden-reviewable condition.
  const hiddenReviewable = [...ignored.ignoredAt.entries()]
    .filter(
      ([, revisions]) =>
        revisions.includes(head) && !revisions.includes(baseTip),
    )
    .map(([file]) => file)
    .filter(
      (file) =>
        planAdmission(
          candidates.filter(
            (candidate) =>
              candidate.path === file && candidate.revision === head,
          ),
          new Set(),
        ).admitted.length > 0,
    );

  return {
    steps,
    cumulative: cumulativeDiff.changes,
    incremental: incrementalDiff.changes,
    rejectedNames: [...cumulativeDiff.rejected, ...incrementalDiff.rejected],
    manifest,
    planned,
    acquisition,
    acquiredBlobs,
    eligible,
    probeRejected,
    hiddenReviewable,
    ignored,
    filesReadForIndex: eligible.length,
    bytesReadForIndex,
    ...(parseMs === undefined ? {} : { parseMs }),
    patchBytes,
    patchMs: Math.round(patchMs),
    wallClockMs: Math.round(performance.now() - started),
  };
}
