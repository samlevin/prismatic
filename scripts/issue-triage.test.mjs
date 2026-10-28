import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  configuration,
  discover,
  DONE_FILTERS,
  eligible,
  SETTLED_STATUSES,
  SWEEP_FILTER,
  graphqlBudget,
  MissingIssueError,
  paginate,
  readItem,
  reconcile,
  reconcileDone,
  reconcileEpicLabels,
  REPOSITORY,
  runTracker,
  SWEEP_FLOOR,
  trackerGraphql,
} from './issue-triage.mjs';
import { GitHubError } from './github-api.mjs';

// `gh api --include` output: a status line, CRLF headers, a blank line, the body.
function httpResponse(status, headers, body) {
  const lines = Object.entries(headers).map(
    ([name, value]) => `${name}: ${value}\r\n`,
  );
  return `HTTP/2.0 ${status} Status\n${lines.join('')}\r\n${
    typeof body === 'string' ? body : JSON.stringify(body)
  }`;
}

// gh exits non-zero on an HTTP or GraphQL error and writes the response to stdout.
function ghFails(stdout, overrides = {}) {
  return () => {
    throw Object.assign(new Error('Command failed: gh api'), {
      status: 1,
      stderr: 'gh: stderr-marker',
      stdout,
      ...overrides,
    });
  };
}

const RESET = 1792126278;
const RESET_AT = new Date(RESET * 1000).toISOString();
const exhausted = {
  'X-Ratelimit-Limit': '5000',
  'X-Ratelimit-Remaining': '0',
  'X-Ratelimit-Reset': String(RESET),
};

const budget = (remaining, overrides = {}) => ({
  limit: 5000,
  remaining,
  used: 5000 - remaining,
  reset: RESET,
  ...overrides,
});

// Installs a stand-in for gh that answers every GraphQL and REST call with a
// rate limit and leaks the token on stderr. The free REST rate_limit endpoint
// answers with a healthy GraphQL budget.
function fakeGh(t) {
  const directory = mkdtempSync(join(tmpdir(), 'prism-fake-gh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'graphql.txt'),
    httpResponse(200, exhausted, {
      errors: [
        {
          type: 'RATE_LIMITED',
          message: 'API rate limit already exceeded for user ID 1.',
        },
      ],
    }),
  );
  writeFileSync(
    join(directory, 'rest.txt'),
    httpResponse(403, exhausted, {
      message: 'API rate limit exceeded for user ID 1.',
    }),
  );
  writeFileSync(
    join(directory, 'budget.txt'),
    httpResponse(200, {}, { resources: { graphql: budget(4000) } }),
  );
  writeFileSync(
    join(directory, 'gh'),
    [
      '#!/bin/sh',
      'cat > /dev/null',
      'case "$*" in',
      '  *graphql*) cat "$FAKE_GH_DIR/graphql.txt" ;;',
      '  *rate_limit*) cat "$FAKE_GH_DIR/budget.txt"; exit 0 ;;',
      '  *) cat "$FAKE_GH_DIR/rest.txt" ;;',
      'esac',
      'echo "gh: stderr-marker $GH_TOKEN" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(join(directory, 'gh'), 0o755);
  const run = (script, args, env = {}) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL(script, import.meta.url)), ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          FAKE_GH_DIR: directory,
          GH_TOKEN: 'fake-token-value-188',
          PR_NUMBER: '10',
          DRY_RUN: 'true',
          ...env,
        },
      },
    );
  return Object.assign(run, { directory });
}

const budgetLines = (stdout) =>
  stdout
    .split('\n')
    .filter(Boolean)
    .every((line) => line.startsWith('GraphQL budget '));

test('sweeps and PR scripts exit non-zero with the shared rate-limit message', (t) => {
  const run = fakeGh(t);
  const scripts = [
    ['issue-triage.mjs', ['--dry-run'], {}, 'GraphQL'],
    ['issue-containers.mjs', ['--dry-run'], {}, 'GraphQL'],
    ['issue-project-membership.mjs', [], { SWEEP: 'true' }, 'GraphQL'],
    ['issue-pr-metadata.mjs', [], {}, 'GraphQL'],
    ['issue-pr-status.mjs', [], {}, 'GraphQL'],
    ['branch-name.mjs', ['188'], {}, 'REST'],
  ];
  for (const [script, args, env, api] of scripts) {
    const result = run(script, args, env);
    assert.equal(result.status, 1, script);
    assert.ok(budgetLines(result.stdout), `${script}: ${result.stdout}`);
    const detail =
      api === 'GraphQL'
        ? 'RATE_LIMITED: API rate limit already exceeded for user ID 1.'
        : 'HTTP 403: API rate limit exceeded for user ID 1.';
    assert.equal(
      result.stderr,
      `GitHub ${api} request failed: ${detail} Rate limit reached; the limit resets at ${RESET_AT}.\n`,
      script,
    );
  }
});

test('single-issue tracker runs warn and succeed when rate-limited', (t) => {
  const run = fakeGh(t);
  for (const [script, args, env] of [
    ['issue-triage.mjs', ['--dry-run', '--issue', '5'], {}],
    ['issue-containers.mjs', ['--dry-run', '--issue', '5'], {}],
    [
      'issue-project-membership.mjs',
      [],
      { CONTENT_TYPE: 'issue', CONTENT_NUMBER: '5' },
    ],
  ]) {
    const result = run(script, args, env);
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.equal(result.stderr, '', script);
    assert.ok(
      result.stdout.includes(
        `::warning::GitHub GraphQL request failed: RATE_LIMITED: API rate limit already exceeded for user ID 1. Rate limit reached; the limit resets at ${RESET_AT}. The next scheduled sweep reconciles this issue.\n`,
      ),
      script,
    );
    assert.match(result.stdout, /^GraphQL budget before: 4000 of 5000/);
    assert.ok(!result.stdout.includes('fake-token-value-188'), script);
  }
});

function tracker(readings, task, sweep) {
  const out = { logs: [], warnings: [], errors: [], ran: false };
  const queue = [...readings];
  const promise = runTracker({
    sweep,
    task: async () => {
      out.ran = true;
      await task();
    },
    budget: () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    log: (line) => out.logs.push(line),
    warn: (line) => out.warnings.push(line),
    error: (line) => out.errors.push(line),
  });
  return promise.then((status) => ({ ...out, status }));
}

