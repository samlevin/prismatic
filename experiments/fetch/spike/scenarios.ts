// Scenarios on the review fixture: blobless inventory, admission and
// probes, acquisition by blob ID, the backfill alternative, lazy-fetch
// refusal, and ancestry.
import path from 'node:path';
import { classifyAncestry } from '../lib/ancestry.ts';
import type { AncestryProbe } from '../lib/ancestry.ts';
import { sparseFileFor, literalPathspec } from '../lib/sparsePattern.ts';
import { ScenarioBuilder } from '../lib/scenarioRecord.ts';
import type { ScenarioRecord, StepRecord } from '../lib/scenarioRecord.ts';
import type { Client, Lab, Server } from './lab.ts';
import { prepare } from './prepare.ts';
import {
  marks,
  newlineName,
  reviewFixture,
  specialNames,
} from './reviewFixture.ts';

export interface ReviewContext {
  readonly server: Server;
  readonly sizes: ReadonlyMap<string, number>;
  readonly commit: (mark: number) => string;
}

export async function createReviewContext(lab: Lab): Promise<ReviewContext> {
  const server = await lab.createServer('review', reviewFixture());
  const commit = (mark: number): string => {
    const sha = server.commits.get(mark);
    if (sha === undefined) throw new Error(`No commit for mark ${mark}.`);
    return sha;
  };
  const sizes = new Map<string, number>();
  for (const mark of [
    marks.mergeBase,
    marks.priorHead,
    marks.head,
    marks.rewrittenHead,
    marks.baseTip,
  ])
    for (const [oid, size] of await lab.advertisedSizes(server, commit(mark)))
      sizes.set(oid, size);
  return { server, sizes, commit };
}

const blobsOf = (record: StepRecord): number =>
  record.acquired.byType.blob.count;

export async function inventoryScenario(
  lab: Lab,
  ctx: ReviewContext,
): Promise<ScenarioRecord> {
  const s = new ScenarioBuilder(
    'raw-inventory',
    [1, 2],
    'Blobless inventory and raw changed paths with --no-renames',
  );
  const client = await lab.createClient('inventory', ctx.server.url);
  const head = ctx.commit(marks.head);
  const mergeBase = ctx.commit(marks.mergeBase);
  const fetched = s.step(
    await lab.fetchCommits(
      client,
      'fetch head and merge-base, depth 1, blob:none',
      [head, mergeBase],
      { depth: 1 },
    ),
  );
  s.check(
    'blobless fetch succeeds',
    fetched.value.status === 0,
    fetched.record.status,
  );
  s.check(
    'blobless fetch acquires no blobs',
    blobsOf(fetched.record) === 0,
    fetched.record.acquired.byType,
  );

  const before = await lab.inventory(client.dir);
  const diff = await lab.rawDiff(client.dir, mergeBase, head);
  const listing = await lab.lsTree(client.dir, head, true);
  const after = await lab.inventory(client.dir);
  s.check('raw diff and ls-tree read no blobs', before.size === after.size, {
    before: before.size,
    after: after.size,
  });
  const statuses = Object.fromEntries(
    diff.changes.map((change) => [change.path, change.status]),
  );
  s.check(
    'a rename is a delete plus an add',
    statuses['src/f2.ts'] === 'D' && statuses['src/f2-renamed.ts'] === 'A',
    {
      'src/f2.ts': statuses['src/f2.ts'],
      'src/f2-renamed.ts': statuses['src/f2-renamed.ts'],
    },
  );
  s.check(
    'a symlink change keeps mode 120000',
    diff.changes.some(
      (c) => c.path === 'src/link.ts' && c.newMode === '120000',
    ),
  );
  s.check(
    'a submodule change keeps mode 160000',
    diff.changes.some((c) => c.path === 'vendor/sub' && c.newMode === '160000'),
  );
  s.check(
    'names that are not valid UTF-8 or fail path rules are reported, not repaired',
    diff.rejected.length === 2 &&
      diff.rejected.some((r) => r.reason === 'invalid-utf8') &&
      diff.rejected.some((r) => r.reason === 'invalid-path'),
    diff.rejected,
  );
  s.check(
    'ls-tree -l cannot size missing blobs, so sizes must come from the remote',
    listing.entries
      .filter((e) => e.type === 'blob')
      .every((e) => e.size === undefined),
    listing.entries.filter((e) => e.size !== undefined).length,
  );

  // Git 2.56 can ask the server for object sizes without fetching content.
  // GitHub does not advertise the capability (see the github scenario).
  const sample = diff.changes.find((change) => change.path === 'src/app.ts');
  const info = await lab.step(
    client.dir,
    'remote-object-info for one blob',
    ['cat-file', '--batch-command=%(objectname) %(objectsize)'],
    {
      input: `remote-object-info origin ${sample?.newOid ?? ''}\n`,
    },
  );
  s.step(info);
  s.check(
    'remote-object-info sizes a blob without acquiring it on a server that allows it',
    info.value.status === 0 && blobsOf(info.record) === 0,
    info.value.stdout.toString('utf8').trim(),
  );
  s.data({
    changedPaths: diff.changes.length,
    statuses,
    treeEntries: listing.entries.length,
  });
  return s.build();
}

