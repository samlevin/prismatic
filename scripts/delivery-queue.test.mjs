import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadPolicy } from './agent-policy.mjs';
import {
  claimRecord,
  deliveryQueue,
  effortRecord,
  ledgerLine,
  nextLeaf,
  restClient,
  stackReady,
} from './delivery-queue.mjs';

const policy = loadPolicy();
const repo = `repos/${policy.binding.repository}`;
const project = `users/${policy.binding.project.owner}/projectsV2/${policy.binding.project.number}`;
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const comment = (body) => ({
  body,
  author_association: 'OWNER',
  user: { login: 'owner' },
  html_url: 'claim-url',
});
const claimed = (agent = 'delivery', worktree = '.codex/worktrees/one') =>
  comment(
    `<!-- prism-claim ${JSON.stringify({ agent, branch: 'agent/1-one', worktree })} -->`,
  );
const pull = (number, state = 'open') => ({
  number: number + 100,
  body: `Closes #${number}\nPre-PR review: APPROVE; base=${base}; head=${head}`,
  state,
  base: { sha: base, ref: 'main' },
  head: { sha: head, ref: `agent/${number}-prerequisite` },
  html_url: `pr-${number}`,
  merged_at: state === 'closed' ? 'today' : null,
});

function fixture({
  tree = { 10: [3, 1, 2] },
  deps = {},
  closed = [],
  comments = {},
  pulls = [],
  denied = [],
  branches = [],
  checks = [{ status: 'completed', conclusion: 'success' }],
  statuses = [],
  bodies = {},
  sizes = {},
  labels = {},
  mergeBase = base,
} = {}) {
  const calls = [];
  const api = {
    get(path) {
      calls.push(path);
      if (path === `${repo}/commits/main`) return { sha: 'c'.repeat(40) };
      const match = /\/issues\/(\d+)$/.exec(path);
      if (match) {
        const n = Number(match[1]);
        if (denied.includes(n)) throw new Error('HTTP 404');
        return {
          number: n,
          title: `Issue ${n}`,
          body: bodies[n] ?? '',
          state: closed.includes(n) ? 'closed' : 'open',
          labels: (labels[n] ?? ['severity: critical']).map((name) => ({
            name,
          })),
        };
      }
      if (path.includes('/compare/'))
        return { merge_base_commit: { sha: mergeBase } };
      if (path.endsWith('/status')) return { statuses };
      throw new Error(`unexpected GET ${path}`);
    },
    list(path, key) {
      calls.push(path);
      const match =
        /\/issues\/(\d+)\/(sub_issues|comments|dependencies\/blocked_by)$/.exec(
          path,
        );
      if (match) {
        const n = Number(match[1]);
        if (match[2] === 'sub_issues')
          return (tree[n] ?? []).map((number) =>
            typeof number === 'number' ? { number } : number,
          );
        if (match[2] === 'comments') return comments[n] ?? [];
        return (deps[n] ?? []).map((number) =>
          typeof number === 'number' ? { number } : number,
        );
      }
      if (path === `${project}/fields`)
        return [
          {
            id: 1,
            name: 'Status',
            options: [{ id: 'r', name: { raw: 'Ready' } }],
          },
          {
            id: 2,
            name: 'Size',
            options: [
              { id: 'l', name: { raw: 'L' } },
              { id: 'm', name: { raw: 'M' } },
            ],
          },
        ];
      if (path === `${project}/items?fields=1,2`)
        return [...new Set([1, ...Object.keys(sizes).map(Number)])].map(
          (n) => ({
            content: {
              number: n,
              repository_url: `https://api.github.com/${repo}`,
            },
            fields: [
              { id: 1, value: { id: 'r', name: { raw: 'Ready' } } },
              { id: 2, value: sizes[n] === 'M' ? 'm' : 'l' },
            ],
          }),
        );
      if (path === `${repo}/pulls?state=all`) return pulls;
      if (path === `${repo}/branches`) return branches;
      if (path.endsWith('/check-runs')) {
        assert.equal(key, 'check_runs');
        return checks;
      }
      throw new Error(`unexpected list ${path}`);
    },
  };
  return { api, calls };
}
const queue = (options = {}, args = {}) => {
  const f = fixture(options);
  return {
    ...deliveryQueue(policy, 10, { api: f.api, ...args }),
    calls: f.calls,
  };
};