const rateLimited = () =>
  new GitHubError('GitHub GraphQL request failed: RATE_LIMITED.', {
    kind: 'rate-limit',
  });

test('a run logs the GraphQL points used between its two budget readings', async () => {
  const result = await tracker(
    [budget(4800), budget(4786)],
    async () => {},
    true,
  );
  assert.equal(result.status, 0);
  assert.deepEqual(result.logs, [
    `GraphQL budget before: 4800 of 5000 points remain; the window resets at ${RESET_AT}.`,
    'GraphQL budget after: 4786 points remain; 14 were used during the run, counting every client of this account.',
  ]);
  const reset = await tracker(
    [budget(1200), budget(4990, { reset: RESET + 3600 })],
    async () => {},
    true,
  );
  assert.equal(
    reset.logs[1],
    'GraphQL budget after: 4990 points remain; the window reset during the run.',
  );
});

test('a sweep below the floor skips with a warning; a single-issue run still runs', async () => {
  const skipped = await tracker(
    [budget(SWEEP_FLOOR - 1)],
    async () => {},
    true,
  );
  assert.equal(skipped.status, 0);
  assert.equal(skipped.ran, false);
  assert.deepEqual(skipped.warnings, [
    `Skipped the sweep: ${SWEEP_FLOOR - 1} GraphQL points remain, below the floor of ${SWEEP_FLOOR}. The next scheduled sweep reconciles.`,
  ]);
  const atFloor = await tracker(
    [budget(SWEEP_FLOOR), budget(SWEEP_FLOOR)],
    async () => {},
    true,
  );
  assert.equal(atFloor.ran, true);
  const event = await tracker([budget(10), budget(5)], async () => {}, false);
  assert.equal(event.ran, true);
  assert.deepEqual(event.warnings, []);
});

test('only a single-issue run tolerates a rate limit; other failures fail the run', async () => {
  const event = await tracker(
    [budget(10), budget(0)],
    async () => {
      throw rateLimited();
    },
    false,
  );
  assert.equal(event.status, 0);
  assert.deepEqual(event.errors, []);
  assert.deepEqual(event.warnings, [
    'GitHub GraphQL request failed: RATE_LIMITED. The next scheduled sweep reconciles this issue.',
  ]);
  const sweep = await tracker(
    [budget(4000), budget(0)],
    async () => {
      throw rateLimited();
    },
    true,
  );
  assert.equal(sweep.status, 1);
  assert.deepEqual(sweep.errors, [
    'GitHub GraphQL request failed: RATE_LIMITED.',
  ]);
  for (const failure of [
    new GitHubError('GitHub GraphQL request failed: HTTP 502.', {
      kind: 'other',
    }),
    new Error('Issue hierarchy cycle'),
    Object.assign(new Error('rate limit text'), { kind: 'rate-limit' }),
  ]) {
    const result = await tracker(
      [budget(4000), budget(4000)],
      async () => {
        throw failure;
      },
      false,
    );
    assert.equal(result.status, 1, failure.message);
    assert.equal(result.errors.length, 1, failure.message);
  }
});

test('an unreadable budget warns and the run continues without a floor', async () => {
  const result = await tracker(
    [new Error('no budget'), new Error('no budget')],
    async () => {},
    true,
  );
  assert.equal(result.status, 0);
  assert.equal(result.ran, true);
  assert.deepEqual(result.logs, []);
  assert.deepEqual(result.warnings, [
    'Could not read the GraphQL budget: no budget',
    'Could not read the GraphQL budget: no budget',
  ]);
});

test('the budget comes from the REST rate_limit endpoint', () => {
  const calls = [];
  const respond = (body) => (command, args) => {
    calls.push([command, ...args]);
    return httpResponse(200, {}, body);
  };
  assert.deepEqual(
    graphqlBudget(
      respond({
        resources: {
          core: budget(1),
          graphql: { ...budget(4321), extra: true },
        },
      }),
    ),
    budget(4321),
  );
  assert.deepEqual(calls, [['gh', 'api', '--include', 'rate_limit']]);
  for (const body of [
    {},
    { resources: { graphql: { ...budget(1), remaining: '1' } } },
  ])
    assert.throws(() => graphqlBudget(respond(body)), /no GraphQL rate limit/);
});

function issue(overrides = {}) {
  return {
    id: 'item',
    type: 'ISSUE',
    content: {
      id: 'issue',
      __typename: 'Issue',
      number: 1,
      state: 'OPEN',
      repository: { nameWithOwner: REPOSITORY },
    },
    labels: ['severity: none'],
    fields: { Status: 'Inbox', Priority: 'P2', Size: 'M' },
    ...overrides,
  };
}

test('the exact metadata predicate includes all supported priorities, severities and sizes', () => {
  for (const Priority of ['P0', 'P1', 'P2', 'P3']) {
    for (const Size of ['XS', 'S', 'M', 'L']) {
      for (const severity of ['critical', 'high', 'medium', 'low', 'none']) {
        assert.equal(
          eligible(
            issue({
              fields: { Status: 'Inbox', Priority, Size },
              labels: [`severity: ${severity}`, 'type: epic'],
            }),
          ),
          true,
        );
      }
    }
  }
  // Neither acceptance text nor type, area, and package labels are predicate requirements.
  assert.equal(eligible(issue()), true);
});

test('an empty Status qualifies like Inbox', () => {
  const base = issue();
  assert.equal(
    eligible(issue({ fields: { ...base.fields, Status: 'Inbox' } })),
    true,
  );
  assert.equal(
    eligible(issue({ fields: { ...base.fields, Status: undefined } })),
    true,
  );
  assert.equal(
    eligible(issue({ fields: { ...base.fields, Status: 'Ready' } })),
    false,
  );
});

test('reject PRs, drafts, other repositories, closed issues, invalid metadata and later states', () => {
  const base = issue();
  const cases = [
    { type: 'PULL_REQUEST' },
    { type: 'DRAFT_ISSUE', content: null },
    { content: { ...base.content, __typename: 'PullRequest' } },
    {
      content: {
        ...base.content,
        repository: { nameWithOwner: 'other/repository' },
      },
    },
    { content: { ...base.content, state: 'CLOSED' } },
    ...['Ready', 'In progress', 'In review', 'Done'].map((Status) => ({
      fields: { ...base.fields, Status },
    })),
    ...['P4', undefined].map((Priority) => ({
      fields: { ...base.fields, Priority },
    })),
    ...['XL', undefined].map((Size) => ({ fields: { ...base.fields, Size } })),
    ...[
      [],
      ['severity: unknown'],
      ['severity: none', 'severity: high'],
      ['severity: none', 'severity:unknown'],
    ].map((labels) => ({ labels })),
  ];
  for (const value of cases)
    assert.equal(eligible(issue(value)), false, JSON.stringify(value));
});

