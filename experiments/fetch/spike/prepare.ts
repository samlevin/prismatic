// Stage B as §5.4 describes it, built from the spike's primitives: blobless
// commits, raw changed paths, the union manifest, ignore rules, metadata
// admission, blob acquisition by ID, the content probe, and the patches.
// Each step's acquired objects are recorded. `scope: narrowed` is the
// pipeline reorder P0.8 is asked to evaluate: it plans acquisition from the
// incremental delta and the open findings' evidence paths only.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { planAdmission } from '../lib/admission.ts';
import type { AdmissionPlan } from '../lib/admission.ts';
import {
  hiddenReviewablePaths,
  manifestCandidates,
  selectManifest,
} from '../lib/plan.ts';
import {
  ignoreFileMaxBytes,
  parseCheckIgnore,
  selectIgnoreFiles,
} from '../lib/ignoreRules.ts';
import { parseLsTree, unionManifest } from '../lib/inventory.ts';
import type {
  ChangedPath,
  ManifestEntry,
  RejectedName,
} from '../lib/inventory.ts';
import {
  absentFrom,
  summarizeObjects,
  verifyAcquisition,
} from '../lib/objectStore.ts';
import type { AcquisitionCheck, StoredObject } from '../lib/objectStore.ts';
import { probeContent } from '../lib/probe.ts';
import { literalPathspec } from '../lib/sparsePattern.ts';
import { nodeSpawner } from '../lib/processRunner.ts';
import type { StepRecord } from '../lib/scenarioRecord.ts';
import type { Client, Lab } from './lab.ts';

const acquisitionBatchSize = 5000;
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
  readonly acquisition: AcquisitionCheck;
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

// ADR 0004, decision 3: fetch only the planned blobs the store lacks, then
// check the store against the whole plan.
async function acquirePlanned(
  lab: Lab,
  client: Client,
  label: string,
  planned: readonly string[],
  steps: StepRecord[],
): Promise<{ check: AcquisitionCheck; blobs: StoredObject[] }> {
  const requested = absentFrom(await lab.inventory(client.dir), planned);
  const blobs: StoredObject[] = [];
  for (let index = 0; index < requested.length; index += acquisitionBatchSize) {
    const acquired = await lab.acquireBlobs(
      client,
      `${label}, batch ${index / acquisitionBatchSize + 1}`,
      requested.slice(index, index + acquisitionBatchSize),
    );
    steps.push(acquired.record);
    if (acquired.value.status !== 0) throw new Error(acquired.record.stderr);
    blobs.push(
      ...acquired.record.acquired.objects.filter((o) => o.type === 'blob'),
    );
  }
  const check = verifyAcquisition(
    planned,
    await lab.inventory(client.dir),
    summarizeObjects(blobs),
  );
  return { check, blobs };
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
    const rules = selectIgnoreFiles(listing.entries, sizeOf);
    for (const entry of rules.refused)
      refused.push(`${revision.slice(0, 12)}:${entry.path}`);
    const oids = [...new Set(rules.admitted.map((entry) => entry.oid))];
    const { check } = await acquirePlanned(
      lab,
      client,
      `ignore rules at ${revision.slice(0, 12)}`,
      oids,
      steps,
    );
    if (!check.exact)
      throw new Error(
        `Ignore rules at ${revision} were not acquired as planned: ${JSON.stringify(check)}`,
      );
    const blobs = await lab.readBlobs(
      client.dir,
      oids,
      oids.length * ignoreFileMaxBytes,
    );
    const scratch = lab.scratchDir(`ignore-${revision.slice(0, 12)}`);
    await lab.git.ok(lab.root, ['init', '--quiet', scratch]);
    for (const entry of rules.admitted) {
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
    for (const ignored of parseCheckIgnore(result.stdout))
      ignoredAt.set(ignored, [...(ignoredAt.get(ignored) ?? []), revision]);
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
  return parseLsTree(listing.stdout).entries.find(
    (entry) => entry.type === 'blob',
  );
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
  const manifest = selectManifest(
    fullManifest,
    options.scope,
    findingPaths,
    frontier !== undefined,
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

  const candidates = manifestCandidates(
    manifest,
    { head, mergeBase, ...(frontier === undefined ? {} : { frontier }) },
    options.sizeOf,
  );
  // Baseline-side blobs of the paths that carry a finding's evidence.
  for (const finding of findings) {
    const blob = await blobAt(lab, client.dir, finding.baseline, finding.path);
    if (blob)
      candidates.push({
        path: finding.path,
        revision: finding.baseline,
        mode: blob.mode,
        oid: blob.oid,
        advertisedSize: options.sizeOf(blob.oid),
      });
  }
  const planned = planAdmission(candidates, ignoredPaths);

  const { check: acquisition, blobs: acquiredBlobs } = await acquirePlanned(
    lab,
    client,
    'admitted blobs',
    planned.oids,
    steps,
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
  const hiddenReviewable = hiddenReviewablePaths(
    ignored.ignoredAt,
    head,
    baseTip,
    candidates,
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
