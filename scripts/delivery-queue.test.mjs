import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPolicy } from './agent-policy.mjs';
import {
  approvalPair,
  claimRecord,
  deliveryQueue,
  effortAnnouncement,
  effortRecord,
  implementationEffort,
  ledgerLine,
  nextLeaf,
  orderLeaves,
  parseArguments,
  restClient,
  run,
  stackReady,
} from './delivery-queue.mjs';

const policy = loadPolicy();
const REPO = 'repos/samlevin/prismatic';
const URL = 'https://api.github.com/repos/samlevin/prismatic';
const TRUNK = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

const comment = (body, extra = {}) => ({
  body,
  author_association: 'OWNER',
  user: { login: 'samlevin' },
  html_url: `https://github.com/samlevin/prismatic/issues/1#c${body.length}`,
  ...extra,
});
const effort = (value) =>
  comment(`<!-- prism-effort ${JSON.stringify(value)} -->`);
const claim = (value) =>
  comment(`<!-- prism-claim ${JSON.stringify(value)} -->`);

const H1 = {
  effort: 'high',
  rule: 'H1-boundary',
  question: 'How does the token stay scoped across both adapters?',
  evidence: 'Spec section 4 leaves the scoping mechanism open',
  reason: 'The written plan does not say how the guarantee holds.',
  criteria: {
    newGuarantee: true,
    acrossComponents: true,
    mechanismUnresolved: true,
    failureScenario: true,
  },
};
const H2 = {
  effort: 'high',
  rule: 'H2-coupled-design',
  question: 'How do retry and ordering constraints interact?',
  evidence: 'Ordering and at-most-once delivery conflict in the spec',
  reason: 'No existing pattern resolves both constraints.',
  criteria: {
    interactingConstraints: true,
    designUnresolved: true,
    patternsInsufficient: true,
    decompositionInsufficient: true,
  },
};
const H3 = {
  effort: 'high',
  rule: 'H3-demonstrated-limit',
  later: true,
  question: 'How can concurrent writes keep the specified order?',
  evidence: 'Reproducible case race-1 after the medium attempt',
  reason: 'The attempt requires revising the ordering design.',
  criteria: {
    mediumAttempt: true,
    reproducibleFailureOrFinding: true,
    designRevisionRequired: true,
    unresolvedReasoning: true,
  },
};

// A REST client over fixture issues. Each issue may list children, blockers,
// comments, labels, and `error` to make it inaccessible.
function fakeApi({ issues, prs = [], branches = [], items = [], checks = {} }) {
  const related = (n, repository = 'samlevin/prismatic') => ({
    number: n,
    repository_url: `https://api.github.com/repos/${repository}`,
  });
  const issue = (n) => {
    const fixture = issues[n];
    if (!fixture || fixture.error) throw new Error(`Not Found (${n})`);
    return fixture;
  };
  const get = (path) => {
    let match = /^repos\/samlevin\/prismatic\/issues\/(\d+)$/.exec(path);
    if (match) {
      const {
        state = 'open',
        title = `Issue ${match[1]}`,
        body = '',
        labels = [],
      } = issue(Number(match[1]));
      return {
        number: Number(match[1]),
        state,
        title,
        body,
        labels: labels.map((name) => ({ name })),
        repository_url: URL,
      };
    }
    if (path === `${REPO}/commits/main`) return { sha: TRUNK };
    match = /commits\/(\w+)\/status$/.exec(path);
    if (match) return { statuses: checks[match[1]]?.statuses ?? [] };
    throw new Error(`unexpected GET ${path}`);
  };
  const list = (path) => {
    const match =
      /^repos\/samlevin\/prismatic\/issues\/(\d+)\/(sub_issues|dependencies\/blocked_by|comments)$/.exec(
        path,
      );
    if (match) {
      const fixture = issue(Number(match[1]));
      if (match[2] === 'sub_issues')
        return (fixture.children ?? []).map((n) =>
          typeof n === 'number' ? related(n) : related(n.number, n.repository),
        );
      if (match[2] === 'comments') return fixture.comments ?? [];
      return (fixture.blockedBy ?? []).map((n) =>
        typeof n === 'number' ? related(n) : related(n.number, n.repository),
      );
    }
    if (path === 'users/samlevin/projectsV2/2/fields')
      return [
        { id: 1, name: 'Status' },
        { id: 2, name: 'Size' },
        { id: 3, name: 'Priority' },
      ];
    if (path === 'users/samlevin/projectsV2/2/items?fields=1,2') return items;
    if (path === `${REPO}/pulls?state=all`) return prs;
    if (path === `${REPO}/branches`) return branches;
    const runs = /commits\/(\w+)\/check-runs$/.exec(path);
    if (runs) return checks[runs[1]]?.runs ?? [];
    throw new Error(`unexpected list ${path}`);
  };
  return { get, list };
}