test('pagination keeps every page, skips deleted nodes, and rejects broken cursors', async () => {
  const cursors = [];
  assert.deepEqual(
    await paginate(async (cursor) => {
      cursors.push(cursor);
      return cursor === null
        ? {
            nodes: [1, null],
            pageInfo: { hasNextPage: true, endCursor: 'next' },
          }
        : { nodes: [2], pageInfo: { hasNextPage: false } };
    }),
    [1, 2],
  );
  assert.deepEqual(cursors, [null, 'next']);
  await assert.rejects(
    paginate(async () => ({
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: 'stuck' },
    })),
    /did not advance/,
  );
  await assert.rejects(
    paginate(async () => null),
    /Missing GraphQL connection/,
  );
});

// A mocked Prismatic delivery project. Listing and single-issue reads return each
// item with the first page of its field values and labels nested; issue #1's
// item overflows both, so its remaining pages come from follow-up reads.
const EMPTY = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

function mockApi({
  race,
  multipleSeverity = false,
  additionalIssue = false,
} = {}) {
  const state = {
    mutations: [],
    queries: [],
    readItems: [],
    itemFilters: [],
    status: 'Inbox',
    otherStatus: 'Inbox',
    lastFields: {},
  };
  const definitions = Object.entries({
    Status: ['Inbox', 'Ready', 'In progress'],
    Priority: ['P0', 'P1', 'P2', 'P3'],
    Size: ['XS', 'S', 'M', 'L'],
  }).map(([name, options]) => ({
    id: `field-${name}`,
    name,
    options: options.map((name) => ({ id: `option-${name}`, name })),
  }));
  const connection = (nodes, next = false) => ({
    nodes,
    pageInfo: { hasNextPage: next, endCursor: next ? 'next' : null },
  });
  const values = (fields) =>
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({
        field: { id: `field-${name}` },
        optionId: `option-${value}`,
      }));
  const extraLabels = () =>
    multipleSeverity || state.extraSeverity ? [{ name: 'severity: high' }] : [];
  const node = (id, fields) => {
    const second = id === 'item-2';
    fields ??= {
      Status: second ? state.otherStatus : state.status,
      Priority: 'P2',
      Size: 'L',
    };
    state.lastFields[id] = fields;
    const content = {
      __typename: 'Issue',
      id: second ? 'issue-2' : 'issue',
      number: second || state.renumbered ? 2 : 1,
      state: state.closed ? 'CLOSED' : 'OPEN',
      repository: {
        nameWithOwner:
          state.foreign || state.transferred?.includes(id)
            ? 'other/repo'
            : REPOSITORY,
      },
      labels: second
        ? connection([{ name: 'severity: none' }])
        : connection([{ name: 'severity: none' }], true),
    };
    return {
      id,
      type: 'ISSUE',
      project: { id: 'project' },
      fieldValues: second
        ? connection(values(fields))
        : connection(values(fields).slice(0, 1), true),
      content,
    };
  };
  const listed = () => (additionalIssue ? ['item', 'item-2'] : ['item']);
  const api = async (query, variables) => {
    const page = variables.cursor ? 1 : 0;
    if (query.startsWith('mutation')) {
      assert.match(query, /updateProjectV2ItemFieldValue/);
      state.mutations.push(variables);
      if (variables.item === 'item-2') state.otherStatus = 'Ready';
      else state.status = 'Ready';
      return {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: variables.item },
        },
      };
    }
    if (query.includes('projectV2(number: 2)')) {
      state.queries.push(`definitions-${page}`);
      return {
        user: {
          projectV2: {
            id: 'project',
            fields: page
              ? connection(definitions.slice(1))
              : connection(definitions.slice(0, 1), true),
          },
        },
      };
    }
    if (query.includes('items(first: 100')) {
      state.queries.push(`items-${page}`);
      state.itemFilters.push(variables.filter);
      return {
        node: {
          items: page
            ? connection(listed().map((id) => node(id)))
            : connection(
                [
                  { id: 'pr', type: 'PULL_REQUEST', content: {} },
                  { id: 'draft', type: 'DRAFT_ISSUE', content: null },
                  {
                    ...node('other'),
                    content: {
                      __typename: 'Issue',
                      repository: { nameWithOwner: 'other/repo' },
                    },
                  },
                ],
                true,
              ),
        },
      };
    }
    if (query.includes('projectItems(first: 20')) {
      state.queries.push(`issue-items-${variables.number}`);
      const id = { 1: 'item', 2: 'item-2' }[variables.number];
      // Issue 404 was deleted; any other unknown issue is outside the project.
      if (!id || !listed().includes(id))
        return {
          repository: {
            issue: variables.number === 404 ? null : { projectItems: EMPTY },
          },
        };
      // The same issue in another project is never read or written.
      const own = node(id);
      const elsewhere = { ...own, id: 'elsewhere', project: { id: 'x' } };
      // An archived item is listed only to a read that includes archived items.
      const hidden =
        state.archived?.includes(id) &&
        query.includes('includeArchived: false');
      return {
        repository: {
          issue: {
            projectItems: connection(hidden ? [elsewhere] : [elsewhere, own]),
          },
        },
      };
    }
    if (query.includes('fieldValues(first: 100, after: $cursor)')) {
      state.queries.push(`values-${variables.id}`);
      return {
        node: {
          fieldValues: connection(
            values(state.lastFields[variables.id]).slice(1),
          ),
        },
      };
    }
    if (query.includes('labels(first: 100, after: $cursor)')) {
      state.queries.push(`labels-${variables.id}`);
      return { node: { labels: connection(extraLabels()) } };
    }
    if (query.includes('... on ProjectV2Item {')) {
      state.queries.push(`read-${variables.id}`);
      state.readItems.push(variables.id);
      if (state.deleted?.includes(variables.id)) return { node: null };
      const fields = {
        Status: variables.id === 'item-2' ? state.otherStatus : state.status,
        Priority: 'P2',
        Size: 'L',
      };
      if (race) race(fields, state);
      return { node: node(variables.id, fields) };
    }
    throw new Error(`Unexpected mock query ${query}`);
  };
  return { api, state, definitions };
}