test('recursive native leaves use dependency order and numeric ties, including external blockers', () => {
  const { rows, errors, calls } = queue({
    tree: { 10: [20, 3], 20: [2, 1] },
    deps: { 1: [3], 2: [99] },
    closed: [99],
  });
  assert.deepEqual(
    rows.map((row) => row.issue),
    [2, 3, 1],
  );
  assert.deepEqual(errors, []);
  assert.ok(calls.includes(`${repo}/issues/99`));
  assert.deepEqual(
    rows.map((row) => row.state),
    ['ready', 'ready', 'waiting'],
  );
  assert.equal(rows.find((row) => row.issue === 1).size, 'L');
  assert.equal(rows.find((row) => row.issue === 1).projectState, 'Ready');
  assert.ok(rows.every((row) => row.effort.effort === 'medium'));
  assert.deepEqual(
    queue({ deps: { 1: [99], 99: [3] } }).rows.map((row) => row.issue),
    [2, 3, 1],
  );
});

test('cycles block their leaves and do not prevent unrelated ready leaves', () => {
  const { rows } = queue({ deps: { 1: [2], 2: [1] } });
  assert.deepEqual(
    rows.filter((row) => row.state === 'ready').map((row) => row.issue),
    [3],
  );
  assert.ok(
    rows
      .filter((row) => row.issue !== 3)
      .every((row) => /cycle/.test(row.blocker)),
  );
});

test('every queue state is assigned from current PR, claim, and dependency data', () => {
  const { rows } = queue(
    {
      tree: { 10: [1, 2, 3, 4, 5, 6, 7] },
      closed: [1],
      pulls: [pull(2), pull(7, 'closed')],
      comments: { 3: [claimed('other')], 4: [claimed()] },
      deps: { 5: [99] },
    },
    { resume: 4 },
  );
  assert.deepEqual(
    Object.fromEntries(rows.map((row) => [row.issue, row.state])),
    {
      1: 'done',
      2: 'in review',
      3: 'owned elsewhere',
      4: 'resume',
      5: 'waiting',
      6: 'ready',
      7: 'done',
    },
  );
  assert.equal(rows.find((row) => row.issue === 3).claim.url, 'claim-url');
});