const pr = (number, closes, extra = {}) => ({
  number,
  html_url: `https://github.com/samlevin/prismatic/pull/${number}`,
  state: 'open',
  draft: false,
  merged_at: null,
  body: `Closes #${closes}`,
  author_association: 'OWNER',
  head: {
    ref: `agent/${closes}-thing`,
    sha: HEAD,
    repo: { full_name: 'samlevin/prismatic' },
  },
  ...extra,
});

const states = (rows) =>
  Object.fromEntries(rows.map((row) => [row.issue, row.state]));

test('orders blockers first and breaks ties by issue number', () => {
  const { order, cycles } = orderLeaves(
    [14, 12, 13, 11],
    new Map([
      [12, [14]],
      [11, [13]],
    ]),
  );
  assert.deepEqual(order, [13, 11, 14, 12]);
  assert.equal(cycles.size, 0);
});

test('every member of a dependency cycle is blocked and other leaves still run', () => {
  const api = fakeApi({
    issues: {
      1: { children: [2, 3, 4, 5] },
      2: { blockedBy: [3] },
      3: { blockedBy: [4] },
      4: { blockedBy: [2] },
      5: {},
    },
  });
  const { rows, errors } = deliveryQueue(policy, 1, { api });
  for (const n of [2, 3, 4]) {
    const row = rows.find((entry) => entry.issue === n);
    assert.equal(row.state, 'waiting');
    assert.equal(row.blocker, 'BLOCKED: dependency cycle among #2, #3, #4');
  }
  assert.equal(states(rows)[5], 'ready');
  // A cycle makes the script exit non-zero.
  assert.equal(errors.length, 3);
  const self = deliveryQueue(policy, 1, {
    api: fakeApi({ issues: { 1: { children: [2] }, 2: { blockedBy: [2] } } }),
  });
  assert.match(self.rows[0].blocker, /cycle among #2$/);
});

test('assigns every queue state', () => {
  const api = fakeApi({
    issues: {
      1: { children: [2, 3, 4, 5, 6, 7, 8, 9, 10] },
      2: { state: 'closed' },
      3: {},
      4: {},
      5: {
        comments: [
          claim({
            agent: 'codex-99-x',
            branch: 'agent/5-x',
            worktree: '.codex/worktrees/agent-5-x',
          }),
        ],
      },
      6: {
        comments: [
          claim({
            agent: 'claude-1-t',
            branch: 'agent/6-y',
            worktree: '.claude/worktrees/agent-6-y',
          }),
        ],
      },
      // This delivery's claim; --resume waives the missing worktree.
      7: {
        comments: [
          claim({
            agent: 'claude-1-t',
            branch: 'agent/7-z',
            worktree: '.claude/worktrees/agent-7-z',
          }),
        ],
      },
      8: { blockedBy: [20] },
      9: {},
      10: { blockedBy: [2] },
      20: {},
    },
    prs: [
      pr(30, 3, { state: 'closed', merged_at: '2026-01-01T00:00:00Z' }),
      pr(31, 4),
    ],
  });
  const { rows, errors } = deliveryQueue(policy, 1, {
    api,
    resume: 7,
    actor: 'claude-1-t',
    worktrees: ['/repo/.claude/worktrees/agent-6-y'],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(states(rows), {
    2: 'done',
    3: 'done',
    4: 'in review',
    5: 'owned elsewhere',
    6: 'resume',
    7: 'resume',
    8: 'waiting',
    9: 'ready',
    10: 'ready',
  });
  assert.equal(rows.find((row) => row.issue === 4).pr, pr(31, 4).html_url);
  assert.equal(
    rows.find((row) => row.issue === 8).blocker,
    'unmet blockers: #20',
  );
});

test('a claim whose worktree is missing here is owned elsewhere, even for this actor', () => {
  const api = fakeApi({
    issues: {
      6: {
        comments: [
          claim({
            agent: 'claude-1-t',
            branch: 'agent/6-y',
            worktree: '.claude/worktrees/agent-6-y',
          }),
        ],
      },
    },
  });
  const { rows } = deliveryQueue(policy, 6, {
    api,
    actor: 'claude-1-t',
    worktrees: [],
  });
  assert.equal(rows[0].state, 'owned elsewhere');
});

test('--resume never takes over a claim another delivery or person made', () => {
  for (const comments of [
    [claim({ agent: 'someone', branch: 'agent/7-z' })],
    [comment('Claiming this. Branch `agent/7-z`.')],
  ]) {
    const { rows } = deliveryQueue(policy, 7, {
      api: fakeApi({ issues: { 7: { comments } } }),
      resume: 7,
      actor: 'claude-1-t',
      worktrees: [],
    });
    assert.equal(rows[0].state, 'owned elsewhere');
  }
});

test('only trusted PRs from this repository count for review state and stacking', () => {
  const approved = `Closes #20\n\nPre-PR review: APPROVE; base=${BASE}; head=${HEAD}`;
  const passing = {
    [HEAD]: { runs: [{ status: 'completed', conclusion: 'success' }] },
  };
  const fork = {
    ref: 'agent/20-thing',
    sha: HEAD,
    repo: { full_name: 'outsider/prismatic' },
  };
  for (const extra of [
    { head: fork },
    { author_association: 'NONE' },
    { author_association: 'CONTRIBUTOR' },
  ]) {
    const { rows } = deliveryQueue(policy, 1, {
      api: fakeApi({
        issues: {
          1: { children: [4, 8] },
          4: {},
          8: { blockedBy: [20] },
          20: {},
        },
        prs: [pr(50, 4, extra), pr(51, 20, { body: approved, ...extra })],
        checks: passing,
      }),
    });
    assert.equal(states(rows)[4], 'ready', JSON.stringify(extra));
    assert.equal(states(rows)[8], 'waiting', JSON.stringify(extra));
    assert.equal(rows.find((row) => row.issue === 8).base.branch, 'main');
  }
});

test('a cross-repository link affects only the leaf or child it names', () => {
  const { rows, errors } = deliveryQueue(policy, 1, {
    api: fakeApi({
      issues: {
        1: { children: [6, 3] },
        6: { children: [7, { number: 8, repository: 'other/repo' }] },
        7: {},
        3: { blockedBy: [10] },
        10: {
          state: 'closed',
          blockedBy: [{ number: 9, repository: 'other/repo' }],
        },
      },
    }),
  });
  assert.deepEqual(states(rows), { 3: 'ready', 7: 'ready' });
  assert.deepEqual(errors, [
    'issue #6 has a sub-issue in another repository: other/repo#8',
  ]);
});

test('a released claim frees the leaf, and free-text claims count until released', () => {
  assert.equal(
    claimRecord([
      claim({ agent: 'a', branch: 'agent/1-x' }),
      claim({ agent: 'a', released: true }),
    ]),
    null,
  );
  const legacy = claimRecord([
    comment(
      'Claiming for delivery.\n- Branch: `agent/1-x`\n- Worktree: `.claude/worktrees/agent-1-x`',
    ),
  ]);
  assert.equal(legacy.branch, 'agent/1-x');
  assert.equal(legacy.worktree, '.claude/worktrees/agent-1-x');
  assert.equal(
    claimRecord([
      comment('Claiming this.'),
      comment('Releasing the claim: blocked on credentials.'),
    ]),
    null,
  );
  // Comments from outside contributors never claim work.
  assert.equal(
    claimRecord([comment('I claim this', { author_association: 'NONE' })]),
    null,
  );
  // A later-escalation record that mentions the claim does not replace it,
  // so the structured release still clears it.
  const structured = claim({ agent: 'claude-1-t', branch: 'agent/1-x' });
  const escalation = comment(
    `Escalating; this is not a second claim.\n<!-- prism-effort ${JSON.stringify(H3)} -->`,
  );
  assert.equal(claimRecord([structured, escalation]).agent, 'claude-1-t');
  assert.equal(
    claimRecord([
      structured,
      escalation,
      claim({ agent: 'claude-1-t', released: true }),
    ]),
    null,
  );
  // A free-text release by the account that posted a structured claim clears it.
  assert.equal(
    claimRecord([structured, comment('Releasing the claim.')]),
    null,
  );
});

test('a blocker with a stackable PR makes the leaf ready on that branch', () => {
  const approved = `Closes #20\n\nPre-PR review: APPROVE; base=${BASE}; head=${HEAD}`;
  const passing = {
    [HEAD]: { runs: [{ status: 'completed', conclusion: 'success' }] },
  };
  const issues = { 1: { children: [8] }, 8: { blockedBy: [20] }, 20: {} };
  const ready = deliveryQueue(policy, 1, {
    api: fakeApi({
      issues,
      prs: [pr(40, 20, { body: approved })],
      checks: passing,
    }),
  }).rows[0];
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.base, { branch: 'agent/20-thing', sha: HEAD });
  // Failing checks, a draft, or an approval for an older head do not qualify.
  for (const [prs, checks] of [
    [
      [pr(40, 20, { body: approved })],
      { [HEAD]: { runs: [{ status: 'completed', conclusion: 'failure' }] } },
    ],
    [[pr(40, 20, { body: approved, draft: true })], passing],
    [
      [
        pr(40, 20, {
          body: approved,
          head: { ref: 'agent/20-thing', sha: 'd'.repeat(40) },
        }),
      ],
      passing,
    ],
  ])
    assert.equal(
      deliveryQueue(policy, 1, { api: fakeApi({ issues, prs, checks }) })
        .rows[0].state,
      'waiting',
    );
  const two = deliveryQueue(policy, 1, {
    api: fakeApi({
      issues: {
        1: { children: [8] },
        8: { blockedBy: [20, 21] },
        20: {},
        21: {},
      },
      prs: [
        pr(40, 20, { body: approved }),
        pr(41, 21, { body: approved.replace('#20', '#21') }),
      ],
      checks: passing,
    }),
  }).rows[0];
  assert.equal(two.state, 'waiting');
  assert.match(two.blocker, /#20, #21 need a stacking decision/);
});

test('approval records accept the fixed line and the older free text', () => {
  assert.deepEqual(
    approvalPair(`Pre-PR review: APPROVE; base=${BASE}; head=${HEAD}`),
    {
      base: BASE,
      head: HEAD,
    },
  );
  assert.deepEqual(
    approvalPair(
      `Pre-PR review: APPROVE in round 3 for \`${BASE}..${HEAD}\`, with no open findings.`,
    ),
    { base: BASE, head: HEAD },
  );
  assert.equal(approvalPair('Pre-PR review: skipped (docs only)'), null);
  assert.equal(
    stackReady(
      pr(1, 2, { body: `Pre-PR review: APPROVE; base=${BASE}; head=${HEAD}` }),
      [],
      [],
    ),
    false,
  );
});

test('an inaccessible child or blocker, and a link to another repository, block only that leaf', () => {
  const { rows, errors } = deliveryQueue(policy, 1, {
    api: fakeApi({
      issues: {
        1: { children: [2, 3, 4, 5] },
        2: { error: true },
        3: { blockedBy: [9] },
        4: { blockedBy: [{ number: 7, repository: 'other/repo' }] },
        5: {},
        9: { error: true },
      },
    }),
  });
  const byIssue = Object.fromEntries(rows.map((row) => [row.issue, row]));
  assert.match(byIssue[2].blocker, /^BLOCKED: issue #2 inaccessible/);
  assert.equal(byIssue[3].blocker, 'BLOCKED: blocker #9 inaccessible');
  assert.equal(
    byIssue[4].blocker,
    'BLOCKED: blocker other/repo#7 is in another repository',
  );
  assert.equal(byIssue[5].state, 'ready');
  assert.equal(errors.length, 3);
});

test('a malformed record blocks only its leaf', () => {
  const { rows, errors } = deliveryQueue(policy, 1, {
    api: fakeApi({
      issues: {
        1: { children: [2, 3] },
        2: { comments: [comment('<!-- prism-claim {"agent": -->')] },
        3: {},
      },
    }),
  });
  assert.match(rows[0].blocker, /^BLOCKED: issue #2 has an invalid record/);
  assert.equal(rows[1].state, 'ready');
  assert.equal(errors.length, 1);
});

test('--next resumes first, reports an earlier owned leaf, and honors --skip', () => {
  const rows = [
    { issue: 2, state: 'done' },
    { issue: 3, state: 'owned elsewhere' },
    { issue: 4, state: 'ready' },
    { issue: 5, state: 'resume' },
  ];
  assert.equal(nextLeaf(rows).issue, 5);
  assert.equal(nextLeaf(rows.slice(0, 3)).issue, 3);
  assert.equal(nextLeaf(rows.slice(0, 3), [3]).issue, 4);
  assert.equal(nextLeaf(rows, [3, 4, 5]), undefined);
});

test('effort defaults to medium; metadata never selects high', () => {
  const ordinary = implementationEffort(policy);
  assert.deepEqual(ordinary, {
    effort: 'medium',
    rule: 'default',
    evidence: 'issue/spec',
    reason: 'The written plan resolves the design.',
  });
  // A well-specified contract change, Size M and L, serious bug and risk
  // labels, and repeated routine review fixes leave no qualifying record.
  const contract =
    '### Implementation notes\n\nChange the shared `ReviewResult` contract and update its three consumers. The spec fixes the new field names and the migration order.';
  const labels = ['bug', 'severity: critical', 'risk: data-contract'];
  const size = (n, value) => ({
    content: { number: n, repository_url: URL },
    fields: [
      { name: 'Status', value: { name: { raw: 'Ready' } } },
      { name: 'Size', value: { name: { raw: value } } },
    ],
  });
  const { rows } = deliveryQueue(policy, 1, {
    api: fakeApi({
      issues: {
        1: { children: [2, 3] },
        2: { labels, body: contract },
        3: {
          labels,
          body: contract,
          comments: [
            comment('Review round 1: fixed formatting.'),
            comment('Review round 2: fixed a typo.'),
          ],
        },
      },
      items: [size(2, 'M'), size(3, 'L')],
    }),
  });
  assert.deepEqual(
    rows.map((row) => [row.issue, row.size, row.project, row.effort]),
    [
      [2, 'M', 'Ready', ordinary],
      [3, 'L', 'Ready', ordinary],
    ],
  );
  assert.deepEqual(
    effortRecord(
      [
        comment('Review round 1: fixed formatting.'),
        comment('Review round 2: fixed a typo.'),
      ],
      policy,
    ),
    ordinary,
  );
});

test('each rubric rule selects high only with all of its recorded evidence', () => {
  for (const decision of [H1, H2, { ...H3, later: false }]) {
    assert.equal(
      implementationEffort(policy, { decision }).effort,
      'high',
      decision.rule,
    );
    for (const key of Object.keys(decision.criteria)) {
      const missing = {
        ...decision,
        criteria: { ...decision.criteria, [key]: false },
      };
      assert.equal(
        implementationEffort(policy, { decision: missing }).rule,
        'default',
        `${decision.rule} ${key}`,
      );
    }
    for (const field of ['question', 'evidence', 'reason'])
      assert.equal(
        implementationEffort(policy, {
          decision: { ...decision, [field]: ' ' },
        }).rule,
        'default',
        `${decision.rule} ${field}`,
      );
  }
  // Automatic escalation stops at high, and unknown rules fall back.
  assert.equal(
    implementationEffort(policy, { decision: { ...H1, effort: 'xhigh' } }).rule,
    'default',
  );
  assert.equal(
    implementationEffort(policy, { decision: { ...H1, rule: 'H4-size' } }).rule,
    'default',
  );
});

test('an explicit override wins, and an explicit medium prevents escalation', () => {
  assert.deepEqual(
    implementationEffort(policy, { override: 'low', decision: H1 }),
    {
      effort: 'low',
      rule: 'user override',
      evidence: 'explicit user constraint',
      reason: 'The request selects this effort.',
    },
  );
  const medium = {
    effort: 'medium',
    rule: 'user override',
    agent: 'claude-1-t',
    evidence: 'implementer effort medium in the request',
    reason: 'The request fixes medium.',
  };
  assert.deepEqual(
    effortRecord([effort(medium), effort(H3)], policy, 'claude-1-t'),
    medium,
  );
  // An override ends with the delivery that recorded it.
  assert.deepEqual(
    effortRecord([effort(medium), effort(H3)], policy, 'codex-1-u'),
    H3,
  );
  assert.deepEqual(
    effortRecord([effort(medium)], policy),
    implementationEffort(policy),
  );
  // --effort reaches the ledger and the announcement.
  const api = fakeApi({ issues: { 2: {} } });
  const next = run(['2', '--next', '--effort', 'high'], {
    policy,
    api,
    worktrees: [],
  });
  assert.match(next.lines[0], /effort=high; rule=user override;/);
  assert.equal(
    next.lines[1],
    'Implementation effort: medium -> high; issue: #2; rule: user override; evidence: explicit user constraint; reason: The request selects this effort.',
  );
  assert.throws(
    () =>
      implementationEffort(policy, {
        decision: { rule: 'user override', effort: 'high' },
      }),
    /needs effort, evidence, and reason/,
  );
});

test('one later escalation is allowed per leaf; a second blocks it', () => {
  assert.deepEqual(effortRecord([effort(H3)], policy), H3);
  assert.throws(
    () => effortRecord([effort(H3), effort(H3)], policy),
    /Only one automatic medium-to-high transition/,
  );
  // A later record without its required evidence stays at medium and does
  // not use up the transition.
  const weak = { ...H3, criteria: { mediumAttempt: true } };
  assert.deepEqual(effortRecord([effort(weak), effort(H3)], policy), H3);
  const { rows } = deliveryQueue(policy, 2, {
    api: fakeApi({ issues: { 2: { comments: [effort(H3), effort(H3)] } } }),
  });
  assert.match(
    rows[0].blocker,
    /^BLOCKED: issue #2 has an invalid record: Only one automatic/,
  );
});

test('the announcement names the rule, evidence, and reason above medium', () => {
  assert.equal(
    effortAnnouncement(7, implementationEffort(policy)),
    'Implementation effort: medium (default)',
  );
  assert.equal(
    effortAnnouncement(7, H3),
    'Implementation effort: medium -> high; issue: #7; rule: H3-demonstrated-limit; evidence: Reproducible case race-1 after the medium attempt; reason: The attempt requires revising the ordering design.',
  );
});

test('run prints one ledger line per leaf, and --next adds the announcement', () => {
  const api = fakeApi({
    issues: { 1: { children: [2, 3] }, 2: { comments: [effort(H1)] }, 3: {} },
  });
  const all = run(['1'], { policy, api, worktrees: [] });
  assert.equal(all.lines.length, 2);
  assert.match(all.lines[0], /^#2 \| ready \| effort=high; rule=H1-boundary; /);
  assert.match(
    all.lines[1],
    new RegExp(
      `^#3 \\| ready \\| effort=medium; rule=default; .* \\| base=main@${TRUNK}; `,
    ),
  );
  const next = run(['1', '--next', '--skip', '2'], {
    policy,
    api,
    worktrees: [],
  });
  assert.deepEqual(next.lines.slice(1), [
    'Implementation effort: medium (default)',
  ]);
  assert.match(next.lines[0], /^#3 \| ready/);
  assert.deepEqual(
    run(['1', '--next', '--skip', '2,3'], { policy, api, worktrees: [] }).lines,
    ['No resume, ready, or owned-elsewhere leaf remains.'],
  );
  assert.equal(
    ledgerLine({
      issue: 9,
      state: 'waiting',
      effort: implementationEffort(policy),
      blocker: 'BLOCKED: x',
    }),
    '#9 | waiting | effort=medium; rule=default; evidence=issue/spec; reason=The written plan resolves the design. | BLOCKED: x',
  );
});

test('parses arguments and rejects bad ones', () => {
  assert.deepEqual(
    parseArguments([
      '12',
      '--next',
      '--resume',
      '13',
      '--actor',
      'claude-12-t',
      '--effort',
      'high',
      '--skip',
      '14,15',
    ]),
    {
      issue: 12,
      next: true,
      resume: 13,
      actor: 'claude-12-t',
      effort: 'high',
      skip: [14, 15],
    },
  );
  for (const argv of [
    [],
    ['x'],
    ['1', '2'],
    ['1', '--resume'],
    ['1', '--resume', '2,3'],
    ['1', '--skip', 'a'],
    ['1', '--bogus'],
  ])
    assert.throws(() => parseArguments(argv), undefined, argv.join(' '));
});

test('the REST client pages with GET and flattens the pages', () => {
  const calls = [];
  const api = restClient((command, args) => {
    calls.push([command, ...args]);
    return args.includes('--slurp')
      ? JSON.stringify([{ check_runs: [1, 2] }, { check_runs: [3] }])
      : JSON.stringify({ sha: TRUNK });
  });
  assert.deepEqual(
    api.list(`${REPO}/commits/x/check-runs`, 'check_runs'),
    [1, 2, 3],
  );
  assert.deepEqual(api.get(`${REPO}/commits/main`), { sha: TRUNK });
  assert.deepEqual(calls[0], [
    'gh',
    'api',
    '-X',
    'GET',
    `${REPO}/commits/x/check-runs?per_page=100`,
    '--paginate',
    '--slurp',
  ]);
  assert.deepEqual(calls[1], [
    'gh',
    'api',
    '-X',
    'GET',
    `${REPO}/commits/main`,
  ]);
});