test('discovery and item reads take nested pages first, then read only overflowing connections', async () => {
  const { api, state } = mockApi({ multipleSeverity: true });
  const context = await discover(api);
  assert.equal(context.fields.Size.id, 'field-Size');
  const item = await readItem(api, 'item', context);
  assert.equal(item.fields.Size, 'L');
  assert.equal(item.fields.Status, 'Inbox');
  assert.deepEqual(item.labels, ['severity: none', 'severity: high']);
  assert.equal(item.content.labels, undefined);
  assert.equal(eligible(item), false);
  assert.deepEqual(state.queries, [
    'definitions-0',
    'definitions-1',
    'read-item',
    'values-item',
    'labels-issue',
  ]);
});

test('a sweep reads the project in pages with nested metadata and re-reads only candidates', async () => {
  const { api, state } = mockApi({ additionalIssue: true });
  assert.deepEqual(await reconcile({ api, log: () => {} }), {
    candidates: 2,
    updated: 0,
  });
  // Issue #2 fits in its nested pages; issue #1 overflows both connections.
  assert.deepEqual(state.queries, [
    'definitions-0',
    'definitions-1',
    'items-0',
    'items-1',
    'values-item',
    'labels-issue',
    'read-item',
    'values-item',
    'labels-issue',
    'read-item-2',
  ]);
});