test('single leaves work, missing children are recorded as BLOCKED, native cycles terminate', () => {
  const leaf = fixture({ tree: {} });
  assert.equal(deliveryQueue(policy, 1, { api: leaf.api }).rows[0].issue, 1);
  const inaccessible = queue({ denied: [2] });
  assert.match(inaccessible.errors[0], /#2 inaccessible/);
  assert.match(
    inaccessible.rows.find((row) => row.issue === 2).blocker,
    /BLOCKED/,
  );
  const cyclic = queue({ tree: { 10: [20], 20: [10] } });
  assert.match(cyclic.errors[0], /native sub-issue cycle/);
});

test('resume requires the explicit request or this delivery identity and a registered worktree', () => {
  const options = { comments: { 1: [claimed()] } };
  assert.equal(queue(options).rows[0].state, 'owned elsewhere');
  assert.equal(
    queue(options, {
      actor: 'delivery',
      worktrees: ['/repo/.codex/worktrees/one'],
    }).rows[0].state,
    'resume',
  );
  assert.equal(
    queue(options, {
      actor: 'other',
      worktrees: ['/repo/.codex/worktrees/one'],
    }).rows[0].state,
    'owned elsewhere',
  );
  assert.equal(
    queue(options, { actor: 'delivery', worktrees: [] }).rows[0].state,
    'owned elsewhere',
  );
  assert.equal(queue(options, { resume: 1 }).rows[0].state, 'resume');
});

test('--next resumes first and reports an earlier foreign claim instead of skipping it', () => {
  const rows = queue(
    { comments: { 1: [claimed('other')], 3: [claimed()] } },
    { resume: 3 },
  ).rows;
  assert.equal(nextLeaf(rows).issue, 3);
  assert.equal(
    nextLeaf(rows.filter((row) => row.issue !== 3)).state,
    'owned elsewhere',
  );
  assert.equal(nextLeaf([{ state: 'waiting' }]), undefined);
});

test('stack readiness requires an open ready PR, passing checks, and exact approval pair', () => {
  const pr = pull(1);
  const good = [{ status: 'completed', conclusion: 'success' }];
  assert.equal(stackReady(pr, good, [], base), true);
  for (const bad of [
    { ...pr, draft: true },
    { ...pr, state: 'closed' },
    { ...pr, body: 'Closes #1' },
    { ...pr, head: { sha: 'c'.repeat(40) } },
  ])
    assert.equal(stackReady(bad, good, [], base), false);
  assert.equal(stackReady(pr, [], [], base), false);
  assert.equal(stackReady(pr, [{ status: 'in_progress' }], [], base), false);
  assert.equal(stackReady(pr, good, [{ state: 'failure' }], base), false);
  assert.equal(
    queue({ deps: { 1: [99] }, pulls: [pull(99)] }).rows.find(
      (row) => row.issue === 1,
    ).state,
    'ready',
  );
  assert.equal(
    queue({ deps: { 1: [99] }, pulls: [pull(99)], checks: [] }).rows.find(
      (row) => row.issue === 1,
    ).state,
    'waiting',
  );
});

test('released, untrusted, and legacy claims follow ownership rules', () => {
  assert.equal(
    claimRecord([
      claimed(),
      comment('<!-- prism-claim {"agent":"delivery","released":true} -->'),
    ]),
    null,
  );
  assert.equal(
    claimRecord([{ ...claimed(), author_association: 'NONE' }]),
    null,
  );
  const legacy = comment(
    'Agent `delivery` claims #1 on branch `agent/1-one` in `.codex/worktrees/one`.',
  );
  assert.equal(claimRecord([legacy]).branch, 'agent/1-one');
  assert.equal(claimRecord([legacy, comment('Released the claim.')]), null);
});

test('the ledger reuses only qualifying effort decisions and never escalates from metadata', () => {
  const decision = {
    effort: 'high',
    rule: 'H1-boundary',
    evidence: 'spec §3: replay race',
    reason: 'The plan leaves the write barrier unresolved.',
    question: 'Which write orders preserve immutable evidence?',
    criteria: Object.fromEntries(
      policy.implementationEffort.rules['H1-boundary'].requires.map((key) => [
        key,
        true,
      ]),
    ),
  };
  const record = comment(`<!-- prism-effort ${JSON.stringify(decision)} -->`);
  assert.equal(effortRecord([record], policy).effort, 'high');
  assert.equal(
    effortRecord([comment('Size L; infrastructure; severity critical')], policy)
      .effort,
    'medium',
  );
  assert.equal(
    effortRecord(
      [
        comment(
          `<!-- prism-effort ${JSON.stringify({ ...decision, criteria: {} })} -->`,
        ),
      ],
      policy,
    ).effort,
    'medium',
  );
  const { rows } = queue({ comments: { 1: [record] } });
  assert.match(
    ledgerLine(rows[0]),
    /effort=high; rule=H1-boundary; evidence=spec/,
  );
});

test('REST client follows Link pagination through gh, uses only GET, and propagates errors', () => {
  const ok = (body, headers = '') =>
    `HTTP/2.0 200 OK\r\n${headers}\r\n${JSON.stringify(body)}`;
  const calls = [];
  const api = restClient((command, args) => {
    calls.push(args);
    assert.equal(command, 'gh');
    // No method, field, or input flag, so gh sends a GET.
    assert.deepEqual(args.slice(0, 2), ['api', '--include']);
    assert.equal(args.length, 3);
    return args[2].endsWith('per_page=100')
      ? ok(
          Array(100).fill({}),
          'Link: <https://api.github.com/repos/x/y/branches?per_page=100&page=2>; rel="next"\r\n',
        )
      : ok([{ last: true }]);
  });
  assert.equal(api.list('repos/x/y/branches').length, 101);
  assert.deepEqual(
    calls.map((args) => args[2]),
    [
      'repos/x/y/branches?per_page=100',
      'repos/x/y/branches?per_page=100&page=2',
    ],
  );
  assert.deepEqual(api.get('repos/x/y'), [{ last: true }]);
  assert.throws(
    () =>
      restClient(() => {
        throw Object.assign(new Error('Command failed: gh api'), {
          status: 1,
          stdout: `HTTP/2.0 403 Forbidden\r\n\r\n${JSON.stringify({ message: 'denied' })}`,
        });
      }).get('x'),
    /^Error: GET x: GitHub REST request failed: HTTP 403: denied\./,
  );
  assert.throws(() => restClient(() => ok({})).list('x'), /expected a list/);
  assert.deepEqual(
    restClient(() => ok({ check_runs: [1, 2] })).list('x', 'check_runs'),
    [1, 2],
  );
});

test('each run refetches its state and reads no source, diff, or persistent cache', () => {
  const f = fixture();
  deliveryQueue(policy, 10, { api: f.api });
  deliveryQueue(policy, 10, { api: f.api });
  assert.equal(
    f.calls.filter((path) => path === `${project}/fields`).length,
    2,
  );
  assert.equal(f.calls.filter((path) => path === `${repo}/issues/1`).length, 2);
  assert.ok(f.calls.every((path) => !/diff|contents|graphql/.test(path)));
});

test('CLI validates its target and documents --next and resume', () => {
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [new URL('./delivery-queue.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8' },
    );
  assert.equal(run('--help').status, 0);
  assert.match(run('--help').stdout, /--next/);
  assert.match(run('not-an-issue').stderr, /positive issue number/);
});

test('an explicit medium constraint persists across later recorded high assessments', () => {
  const medium = comment(
    '<!-- prism-effort {"effort":"medium","rule":"user override","evidence":"request","reason":"explicit medium"} -->',
  );
  const decision = {
    effort: 'high',
    rule: 'H3-demonstrated-limit',
    later: true,
    question: 'write ordering',
    evidence: 'case 1',
    reason: 'design revision',
    criteria: Object.fromEntries(
      policy.implementationEffort.rules['H3-demonstrated-limit'].requires.map(
        (key) => [key, true],
      ),
    ),
  };
  const high = comment(`<!-- prism-effort ${JSON.stringify(decision)} -->`);
  assert.equal(effortRecord([medium, high], policy).effort, 'medium');
  assert.equal(
    claimRecord([comment('Agent `other` claimed #1 on `agent/1-one`.')]).agent,
    'other',
  );
});

test('external children and dependencies block before a Prismatic number collision is fetched', () => {
  for (const options of [
    {
      tree: {
        10: [
          {
            number: 123,
            repository_url: 'https://api.github.com/repos/elsewhere/project',
          },
        ],
      },
    },
    {
      tree: { 10: [1] },
      deps: {
        1: [{ number: 123, repository: { full_name: 'elsewhere/project' } }],
      },
    },
  ]) {
    const { rows, errors, calls } = queue(options);
    assert.match(
      errors.join(' '),
      /unsupported repository relationship: elsewhere\/project#123/,
    );
    assert.ok(rows.every((row) => row.state === 'waiting'));
    assert.ok(!calls.includes(`${repo}/issues/123`));
  }
});

test('legacy approvals allow a moved base branch and reject a changed head', () => {
  const pr = pull(1);
  pr.body = `Closes #1\nPre-PR review: APPROVE for \`${base}..${head}\`.`;
  const checks = [{ status: 'completed', conclusion: 'success' }];
  assert.equal(stackReady(pr, checks, [], base), true);
  assert.equal(
    stackReady({ ...pr, base: { sha: 'c'.repeat(40) } }, checks, [], base),
    true,
  );
  assert.equal(
    stackReady({ ...pr, head: { sha: 'd'.repeat(40) } }, checks, [], base),
    false,
  );
});

test('ledger output alone supplies exact stacked prerequisite and implementation base', () => {
  const { rows } = queue({ deps: { 1: [99] }, pulls: [pull(99)] });
  const row = rows.find((row) => row.issue === 1);
  const dispatch = JSON.parse(ledgerLine(row).split(' | dispatch=')[1]);
  assert.deepEqual(dispatch.base, {
    branch: 'agent/99-prerequisite',
    sha: head,
  });
  assert.deepEqual(dispatch.dependencies, [99]);
  assert.deepEqual(dispatch.prerequisites[0], {
    issue: 99,
    repository: policy.binding.repository,
    met: false,
    pr: 'pr-99',
    branch: 'agent/99-prerequisite',
    head,
    base,
    stackReady: true,
  });
  assert.equal(row.state, 'ready');
});

const groups =
  '<!-- prism-independence-groups -->\n- g1: #1\n- g2: #2\n<!-- /prism-independence-groups -->';
const notes = (file, contracts = 'none') =>
  `### Implementation notes\n\nFiles: \`${file}\`\nContracts: ${contracts}\n`;

test('ledger output validates parallel groups and supplies other-leaf ownership without source reads', () => {
  const { rows } = queue({
    tree: { 10: [1, 2] },
    sizes: { 1: 'M', 2: 'M' },
    bodies: {
      10: groups,
      1: notes('scripts/a.mjs'),
      2: notes('scripts/b.mjs', 'contract-b'),
    },
  });
  const packet = JSON.parse(ledgerLine(rows[0]).split(' | dispatch=')[1]);
  assert.equal(packet.group, '10/g1');
  assert.deepEqual(packet.parallelWith, [
    {
      issue: 2,
      group: '10/g2',
      files: ['scripts/b.mjs'],
      contracts: ['contract-b'],
    },
  ]);
  assert.equal(rows[1].parallelWith[0].issue, 1);
});

test('parallel dispatch is blocked for invalid groups, dependency chains, shared open blockers, missing notes, and overlapping ownership', () => {
  const baseline = {
    tree: { 10: [1, 2] },
    sizes: { 1: 'M', 2: 'M' },
    bodies: {
      10: groups,
      1: notes('scripts/a.mjs'),
      2: notes('scripts/b.mjs'),
    },
  };
  for (const change of [
    { bodies: { ...baseline.bodies, 10: groups.replace('#2', '#99') } },
    { bodies: { ...baseline.bodies, 10: groups.replace('#2', '#1') } },
    { deps: { 1: [99], 99: [2] } },
    { deps: { 1: [99], 2: [99] }, pulls: [pull(99)] },
    { bodies: { ...baseline.bodies, 2: '' } },
    { bodies: { ...baseline.bodies, 2: notes('scripts/a.mjs') } },
    { bodies: { ...baseline.bodies, 1: notes('scripts/*.mjs') } },
    {
      bodies: {
        ...baseline.bodies,
        1: notes('scripts/a.mjs', 'same-contract'),
        2: notes('scripts/b.mjs', 'same-contract'),
      },
    },
    { sizes: { 1: 'L', 2: 'M' } },
  ])
    assert.ok(
      queue({ ...baseline, ...change }).rows.every(
        (row) => row.parallelWith.length === 0,
      ),
    );
});

test('advanced live PR base keeps approval when REST verifies the recorded base is an ancestor', () => {
  const pr = { ...pull(99), base: { ref: 'main', sha: 'd'.repeat(40) } };
  const { rows, calls } = queue({ deps: { 1: [99] }, pulls: [pr] });
  const row = rows.find((row) => row.issue === 1);
  assert.equal(row.state, 'ready');
  assert.equal(row.prerequisites[0].base, base);
  assert.ok(calls.includes(`${repo}/compare/${base}...${head}`));
  assert.equal(
    queue({
      deps: { 1: [99] },
      pulls: [pr],
      mergeBase: 'e'.repeat(40),
    }).rows.find((row) => row.issue === 1).state,
    'waiting',
  );
  assert.equal(
    stackReady(pr, [{ status: 'completed', conclusion: 'success' }], []),
    false,
    'unverified ancestry cannot qualify',
  );
});

test('every member of an overlapping dependency cycle is marked, including self cycles', () => {
  const { rows } = queue({
    tree: { 10: [1, 2, 3, 4, 5] },
    deps: { 1: [2, 3], 2: [1], 3: [2], 4: [4] },
  });
  for (const n of [1, 2, 3, 4])
    assert.match(rows.find((row) => row.issue === n).blocker, /BLOCKED: cycle/);
  assert.equal(rows.find((row) => row.issue === 5).state, 'ready');
});

const laterHigh = () => ({
  effort: 'high',
  rule: 'H3-demonstrated-limit',
  later: true,
  question: 'Which ordering preserves evidence?',
  evidence: 'case race-1 and medium attempt',
  reason: 'The ordering design must change.',
  criteria: Object.fromEntries(
    policy.implementationEffort.rules['H3-demonstrated-limit'].requires.map(
      (key) => [key, true],
    ),
  ),
});
const effortComment = (record) =>
  comment(`<!-- prism-effort ${JSON.stringify(record)} -->`);

test('approved later effort persists through fresh ledgers and recovery dispatch metadata', () => {
  const comments = {
    1: [
      effortComment({ effort: 'medium', rule: 'default' }),
      effortComment(laterHigh()),
    ],
  };
  for (let run = 0; run < 2; run++) {
    const { rows } = queue({ comments });
    assert.equal(rows[0].effort.effort, 'high');
    assert.equal(rows[0].effort.later, true);
    assert.match(
      ledgerLine(rows[0]),
      /effort=high; rule=H3-demonstrated-limit/,
    );
  }
});

test('malformed per-leaf records and duplicate escalations block only their own row', () => {
  for (const bad of [
    [comment('<!-- prism-claim {bad} -->')],
    [comment('<!-- prism-effort {bad -->')],
    [effortComment({ rule: 'user override', effort: 'high' })],
    [effortComment(laterHigh()), effortComment(laterHigh())],
  ]) {
    const { rows, errors } = queue({ comments: { 1: bad } });
    assert.equal(rows.length, 3);
    assert.match(rows[0].blocker, /BLOCKED: issue #1 invalid data:/);
    assert.equal(rows[1].state, 'ready');
    assert.equal(rows[2].state, 'ready');
    assert.equal(errors.length, 1);
    assert.equal(nextLeaf(rows).issue, 2);
  }
});

test('real issue labels, project Size, and written implementation notes never independently choose high', () => {
  for (const scenario of [
    {
      labels: ['area: infrastructure', 'severity: critical'],
      note: 'Apply the specified account-check pattern.',
    },
    {
      labels: ['package: contracts', 'bug', 'severity: high'],
      note: 'Perform the specified mechanical update across ten consumers.',
    },
    {
      labels: ['bug', 'severity: critical'],
      note: 'Two review rounds found only formatting and routine test fixes; retain the written design.',
    },
  ]) {
    const { rows } = queue({
      labels: { 1: scenario.labels },
      sizes: { 1: 'L' },
      bodies: {
        1: `### Implementation notes\n\n${scenario.note}\nFiles: \`infrastructure/main.tf\`\nProvides: specified pattern\n`,
      },
    });
    assert.equal(rows[0].size, 'L');
    assert.equal(rows[0].effort.effort, 'medium');
    assert.equal(rows[0].effort.rule, 'default');
  }
});