export async function admissionScenario(
  lab: Lab,
  ctx: ReviewContext,
): Promise<ScenarioRecord> {
  const s = new ScenarioBuilder(
    'admission-and-acquisition',
    [1, 2],
    'Metadata admission, exact acquisition under GIT_NO_LAZY_FETCH, and content probes',
  );
  const client = await lab.createClient('admission', ctx.server.url);
  const prep = await prepare(lab, client, {
    revisions: {
      head: ctx.commit(marks.head),
      mergeBase: ctx.commit(marks.mergeBase),
      baseTip: ctx.commit(marks.baseTip),
    },
    scope: 'union',
    sizeOf: (oid) => ctx.sizes.get(oid),
  });
  for (const step of prep.steps) s.step({ record: step });
  const reason = (file: string): string | undefined =>
    prep.planned.excluded.find((e) => e.path === file)?.reason;
  s.check(
    'every planned blob is in the store and no unplanned blob arrived',
    prep.acquisition.exact,
    prep.acquisition,
  );
  s.check(
    'a file ignored at every revision is not acquired',
    reason('src/settings.local.ts') === 'ignored',
  );
  s.check(
    'a file hidden by a head-only ignore rule is not acquired',
    reason('src/hidden.ts') === 'ignored',
  );
  s.check(
    'the head-only hidden file is reported as hidden-reviewable',
    prep.hiddenReviewable.includes('src/hidden.ts'),
    prep.hiddenReviewable,
  );
  s.check(
    'an oversized file is excluded from metadata and never acquired',
    reason('src/big.ts') === 'oversized',
  );
  s.check(
    'a prohibited directory is excluded',
    reason('generated/api.ts') === 'prohibited-directory',
  );
  s.check(
    'a non-source extension is excluded',
    reason('docs/guide.md') === 'extension',
  );
  s.check('a symlink is excluded', reason('src/link.ts') === 'symlink');
  s.check('a submodule is excluded', reason('vendor/sub') === 'submodule');
  s.check(
    'the probe rejects a binary file and an LFS pointer after acquisition',
    prep.probeRejected.some(
      (r) => r.path === 'src/blob.ts' && r.contentClass === 'binary',
    ) &&
      prep.probeRejected.some(
        (r) => r.path === 'src/model.ts' && r.contentClass === 'lfs-pointer',
      ),
    prep.probeRejected,
  );
  s.check(
    'rejected names never reach admission',
    prep.rejectedNames.length === 2,
    prep.rejectedNames,
  );
  s.check(
    'the merge-base side of a deleted file is admitted for the patch',
    prep.planned.admitted.some((c) => c.path === 'src/f2.ts'),
  );
  s.data({
    planned: {
      oids: prep.planned.oids.length,
      bytes: prep.planned.plannedBytes,
    },
    eligible: prep.eligible,
    excluded: prep.planned.excluded,
    ignored: Object.fromEntries(prep.ignored.ignoredAt),
    acquiredBlobs: prep.acquiredBlobs.map((o) => ({
      oid: o.oid,
      size: o.size,
    })),
    patchBytes: prep.patchBytes,
  });
  return s.build();
}