test('a sweep at the current project size costs a few calls, not two per item', async () => {
  const calls = [];
  const items = Array.from({ length: 251 }, (_, index) => ({
    id: `item-${index}`,
    type: 'ISSUE',
    project: { id: 'project' },
    fieldValues: {
      nodes: [{ field: { id: 'field-Status' }, optionId: 'option-Done' }],
      pageInfo: { hasNextPage: false },
    },
    content: {
      __typename: 'Issue',
      id: `issue-${index}`,
      number: index + 1,
      state: 'OPEN',
      repository: { nameWithOwner: REPOSITORY },
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
    },
  }));
  const api = async (query, variables) => {
    calls.push(query);
    if (query.includes('projectV2(number: 2)'))
      return {
        user: {
          projectV2: {
            id: 'project',
            fields: {
              nodes: Object.entries({
                Status: ['Inbox', 'Ready', 'Done'],
                Priority: ['P0', 'P1', 'P2', 'P3'],
                Size: ['XS', 'S', 'M', 'L'],
              }).map(([name, options]) => ({
                id: `field-${name}`,
                name,
                options: options.map((name) => ({
                  id: `option-${name}`,
                  name,
                })),
              })),
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    assert.match(query, /items\(first: 100/);
    const start = Number(variables.cursor ?? 0);
    const end = start + 100;
    return {
      node: {
        items: {
          nodes: items.slice(start, end),
          pageInfo: {
            hasNextPage: end < items.length,
            endCursor: String(end),
          },
        },
      },
    };
  };
  assert.deepEqual(await reconcile({ api, log: () => {} }), {
    candidates: 0,
    updated: 0,
  });
  assert.equal(calls.length, 4);
});

test('dry-run discovers every item page and never mutates; apply is idempotent', async () => {
  const { api, state } = mockApi();
  assert.deepEqual(await reconcile({ api, log: () => {} }), {
    candidates: 1,
    updated: 0,
  });
  assert.equal(state.mutations.length, 0);
  assert.ok(state.queries.includes('items-1'));
  // Every page asks only for open issues whose Status can still qualify.
  assert.deepEqual(state.itemFilters, [SWEEP_FILTER, SWEEP_FILTER]);
  assert.deepEqual(await reconcile({ api, dryRun: false, log: () => {} }), {
    candidates: 1,
    updated: 1,
  });
  assert.deepEqual(state.mutations, [
    {
      project: 'project',
      item: 'item',
      field: 'field-Status',
      option: 'option-Ready',
    },
  ]);
  assert.deepEqual(await reconcile({ api, dryRun: false, log: () => {} }), {
    candidates: 0,
    updated: 0,
  });
  assert.equal(state.mutations.length, 1);
});

test('re-read rejects eligibility changes at the mutation boundary', async () => {
  for (const race of [
    (fields) => {
      fields.Status = 'In progress';
    },
    (fields) => {
      fields.Priority = 'invalid';
    },
    (fields) => {
      fields.Size = undefined;
    },
    (_fields, state) => {
      state.extraSeverity = true;
    },
    (_fields, state) => {
      state.closed = true;
    },
    (_fields, state) => {
      state.foreign = true;
    },
  ]) {
    const { api, state } = mockApi({ race });
    assert.deepEqual(await reconcile({ api, dryRun: false, log: () => {} }), {
      candidates: 0,
      updated: 0,
    });
    assert.deepEqual(state.readItems, ['item']);
    assert.equal(state.mutations.length, 0);
  }
});

test('an issue with no Status value moves to Ready', async () => {
  const { api, state } = mockApi();
  state.status = undefined;
  const logs = [];
  assert.deepEqual(
    await reconcile({
      api,
      issueNumber: 1,
      dryRun: false,
      log: (line) => logs.push(line),
    }),
    { candidates: 1, updated: 1 },
  );
  assert.match(logs[0], /issue #1 empty Status -> Ready/);
  assert.equal(state.status, 'Ready');
  assert.equal(state.mutations.length, 1);
});

test('issue filter reads only that issue and leaves another eligible issue untouched', async () => {
  for (const issueNumber of [1, 2]) {
    const { api, state } = mockApi({ additionalIssue: true });
    const logs = [];
    assert.deepEqual(
      await reconcile({ api, issueNumber, log: (line) => logs.push(line) }),
      { candidates: 1, updated: 0 },
    );
    assert.equal(state.mutations.length, 0);
    assert.equal(state.status, 'Inbox');
    assert.equal(state.otherStatus, 'Inbox');
    assert.match(logs[0], new RegExp(`issue #${issueNumber} Inbox -> Ready`));
    const selectedId = issueNumber === 1 ? 'item' : 'item-2';
    assert.deepEqual(state.readItems, [selectedId]);
    // The project is never listed for one issue.
    assert.ok(!state.queries.some((query) => query.startsWith('items-')));
    assert.ok(state.queries.includes(`issue-items-${issueNumber}`));
    assert.deepEqual(
      await reconcile({ api, issueNumber, dryRun: false, log: () => {} }),
      { candidates: 1, updated: 1 },
    );
    assert.deepEqual(
      state.mutations.map((mutation) => mutation.item),
      [selectedId],
    );
    assert.equal(issueNumber === 1 ? state.otherStatus : state.status, 'Inbox');
    assert.deepEqual(
      await reconcile({ api, issueNumber, dryRun: false, log: () => {} }),
      { candidates: 0, updated: 0 },
    );
    assert.ok(state.readItems.every((id) => id === selectedId));
    // Project-wide reconciliation still processes the remaining eligible issue.
    assert.deepEqual(await reconcile({ api, dryRun: false, log: () => {} }), {
      candidates: 1,
      updated: 1,
    });
    assert.equal(state.status, 'Ready');
    assert.equal(state.otherStatus, 'Ready');
  }
});

test('an issue outside the project reads no item metadata and performs no writes', async () => {
  const { api, state } = mockApi({ additionalIssue: true });
  assert.deepEqual(
    await reconcile({ api, issueNumber: 3, dryRun: false, log: () => {} }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(state.readItems, []);
  assert.deepEqual(state.mutations, []);
});

test('an archived project item is excluded from a single-issue run', async () => {
  const { api, state } = mockApi();
  state.archived = ['item'];
  assert.deepEqual(
    await reconcile({ api, issueNumber: 1, dryRun: false, log: () => {} }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(state.readItems, []);
  assert.deepEqual(state.mutations, []);
  assert.equal(state.status, 'Inbox');
});

test('issue filter is rechecked against fresh issue metadata before mutation', async () => {
  const { api, state } = mockApi({
    race: (_fields, state) => {
      state.renumbered = true;
    },
  });
  assert.deepEqual(
    await reconcile({ api, issueNumber: 1, dryRun: false, log: () => {} }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(state.mutations, []);
});

test('deleted project items and moved project membership cannot mutate', async () => {
  for (const node of [null, { ...issue(), project: { id: 'other-project' } }]) {
    assert.equal(
      await readItem(async () => ({ node }), 'item', { projectId: 'project' }),
      null,
    );
  }
});

test('discovery fails closed for missing or ambiguous field options', async () => {
  const { api, definitions } = mockApi();
  definitions[0].options = definitions[0].options.filter(
    (option) => option.name !== 'Ready',
  );
  await assert.rejects(discover(api), /Status option Ready/);
  definitions[1].name = 'Status';
  await assert.rejects(discover(api), /Expected one Status/);
});

// A mocked project for Done reconciliation. Each entry is one item with its
// issue number, state, Status, and repository. Listing applies the two Done
// filters; `onRead` runs before each write-boundary re-read and may change the
// entry or return null to remove the item from the project.
function board(entries, { onRead } = {}) {
  const items = new Map(
    entries.map((entry) => [
      `item-${entry.number}`,
      { type: 'ISSUE', state: 'OPEN', repository: REPOSITORY, ...entry },
    ]),
  );
  const filters = [];
  const reads = [];
  const mutations = [];
  const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } });
  const node = (id) => {
    const entry = items.get(id);
    return {
      id,
      type: entry.type,
      project: { id: 'project' },
      fieldValues: page(
        entry.status
          ? [
              {
                field: { id: 'field-Status' },
                optionId: `option-${entry.status}`,
              },
            ]
          : [],
      ),
      content: {
        __typename: entry.type === 'ISSUE' ? 'Issue' : 'PullRequest',
        id: `issue-${entry.number}`,
        number: entry.number,
        state: entry.state,
        repository: { nameWithOwner: entry.repository },
        labels: page([]),
      },
    };
  };
  const matches = (entry, filter) =>
    entry.type === 'ISSUE' &&
    (filter === DONE_FILTERS[0]
      ? entry.state === 'CLOSED' && entry.status !== 'Done'
      : entry.state === 'OPEN' && entry.status === 'Done');
  const api = async (query, variables) => {
    if (query.includes('projectV2(number: 2)'))
      return {
        user: {
          projectV2: {
            id: 'project',
            fields: page([
              {
                id: 'field-Status',
                name: 'Status',
                options: ['Inbox', 'Ready', 'In review', 'Done'].map(
                  (name) => ({ id: `option-${name}`, name }),
                ),
              },
            ]),
          },
        },
      };
    if (query.startsWith('mutation')) {
      mutations.push(variables);
      items.get(variables.item).status = variables.option.slice(
        'option-'.length,
      );
      return {};
    }
    if (query.includes('items(first: 100')) {
      filters.push(variables.filter);
      return {
        node: {
          items: page(
            [...items.keys()]
              .filter((id) => matches(items.get(id), variables.filter))
              .map(node),
          ),
        },
      };
    }
    if (query.includes('projectItems(first: 20')) {
      const id = `item-${variables.number}`;
      return {
        repository: {
          issue: { projectItems: page(items.has(id) ? [node(id)] : []) },
        },
      };
    }
    if (query.includes('... on ProjectV2Item {')) {
      reads.push(variables.id);
      if (onRead?.(items.get(variables.id), variables.id) === null)
        return { node: null };
      return { node: node(variables.id) };
    }
    throw new Error(`Unexpected mock query ${query}`);
  };
  return { api, filters, reads, mutations };
}

test('closed issues move to Done, reopened issues leave Done, and everything else stays', async () => {
  const f = board([
    { number: 1, state: 'CLOSED', status: 'In review' },
    { number: 2, state: 'CLOSED', status: 'Ready' },
    { number: 3, state: 'CLOSED' },
    { number: 4, state: 'CLOSED', status: 'Done' },
    { number: 5, state: 'OPEN', status: 'In review' },
    { number: 6, state: 'MERGED', type: 'PULL_REQUEST' },
    { number: 7, state: 'CLOSED', status: 'Ready', repository: 'other/repo' },
    { number: 8, state: 'OPEN', status: 'Done' },
    { number: 9, state: 'OPEN' },
  ]);
  const lines = [];
  assert.deepEqual(
    await reconcileDone({
      api: f.api,
      dryRun: false,
      log: (line) => lines.push(line),
    }),
    { candidates: 4, updated: 4 },
  );
  assert.deepEqual(f.filters, DONE_FILTERS);
  assert.deepEqual(f.reads, ['item-1', 'item-2', 'item-3', 'item-8']);
  assert.deepEqual(
    f.mutations,
    [
      ['item-1', 'Done'],
      ['item-2', 'Done'],
      ['item-3', 'Done'],
      ['item-8', 'Ready'],
    ].map(([item, status]) => ({
      project: 'project',
      item,
      field: 'field-Status',
      option: `option-${status}`,
    })),
  );
  assert.deepEqual(lines, [
    'Moving closed issue #1 In review -> Done',
    'Moving closed issue #2 Ready -> Done',
    'Moving closed issue #3 without Status -> Done',
    'Moving reopened issue #8 Done -> Ready',
    'Done reconciliation: 4 eligible, 4 updated; DRY_RUN=false',
  ]);
  assert.deepEqual(
    await reconcileDone({ api: f.api, dryRun: false, log() {} }),
    { candidates: 0, updated: 0 },
  );
});

test('Done reconciliation dry-runs and re-reads every item before writing', async () => {
  const dry = board([{ number: 1, state: 'CLOSED', status: 'In review' }]);
  const lines = [];
  assert.deepEqual(
    await reconcileDone({ api: dry.api, log: (line) => lines.push(line) }),
    { candidates: 1, updated: 0 },
  );
  assert.deepEqual(dry.mutations, []);
  assert.deepEqual(lines, [
    'DRY_RUN would move closed issue #1 In review -> Done',
    'Done reconciliation: 1 eligible, 0 updated; DRY_RUN=true',
  ]);

  const changes = {
    'item-1': { state: 'OPEN' },
    'item-2': { status: 'Done' },
    'item-3': { state: 'CLOSED' },
    'item-4': { repository: 'other/repo' },
  };
  const warnings = [];
  const raced = board(
    [
      { number: 1, state: 'CLOSED', status: 'In review' },
      { number: 2, state: 'CLOSED', status: 'In review' },
      { number: 3, state: 'OPEN', status: 'Done' },
      { number: 4, state: 'CLOSED', status: 'Ready' },
      { number: 5, state: 'CLOSED', status: 'Ready' },
    ],
    {
      onRead: (entry, id) =>
        id === 'item-5' ? null : Object.assign(entry, changes[id]),
    },
  );
  assert.deepEqual(
    await reconcileDone({
      api: raced.api,
      dryRun: false,
      log() {},
      warn: (line) => warnings.push(line),
    }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(raced.mutations, []);
  assert.deepEqual(warnings, [
    'Issue #4 no longer exists in the repository; skipping',
    'Issue #5 left the project; skipping',
  ]);

  await assert.rejects(
    reconcileDone({ api: dry.api, issueNumber: 0 }),
    /positive safe integer/,
  );
});

test('a single-issue Done run reads only that issue and never lists the project', async () => {
  const f = board([
    { number: 1, state: 'CLOSED', status: 'In review' },
    { number: 2, state: 'OPEN', status: 'Done' },
  ]);
  for (const [issueNumber, target] of [
    [1, 'Done'],
    [2, 'Ready'],
  ])
    assert.deepEqual(
      await reconcileDone({
        api: f.api,
        dryRun: false,
        issueNumber,
        log() {},
      }),
      { candidates: 1, updated: 1 },
      target,
    );
  assert.deepEqual(f.filters, []);
  assert.deepEqual(f.reads, ['item-1', 'item-2']);
  assert.deepEqual(
    f.mutations.map((mutation) => [mutation.item, mutation.option]),
    [
      ['item-1', 'option-Done'],
      ['item-2', 'option-Ready'],
    ],
  );
});

test('workflow requires its own project token and local defaults remain read-only', () => {
  assert.throws(
    () =>
      configuration(
        { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'repository-only' },
        [],
      ),
    /PRISMATIC_PROJECT_TOKEN is required/,
  );
  assert.deepEqual(configuration({}, []), { dryRun: true });
  assert.deepEqual(configuration({ DRY_RUN: 'false' }, ['--dry-run']), {
    dryRun: true,
  });
  assert.deepEqual(configuration({}, ['--apply']), { dryRun: false });
  assert.throws(
    () => configuration({ DRY_RUN: 'yes' }, []),
    /must be true or false/,
  );
  assert.throws(
    () => configuration({}, ['--apply', '--dry-run']),
    /Use --dry-run or --apply/,
  );
});

test('parser accepts an optional positive issue number in either flag order and preserves dry-run defaults', () => {
  assert.deepEqual(configuration({}, ['--issue', '42']), {
    dryRun: true,
    issueNumber: 42,
  });
  assert.deepEqual(configuration({}, ['--issue', '42', '--dry-run']), {
    dryRun: true,
    issueNumber: 42,
  });
  assert.deepEqual(
    configuration({ DRY_RUN: 'false' }, ['--dry-run', '--issue', '42']),
    { dryRun: true, issueNumber: 42 },
  );
  assert.deepEqual(configuration({}, ['--apply', '--issue', '42']), {
    dryRun: false,
    issueNumber: 42,
  });
  assert.deepEqual(configuration({}, ['--issue', '42', '--apply']), {
    dryRun: false,
    issueNumber: 42,
  });
  assert.deepEqual(
    configuration({}, ['--issue', String(Number.MAX_SAFE_INTEGER)]),
    { dryRun: true, issueNumber: Number.MAX_SAFE_INTEGER },
  );
});

test('parser rejects malformed, missing, unsafe, repeated, or conflicting arguments', () => {
  for (const args of [
    ['--issue'],
    ['--issue', '--apply'],
    ['--issue', '0'],
    ['--issue', '-1'],
    ['--issue', '1.5'],
    ['--issue', '1e2'],
    ['--issue', ' 1'],
    ['--issue', '01'],
    ['--issue', 'NaN'],
    ['--issue', 'Infinity'],
    ['--issue', '9007199254740992'],
    ['--issue', '1', '--issue', '2'],
    ['--unknown'],
    ['1'],
    ['--apply', '--apply'],
    ['--dry-run', '--dry-run'],
    ['--apply', '--dry-run', '--issue', '1'],
    ['--issue', '1', '2'],
  ])
    assert.throws(
      () => configuration({}, args),
      /Use --dry-run or --apply|--issue requires|Unknown option|given more than once/,
    );
});

test('invalid programmatic issue filters fail before any API access', async () => {
  for (const issueNumber of [
    0,
    -1,
    1.5,
    '1',
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      reconcile({
        api: () => {
          assert.fail('API access with invalid issue filter');
        },
        issueNumber,
      }),
      /positive safe integer/,
    );
  }
});

test('catalog has unique names and supported severities', () => {
  const catalog = JSON.parse(
    readFileSync(new URL('../.github/labels.json', import.meta.url), 'utf8'),
  );
  assert.equal(catalog.repository, REPOSITORY);
  assert.equal(
    new Set(catalog.labels.map((label) => label.name)).size,
    catalog.labels.length,
  );
  assert.deepEqual(
    catalog.labels
      .filter((label) => label.name.startsWith('severity:'))
      .map((label) => label.name)
      .sort(),
    ['critical', 'high', 'low', 'medium', 'none'].map(
      (name) => `severity: ${name}`,
    ),
  );
  for (const label of catalog.labels) {
    assert.match(label.color, /^[a-f0-9]{6}$/);
    assert.ok(label.description.length > 0);
  }
});

test('pagination continues from a nested first page', async () => {
  const cursors = [];
  assert.deepEqual(
    await paginate(
      async (cursor) => {
        cursors.push(cursor);
        return { nodes: [3], pageInfo: { hasNextPage: false } };
      },
      { nodes: [1, 2], pageInfo: { hasNextPage: true, endCursor: 'two' } },
    ),
    [1, 2, 3],
  );
  assert.deepEqual(cursors, ['two']);
  assert.deepEqual(
    await paginate(
      () => assert.fail('a complete nested page needs no request'),
      { nodes: [1], pageInfo: { hasNextPage: false } },
    ),
    [1],
  );
});

// Epics with their nested first label page. Epic #7 carries standard and type
// labels; #9 overflows its first page, and its conflicting label comes later.
function epicApi() {
  const calls = [];
  const writes = [];
  const connection = (nodes, next = false) => ({
    nodes,
    pageInfo: { hasNextPage: next, endCursor: next ? 'next' : null },
  });
  const labels = {
    E7: connection([
      { id: 'L_epic', name: 'epic' },
      { id: 'L_bug', name: 'bug' },
      { id: 'L_type', name: 'type: feature' },
      { id: 'L_severity', name: 'severity: none' },
    ]),
    E8: connection([
      { id: 'L_epic', name: 'epic' },
      { id: 'L_area', name: 'area: repository' },
    ]),
    E9: connection([{ id: 'L_epic', name: 'epic' }], true),
  };
  const epics = [
    { id: 'E7', number: 7 },
    { id: 'E8', number: 8 },
    { id: 'E9', number: 9 },
  ];
  const api = async (query, variables) => {
    calls.push(query);
    if (query.startsWith('mutation')) {
      assert.match(query, /removeLabelsFromLabelable/);
      writes.push(variables);
      return {};
    }
    if (query.includes('labels: ["epic"]'))
      return {
        repository: {
          issues: connection(
            epics.map((epic) => ({ ...epic, labels: labels[epic.id] })),
          ),
        },
      };
    if (query.includes('issue(number: $number)')) {
      const epic = epics.find((epic) => epic.number === variables.number);
      return {
        repository: {
          issue: epic
            ? { ...epic, labels: labels[epic.id] }
            : {
                id: 'I_1',
                number: 1,
                labels: connection([{ id: 'L_bug', name: 'bug' }]),
              },
        },
      };
    }
    assert.match(query, /labels\(first: 100, after: \$cursor\)/);
    assert.equal(variables.id, 'E9');
    return {
      node: {
        labels: connection([{ id: 'L_docs', name: 'documentation' }]),
      },
    };
  };
  return { api, calls, writes };
}

test('epic label reconciliation removes standard and type labels from epics only', async () => {
  const github = epicApi();
  const logs = [];
  await reconcileEpicLabels({
    api: github.api,
    dryRun: false,
    log: (line) => logs.push(line),
  });
  assert.deepEqual(github.writes, [
    { id: 'E7', labels: ['L_bug', 'L_type'] },
    { id: 'E9', labels: ['L_docs'] },
  ]);
  assert.deepEqual(logs, [
    'Removing 2 conflicting category labels from epic #7',
    'Removing 1 conflicting category labels from epic #9',
  ]);
  // One listing plus one follow-up page for the epic that overflowed.
  assert.equal(github.calls.length - github.writes.length, 2);
  const dry = epicApi();
  await reconcileEpicLabels({ api: dry.api, log: () => {} });
  assert.deepEqual(dry.writes, []);
});

test('epic label reconciliation for one issue reads only that issue', async () => {
  const github = epicApi();
  await reconcileEpicLabels({
    api: github.api,
    dryRun: false,
    issueNumber: 7,
    log: () => {},
  });
  assert.deepEqual(github.writes, [{ id: 'E7', labels: ['L_bug', 'L_type'] }]);
  assert.equal(github.calls.length, 2);
  assert.ok(!github.calls.some((query) => query.includes('labels: ["epic"]')));
  // A non-epic issue keeps its labels.
  const plain = epicApi();
  await reconcileEpicLabels({
    api: plain.api,
    dryRun: false,
    issueNumber: 1,
    log: () => {},
  });
  assert.deepEqual(plain.writes, []);
  assert.equal(plain.calls.length, 1);
});

test('epic label reconciliation skips an epic deleted after the listing', async () => {
  const github = epicApi();
  const api = async (query, variables) =>
    variables?.id === 'E9' && /node\(id: \$id\)/.test(query)
      ? { node: null }
      : github.api(query, variables);
  await reconcileEpicLabels({ api, dryRun: false, log: () => {} });
  assert.deepEqual(github.writes, [{ id: 'E7', labels: ['L_bug', 'L_type'] }]);
});

test('the sweep filter excludes exactly the statuses eligible() never moves', () => {
  assert.equal(
    SWEEP_FILTER,
    'is:issue is:open -status:Ready,"In progress","In review",Done',
  );
  const base = issue();
  const qualifies = (Status) =>
    eligible(issue({ fields: { ...base.fields, Status } }));
  for (const Status of SETTLED_STATUSES)
    assert.equal(qualifies(Status), false, Status);
  for (const Status of [undefined, 'Inbox'])
    assert.equal(qualifies(Status), true, String(Status));
});

// GitHub's answer for an issue that was deleted or transferred out of the
// repository: a null field and a NOT_FOUND error at its path.
function notFound(data, path, extra = []) {
  return ghFails(
    httpResponse(
      200,
      {},
      {
        data,
        errors: [
          {
            type: 'NOT_FOUND',
            path,
            message: 'Could not resolve to an Issue with the number of 5.',
          },
          ...extra,
        ],
      },
    ),
  );
}

test('the tracker client reads a missing issue as null and fails on every other error', () => {
  const query = 'query { repository { issue(number: 5) { id } } }';
  for (const [data, path] of [
    [{ repository: { issue: null } }, ['repository', 'issue']],
    [{ node: null }, ['node']],
    [{ node: { content: null } }, ['node', 'content']],
  ])
    assert.deepEqual(trackerGraphql(query, {}, notFound(data, path)), data);
  for (const [data, path, extra, kind] of [
    [{ repository: null }, ['repository'], [], 'not-found'],
    [{ user: { projectV2: null } }, ['user', 'projectV2'], [], 'not-found'],
    [
      { repository: { issue: { id: 'I' } } },
      ['repository', 'issue'],
      [],
      'not-found',
    ],
    [{ repository: { issue: null } }, undefined, [], 'not-found'],
    [
      { repository: { issue: null } },
      ['repository', 'issue'],
      [{ type: 'FORBIDDEN', message: 'Resource not accessible' }],
      'access',
    ],
  ])
    assert.throws(
      () => trackerGraphql(query, {}, notFound(data, path, extra)),
      {
        name: 'GitHubError',
        kind,
      },
    );
  assert.throws(
    () =>
      trackerGraphql(
        query,
        {},
        ghFails(
          httpResponse(200, exhausted, {
            data: { repository: { issue: null } },
            errors: [{ type: 'RATE_LIMITED', message: 'API rate limit' }],
          }),
        ),
      ),
    { kind: 'rate-limit' },
  );
});

test('a single-issue run for a missing issue stops with MissingIssueError', async () => {
  const { api, state } = mockApi();
  await assert.rejects(
    reconcile({ api, issueNumber: 404, dryRun: false, log: () => {} }),
    (error) =>
      error instanceof MissingIssueError &&
      error.message ===
        'Issue #404 no longer exists in the repository; skipping',
  );
  assert.deepEqual(state.mutations, []);
  const epics = epicApi();
  await assert.rejects(
    reconcileEpicLabels({
      api: async () => ({ repository: { issue: null } }),
      dryRun: false,
      issueNumber: 404,
      log: () => {},
    }),
    MissingIssueError,
  );
  assert.deepEqual(epics.writes, []);
});

test('a sweep skips deleted and transferred issues with a warning and moves the rest', async () => {
  for (const [change, warning] of [
    [
      (state) => (state.deleted = ['item']),
      'Issue #1 left the project; skipping',
    ],
    [
      (state) => (state.transferred = ['item']),
      'Issue #1 no longer exists in the repository; skipping',
    ],
  ]) {
    const { api, state } = mockApi({ additionalIssue: true });
    // The listing still shows issue #1; it changes before the re-read.
    const warnings = [];
    const wrapped = async (query, variables) => {
      if (query.includes('... on ProjectV2Item {') && variables.id === 'item')
        change(state);
      return api(query, variables);
    };
    assert.deepEqual(
      await reconcile({
        api: wrapped,
        dryRun: false,
        log: () => {},
        warn: (line) => warnings.push(line),
      }),
      { candidates: 1, updated: 1 },
    );
    assert.deepEqual(warnings, [warning]);
    assert.deepEqual(
      state.mutations.map((mutation) => mutation.item),
      ['item-2'],
    );
  }
  const warnings = [];
  const { api, state } = mockApi();
  await reconcile({
    api: async (query, variables) => {
      const data = await api(query, variables);
      if (query.includes('items(first: 100') && variables.cursor)
        data.node.items.nodes.unshift({
          id: 'gone',
          type: 'ISSUE',
          content: null,
        });
      return data;
    },
    dryRun: false,
    log: () => {},
    warn: (line) => warnings.push(line),
  });
  assert.deepEqual(warnings, [
    'Project item gone has no readable issue; skipping',
  ]);
  assert.deepEqual(state.mutations.length, 1);
});

test('the tracker warns and succeeds when its issue no longer exists', async () => {
  for (const sweep of [false, true]) {
    const result = await tracker(
      [budget(4000), budget(4000)],
      async () => {
        throw new MissingIssueError(5);
      },
      sweep,
    );
    assert.equal(result.status, 0);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, [
      'Issue #5 no longer exists in the repository; skipping',
    ]);
  }
});

test('tracker entry points skip a missing issue and still fail on other not-found errors', (t) => {
  const run = fakeGh(t);
  for (const script of ['issue-triage.mjs', 'issue-containers.mjs']) {
    writeFileSync(
      join(run.directory, 'graphql.txt'),
      httpResponse(
        200,
        {},
        {
          data: { repository: { issue: null } },
          errors: [
            {
              type: 'NOT_FOUND',
              path: ['repository', 'issue'],
              message: 'Could not resolve to an Issue with the number of 5.',
            },
          ],
        },
      ),
    );
    const missing = run(script, ['--apply', '--issue', '5']);
    assert.equal(missing.status, 0, `${script}: ${missing.stderr}`);
    assert.equal(missing.stderr, '', script);
    assert.ok(
      missing.stdout.includes(
        '::warning::Issue #5 no longer exists in the repository; skipping\n',
      ),
      `${script}: ${missing.stdout}`,
    );
    writeFileSync(
      join(run.directory, 'graphql.txt'),
      httpResponse(
        200,
        {},
        {
          data: { repository: null },
          errors: [
            {
              type: 'NOT_FOUND',
              path: ['repository'],
              message: 'Could not resolve to a Repository.',
            },
          ],
        },
      ),
    );
    const failed = run(script, ['--apply', '--issue', '5']);
    assert.equal(failed.status, 1, script);
    assert.equal(
      failed.stderr,
      'GitHub GraphQL request failed: NOT_FOUND: Could not resolve to a Repository.\n',
      script,
    );
  }
});
