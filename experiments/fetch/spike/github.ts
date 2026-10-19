// The same stage A and stage B commands against a real GitHub repository:
// anonymous HTTPS, the normative Git options with no file-protocol override,
// sizes from the REST tree API, and the merge-base from the compare API.
// Only public, read-only endpoints are used, and nothing is checked out.
import { classifyAncestry } from '../lib/ancestry.ts';
import type { AncestryProbe } from '../lib/ancestry.ts';
import type { Client, Lab, StepRecord } from './lab.ts';
import { prepare } from './prepare.ts';
import { ScenarioBuilder } from './record.ts';
import type { ScenarioRecord } from './record.ts';

export interface GitHubTarget {
  readonly repository: string;
  readonly pullRequest: number;
  // An earlier head of the same PR, standing in for the last reviewed head.
  readonly priorHead: string;
}

const api = 'https://api.github.com';

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'prismatic-fetch-spike',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return response.json();
}

function field(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value))
    throw new Error(`GitHub returned no valid ${label}.`);
  return value;
}

// Advertised blob sizes from the recursive tree API. A truncated response is
// recorded; its missing entries stay unsized and cannot be admitted.
async function treeSizes(
  repository: string,
  commit: string,
  sizes: Map<string, number>,
): Promise<boolean> {
  const tree = await getJson(
    `${api}/repos/${repository}/git/trees/${commit}?recursive=1`,
  );
  const entries = field(tree, 'tree');
  if (Array.isArray(entries))
    for (const entry of entries) {
      const oid = field(entry, 'sha');
      const size = field(entry, 'size');
      if (
        field(entry, 'type') === 'blob' &&
        typeof oid === 'string' &&
        typeof size === 'number'
      )
        sizes.set(oid, size);
    }
  return field(tree, 'truncated') === true;
}

function probe(
  lab: Lab,
  client: Client,
  head: string,
  prior: string,
  steps: StepRecord[],
): AncestryProbe {
  return {
    async fetchPrior() {
      const fetched = await lab.fetchCommits(
        client,
        'fetch prior head, depth 1, blob:none',
        [prior],
        { depth: 1 },
      );
      steps.push(fetched.record);
      return fetched.value.status === 0;
    },
    async isAncestor() {
      return (
        (
          await lab.git.run(client.dir, [
            'merge-base',
            '--is-ancestor',
            prior,
            head,
          ])
        ).status === 0
      );
    },
    async historyComplete() {
      const result = await lab.git.ok(client.dir, [
        'rev-parse',
        '--is-shallow-repository',
      ]);
      return result.stdout.toString('utf8').trim() === 'false';
    },
    async deepen(commits) {
      const fetched = await lab.fetchCommits(
        client,
        `deepen by ${commits}, blob:none`,
        [head, prior],
        { deepen: commits },
      );
      steps.push(fetched.record);
      return fetched.value.status === 0;
    },
  };
}