export async function negotiationScenario(
  lab: Lab,
  ctx: ReviewContext,
): Promise<ScenarioRecord> {
  const s = new ScenarioBuilder(
    'acquisition-negotiation',
    [1, 2],
    'Fetching blob IDs needs the noop negotiator',
  );
  const head = ctx.commit(marks.head);
  const listing = await lab.lsTree(ctx.server.dir, head);
  const oidOf = (file: string): string => {
    const entry = listing.entries.find((e) => e.path === file);
    if (!entry) throw new Error(`fixture is missing ${file}`);
    return entry.oid;
  };
  const [f1, f3, app, util] = [
    'src/f1.ts',
    'src/f3.ts',
    'src/app.ts',
    'src/util.ts',
  ].map(oidOf) as [string, string, string, string];
  const client = await lab.createClient('negotiation', ctx.server.url);
  s.step(
    await lab.fetchCommits(client, 'fetch head, depth 1, blob:none', [head], {
      depth: 1,
    }),
  );
  // With no local refs the client has nothing to advertise, so the default
  // negotiator happens to work.
  const unreferenced = s.step(
    await lab.acquireBlobs(
      client,
      'blob ID fetch, default negotiation, no local refs',
      [f1],
      'default',
    ),
  );
  s.check(
    'with no local refs, default negotiation delivers the blob',
    unreferenced.value.status === 0 && blobsOf(unreferenced.record) === 1,
    unreferenced.record.status,
  );
  // Stage B stores the PR head under a local ref, and the backfill path sets
  // HEAD. Once a ref names a commit, the default negotiator advertises it,
  // and the server assumes every blob under it is already present.
  await lab.git.ok(client.dir, ['update-ref', 'refs/spike/head', head]);
  const skipping = s.step(
    await lab.acquireBlobs(
      client,
      'blob ID fetch, default negotiation, head under a local ref',
      [f3],
      'default',
    ),
  );
  s.check(
    'with a local ref on head, default negotiation receives nothing and the fetch fails',
    skipping.value.status !== 0 &&
      skipping.record.acquired.objects.length === 0,
    skipping.record.stderr,
  );
  const noop = s.step(
    await lab.acquireBlobs(
      client,
      'blob ID fetch, noop negotiation, head under a local ref',
      [f3, app, util],
    ),
  );
  s.check(
    'with the noop negotiator exactly the requested blobs arrive',
    noop.value.status === 0 &&
      blobsOf(noop.record) === 3 &&
      noop.record.acquired.objects.every((o) =>
        [f3, app, util].includes(o.oid),
      ),
    noop.record.acquired.objects.map((o) => o.oid),
  );
  const bogus = s.step(
    await lab.acquireBlobs(
      client,
      'blob ID fetch for an object the server lacks',
      ['0123456789abcdef0123456789abcdef01234567'],
    ),
  );
  s.check(
    'a missing object fails the fetch without acquiring anything',
    bogus.value.status !== 0 && bogus.record.acquired.objects.length === 0,
    bogus.record.stderr,
  );
  return s.build();
}

async function sparseClient(
  lab: Lab,
  ctx: ReviewContext,
  name: string,
  depth: number,
  paths: readonly string[],
): Promise<{ client: Client; refused: readonly string[] }> {
  const client = await lab.createClient(name, ctx.server.url);
  const head = ctx.commit(marks.head);
  await lab.fetchCommits(client, 'fetch head, blob:none', [head], { depth });
  await lab.git.ok(client.dir, ['update-ref', 'HEAD', head]);
  await lab.git.ok(client.dir, ['config', 'core.sparseCheckout', 'true']);
  await lab.git.ok(client.dir, ['config', 'core.sparseCheckoutCone', 'false']);
  const sparse = sparseFileFor(paths);
  await lab.writeFile(
    path.join(client.dir, 'info', 'sparse-checkout'),
    sparse.content,
  );
  return { client, refused: sparse.refused };
}