export async function githubScenario(
  lab: Lab,
  target: GitHubTarget,
): Promise<ScenarioRecord> {
  const s = new ScenarioBuilder(
    'github-sandbox',
    [1, 2, 3],
    `GitHub sandbox: ${target.repository} pull request ${target.pullRequest}`,
  );
  const pull = await getJson(
    `${api}/repos/${target.repository}/pulls/${target.pullRequest}`,
  );
  const head = sha(field(pull, 'head', 'sha'), 'head SHA');
  const baseTip = sha(field(pull, 'base', 'sha'), 'base SHA');
  const compare = await getJson(
    `${api}/repos/${target.repository}/compare/${baseTip}...${head}`,
  );
  // Only the merge-base is kept; the compare payload's file patches are
  // PR-authored content and are dropped unread.
  const mergeBase = sha(
    field(compare, 'merge_base_commit', 'sha'),
    'merge-base',
  );
  const sizes = new Map<string, number>();
  const truncated: string[] = [];
  for (const commit of new Set([baseTip, mergeBase, head]))
    if (await treeSizes(target.repository, commit, sizes))
      truncated.push(commit);

  const client = await lab.createClient(
    'github',
    `https://github.com/${target.repository}.git`,
  );
  const stageA = s.step(
    await lab.fetchCommits(
      client,
      'stage A: base tip, depth 1, blob:none',
      [baseTip],
      { depth: 1 },
    ),
  );
  s.check(
    'stage A: blobless fetch of the base tip succeeds with no blobs',
    stageA.value.status === 0 && stageA.record.acquired.byType.blob.count === 0,
    stageA.record.acquired.byType,
  );
  const ref = `refs/pull/${target.pullRequest}/head`;
  const pr = s.step(
    await lab.step(client.dir, `stage B: ${ref}, depth 1, blob:none`, [
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--recurse-submodules=no',
      '--filter=blob:none',
      '--depth=1',
      'origin',
      `+${ref}:refs/spike/head`,
    ]),
  );
  const resolved = (
    await lab.git.ok(client.dir, ['rev-parse', 'refs/spike/head'])
  ).stdout
    .toString('utf8')
    .trim();
  s.check(
    'the fetched PR ref resolves to the head SHA the API reported',
    pr.value.status === 0 && resolved === head,
    { resolved, head },
  );
  const mb = s.step(
    await lab.fetchCommits(
      client,
      'stage B: merge-base by SHA, depth 1, blob:none',
      [mergeBase],
      { depth: 1 },
    ),
  );
  s.check(
    'stage B commit fetches acquire no blobs',
    pr.record.acquired.byType.blob.count === 0 &&
      mb.record.acquired.byType.blob.count === 0,
  );

  const prep = await prepare(lab, client, {
    revisions: { head, mergeBase, baseTip },
    scope: 'union',
    sizeOf: (oid) => sizes.get(oid),
    skipCommitFetch: true,
  });
  for (const step of prep.steps) s.step({ record: step });
  s.check(
    'acquired blobs equal the planned blob IDs exactly',
    prep.acquisition.exact,
    prep.acquisition,
  );

  const info = s.step(
    await lab.step(
      client.dir,
      'remote-object-info against GitHub',
      ['cat-file', '--batch-command=%(objectname) %(objectsize)'],
      {
        input: `remote-object-info origin ${prep.planned.oids[0] ?? head}\n`,
      },
    ),
  );
  s.check(
    'GitHub does not offer remote-object-info, so sizes come from the tree API',
    info.value.status !== 0,
    info.record.stderr,
  );

  const headTree = await lab.lsTree(client.dir, head);
  const acquired = new Set(prep.acquiredBlobs.map((o) => o.oid));
  const outside = headTree.entries.find(
    (e) =>
      e.type === 'blob' &&
      !acquired.has(e.oid) &&
      !prep.ignored.ignoredAt.has(e.path) &&
      e.path !== '.gitignore',
  );
  if (outside) {
    const read = s.step(
      await lab.step(client.dir, 'cat-file of an unacquired blob', [
        'cat-file',
        'blob',
        outside.oid,
      ]),
    );
    s.check(
      'reading an unacquired blob fails without fetching',
      read.value.status !== 0 && read.record.acquired.objects.length === 0,
      read.record.stderr,
    );
  }

  const ancestryClient = await lab.createClient(
    'github-ancestry',
    `https://github.com/${target.repository}.git`,
  );
  const steps: StepRecord[] = [];
  const first = await lab.fetchCommits(
    ancestryClient,
    'fetch head, depth 1, blob:none',
    [head],
    { depth: 1 },
  );
  steps.push(first.record);
  const ancestry = await classifyAncestry(
    probe(lab, ancestryClient, head, target.priorHead, steps),
    { maxSteps: 8, commitsPerStep: 25 },
  );
  const unknown = await classifyAncestry(
    probe(
      lab,
      ancestryClient,
      head,
      'fedcba9876543210fedcba9876543210fedcba98',
      steps,
    ),
    { maxSteps: 8, commitsPerStep: 25 },
  );
  for (const step of steps) s.step({ record: step });
  s.check(
    'a shallow prior head is proved an ancestor by blobless deepening',
    ancestry.ancestry === 'ancestor',
    ancestry,
  );
  s.check(
    'an unfetchable prior head is unknown',
    unknown.ancestry === 'unknown',
    unknown,
  );
  s.check(
    'ancestry work acquires no blobs',
    steps.every((step) => step.acquired.byType.blob.count === 0),
  );

  s.data({
    repository: target.repository,
    pullRequest: target.pullRequest,
    revisions: { head, baseTip, mergeBase, priorHead: target.priorHead },
    truncatedTrees: truncated,
    changedPaths: prep.cumulative.length,
    eligible: prep.eligible,
    excluded: prep.planned.excluded,
    acquiredBlobs: prep.acquiredBlobs.map((o) => ({
      oid: o.oid,
      size: o.size,
    })),
    plannedBytes: prep.planned.plannedBytes,
    packBytes: s
      .build()
      .steps.reduce((sum, step) => sum + step.packBytesAdded, 0),
    ancestry,
  });
  return s.build();
}