export async function backfillScenario(
  lab: Lab,
  ctx: ReviewContext,
): Promise<ScenarioRecord> {
  const s = new ScenarioBuilder(
    'backfill',
    [2, 3],
    'git backfill --sparse: GIT_NO_LAZY_FETCH, --no-include-edges with parents present, escaped patterns',
  );
  const head = ctx.commit(marks.head);
  const parent = ctx.commit(marks.head - 1);
  const scope = ['src/f3.ts', 'src/app.ts'];
  const headListing = await lab.lsTree(ctx.server.dir, head);
  const parentListing = await lab.lsTree(ctx.server.dir, parent);
  const oidAt = (listing: typeof headListing, file: string): string =>
    listing.entries.find((e) => e.path === file)?.oid ?? '';
  const expectedHead = new Set(scope.map((file) => oidAt(headListing, file)));
  const parentOnly = oidAt(parentListing, 'src/f3.ts');
  const range = `${head}^!`;

  const a = await sparseClient(lab, ctx, 'backfill-no-lazy', 2, scope);
  const blocked = s.step(
    await lab.step(
      a.client.dir,
      'backfill --sparse --no-include-edges under GIT_NO_LAZY_FETCH=1',
      [
        'backfill',
        '--sparse',
        '--no-include-edges',
        '--min-batch-size=5000',
        range,
      ],
    ),
  );
  s.check(
    'backfill cannot run with GIT_NO_LAZY_FETCH=1: it is a lazy fetch',
    blocked.value.status !== 0 && blocked.record.acquired.objects.length === 0,
    blocked.record.stderr,
  );

  const scoped = s.step(
    await lab.step(
      a.client.dir,
      'backfill --sparse --no-include-edges, lazy fetch enabled for this process only',
      [
        'backfill',
        '--sparse',
        '--no-include-edges',
        '--min-batch-size=5000',
        range,
      ],
      { lazyFetch: 'enabled-for-this-process' },
    ),
  );
  const scopedOids = new Set(
    scoped.record.acquired.objects
      .filter((o) => o.type === 'blob')
      .map((o) => o.oid),
  );
  s.check(
    'with --no-include-edges and the parent commit present, only head blobs in scope arrive',
    scoped.value.status === 0 &&
      scopedOids.size === expectedHead.size &&
      [...expectedHead].every((oid) => scopedOids.has(oid)),
    [...scopedOids],
  );

  const b = await sparseClient(lab, ctx, 'backfill-edges', 2, scope);
  const edges = s.step(
    await lab.step(
      b.client.dir,
      'backfill --sparse (default edges), lazy fetch enabled for this process only',
      ['backfill', '--sparse', '--min-batch-size=5000', range],
      { lazyFetch: 'enabled-for-this-process' },
    ),
  );
  const edgeOids = new Set(
    edges.record.acquired.objects
      .filter((o) => o.type === 'blob')
      .map((o) => o.oid),
  );
  s.check(
    'without --no-include-edges the parent commit blobs arrive too',
    edgeOids.has(parentOnly),
    { parentBlob: parentOnly, acquired: [...edgeOids] },
  );

  const literal = specialNames.map((entry) => entry.name);
  const c = await sparseClient(lab, ctx, 'backfill-escaped', 1, [
    ...literal,
    newlineName,
  ]);
  s.check(
    'a name with a newline cannot be written as a pattern and is refused',
    c.refused.length === 1 && c.refused[0] === newlineName,
  );
  const escaped = s.step(
    await lab.step(
      c.client.dir,
      'backfill --sparse --no-include-edges with escaped patterns, lazy enabled for this process only',
      [
        'backfill',
        '--sparse',
        '--no-include-edges',
        '--min-batch-size=5000',
        range,
      ],
      { lazyFetch: 'enabled-for-this-process' },
    ),
  );
  const expectedEscaped = new Set(
    literal.map((file) => oidAt(headListing, file)),
  );
  const decoys = new Set(
    specialNames
      .flatMap((entry) => entry.decoys)
      .map((file) => oidAt(headListing, file)),
  );
  const escapedOids = new Set(
    escaped.record.acquired.objects
      .filter((o) => o.type === 'blob')
      .map((o) => o.oid),
  );
  s.check(
    'escaped patterns acquire exactly the literal names and none of their decoys',
    escaped.value.status === 0 &&
      escapedOids.size === expectedEscaped.size &&
      [...expectedEscaped].every((oid) => escapedOids.has(oid)) &&
      [...decoys].every((oid) => !escapedOids.has(oid)),
    { expected: expectedEscaped.size, acquired: escapedOids.size },
  );
  s.data({
    scope,
    expectedHead: [...expectedHead],
    parentOnly,
    sparseFile: sparseFileFor(literal).content,
  });
  return s.build();
}

export async function lazyFetchScenario(
  lab: Lab,
  ctx: ReviewContext,
): Promise<ScenarioRecord> {
  const s = new ScenarioBuilder(
    'lazy-fetch-disabled',
    [2, 3],
    'Reads outside the acquired scope fail instead of fetching',
  );
  const client = await lab.createClient('lazy', ctx.server.url);
  const head = ctx.commit(marks.head);
  const mergeBase = ctx.commit(marks.mergeBase);
  const prep = await prepare(lab, client, {
    revisions: { head, mergeBase, baseTip: ctx.commit(marks.baseTip) },
    scope: 'union',
    sizeOf: (oid) => ctx.sizes.get(oid),
  });
  const outside = (await lab.lsTree(client.dir, head)).entries.find(
    (e) => e.path === 'docs/guide.md',
  );
  if (!outside) throw new Error('fixture is missing docs/guide.md');
  const out = literalPathspec('docs/guide.md');
  const attempts: [string, string[]][] = [
    ['cat-file of an unacquired blob', ['cat-file', 'blob', outside.oid]],
    [
      'patch over an unacquired path',
      [
        'diff',
        '-p',
        '--no-ext-diff',
        '--no-textconv',
        mergeBase,
        head,
        '--',
        out,
      ],
    ],
    [
      'grep over an unacquired path',
      ['grep', '-F', '-n', '-z', '--no-color', '-e', 'Guide', head, '--', out],
    ],
  ];
  for (const [name, args] of attempts) {
    const attempt = s.step(await lab.step(client.dir, name, args));
    s.check(
      `${name} fails and acquires nothing`,
      attempt.value.status !== 0 &&
        attempt.record.acquired.objects.length === 0,
      attempt.record.stderr,
    );
  }
  const inside = s.step(
    await lab.step(client.dir, 'grep over eligible paths', [
      'grep',
      '-F',
      '-n',
      '-z',
      '--no-color',
      '-e',
      'export',
      head,
      '--',
      ...prep.eligible.map(literalPathspec),
    ]),
  );
  s.check(
    'grep over eligible paths succeeds without acquiring',
    inside.value.status === 0 && inside.record.acquired.objects.length === 0,
    inside.record.status,
  );
  return s.build();
}

function ancestryProbe(
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
      const result = await lab.git.run(client.dir, [
        'merge-base',
        '--is-ancestor',
        prior,
        head,
      ]);
      return result.status === 0;
    },
    historyComplete() {
      return lab.historyComplete(client.dir, [head, prior]);
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

export async function ancestryScenario(
  lab: Lab,
  ctx: ReviewContext,
): Promise<ScenarioRecord> {
  const s = new ScenarioBuilder(
    'ancestry',
    [3],
    'Shallow ancestor, rewritten and unknown histories without blobs',
  );
  const cases = [
    {
      name: 'shallow ancestor',
      head: ctx.commit(marks.head),
      prior: ctx.commit(marks.priorHead),
      maxSteps: 8,
      commitsPerStep: 2,
      expected: 'ancestor',
    },
    {
      name: 'rewritten',
      head: ctx.commit(marks.rewrittenHead),
      prior: ctx.commit(marks.head),
      maxSteps: 8,
      commitsPerStep: 4,
      expected: 'rewritten',
    },
    {
      name: 'unknown: prior head cannot be fetched',
      head: ctx.commit(marks.head),
      prior: 'fedcba9876543210fedcba9876543210fedcba98',
      maxSteps: 8,
      commitsPerStep: 2,
      expected: 'unknown',
    },
    {
      name: 'unknown: deepen bound reached',
      head: ctx.commit(marks.head),
      prior: ctx.commit(marks.priorHead),
      maxSteps: 1,
      commitsPerStep: 1,
      expected: 'unknown',
    },
  ] as const;
  const results: Record<string, unknown> = {};
  for (const item of cases) {
    const client = await lab.createClient(
      `ancestry-${item.expected}`,
      ctx.server.url,
    );
    const steps: StepRecord[] = [];
    // As in production, the store also holds the depth-1 base tip, whose
    // shallow boundary must not stop the completeness check.
    const fetched = await lab.fetchCommits(
      client,
      'fetch head and base tip, depth 1, blob:none',
      [item.head, ctx.commit(marks.baseTip)],
      { depth: 1 },
    );
    steps.push(fetched.record);
    const result = await classifyAncestry(
      ancestryProbe(lab, client, item.head, item.prior, steps),
      item,
    );
    for (const step of steps) s.step({ record: step });
    const blobs = steps.reduce((sum, step) => sum + blobsOf(step), 0);
    s.check(
      `${item.name}: classified ${item.expected}`,
      result.ancestry === item.expected,
      result,
    );
    s.check(
      `${item.name}: no blob acquired while classifying`,
      blobs === 0,
      blobs,
    );
    if (item.expected === 'rewritten') {
      const storeShallow = await lab.git.ok(client.dir, [
        'rev-parse',
        '--is-shallow-repository',
      ]);
      s.check(
        'rewritten is proved while the base tip keeps the store shallow',
        storeShallow.stdout.toString('utf8').trim() === 'true' &&
          result.ancestry === 'rewritten',
        storeShallow.stdout.toString('utf8').trim(),
      );
    }
    results[item.name] = result;
  }
  s.data(results);
  return s.build();
}
