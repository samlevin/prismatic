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
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { GitHubApiError, ghGraphql } from './github-api.mjs';
import {
  configuration,
  discover,
  eligible,
  graphqlBudget,
  listItems,
  MIN_REMAINING,
  SWEEP_FILTERS,
  nestedNodes,
  paginate,
  readItem,
  reconcile,
  reconcileDone,
  reconcileEpicLabels,
  REPOSITORY,
  run,
  withinBudget,
} from './issue-triage.mjs';

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
    ...['Ready', 'In progress', 'In review', 'Done', undefined].map(
      (Status) => ({ fields: { ...base.fields, Status } }),
    ),
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

const FIELD_OPTIONS = {
  Status: ['Inbox', 'Ready', 'In progress', 'In review', 'Done'],
  Priority: ['P0', 'P1', 'P2', 'P3'],
  Size: ['XS', 'S', 'M', 'L'],
};

// An eligible issue for the fake board.
function triaged(number, overrides = {}) {
  return {
    number,
    status: 'Inbox',
    priority: 'P2',
    size: 'M',
    labels: ['severity: none'],
    ...overrides,
  };
}

// Applies the subset of GitHub's project item filter syntax the sweeps use:
// is:issue, is:open, is:closed, and status: with or without a leading `-`.
function matches(entry, filter) {
  return filter.split(' ').every((term) => {
    if (term === 'is:issue') return entry.type === 'ISSUE';
    if (term === 'is:open') return entry.state === 'OPEN';
    if (term === 'is:closed') return entry.state === 'CLOSED';
    const status = /^(-?)status:(.+)$/.exec(term);
    if (!status) throw new Error(`Unexpected filter term: ${term}`);
    const listed = status[2].split(',').includes(entry.status);
    return status[1] ? !listed : listed;
  });
}

// A fake GitHub holding the Prismatic delivery project. Each entry is one
// project item: an issue number with its state, labels, and Status, Priority,
// and Size. `page` caps every connection page, so a test can force nested
// pages. `onRead` runs before each write-boundary re-read and may change the
// entry.
function board(entries, { page = 100, definitionPages = 1, onRead } = {}) {
  const items = new Map(
    entries.map((entry) => [
      `item-${entry.number}`,
      {
        type: 'ISSUE',
        repository: REPOSITORY,
        state: 'OPEN',
        labels: [],
        project: 'project',
        issueId: `issue-${entry.number}`,
        ...entry,
      },
    ]),
  );
  const definitions = Object.entries(FIELD_OPTIONS).map(([name, options]) => ({
    id: `field-${name}`,
    name,
    options: options.map((option) => ({
      id: `option-${option}`,
      name: option,
    })),
  }));
  const calls = [];
  const reads = [];
  const mutations = [];
  const removed = [];
  const slice = (nodes, cursor, size = page) => {
    const start = cursor ? Number(cursor.slice('at-'.length)) : 0;
    const end = start + size;
    return {
      nodes: nodes.slice(start, end),
      pageInfo: { hasNextPage: end < nodes.length, endCursor: `at-${end}` },
    };
  };
  const byIssue = (id) =>
    [...items.values()].find((entry) => entry.issueId === id);
  const labels = (entry) =>
    entry.labels.map((name) => ({ id: `label-${name}`, name }));
  const values = (entry) =>
    ['Status', 'Priority', 'Size']
      .filter((name) => entry[name.toLowerCase()])
      .map((name) => ({
        optionId: `option-${entry[name.toLowerCase()]}`,
        field: { id: `field-${name}` },
      }));
  const content = (entry) =>
    entry.type === 'DRAFT_ISSUE'
      ? null
      : {
          __typename: entry.type === 'PULL_REQUEST' ? 'PullRequest' : 'Issue',
          id: entry.issueId,
          number: entry.number,
          state: entry.state,
          repository: { nameWithOwner: entry.repository },
          labels: slice(labels(entry), null),
        };
  const node = (id) => {
    const entry = items.get(id);
    return {
      id,
      type: entry.type,
      project: { id: entry.project },
      fieldValues: slice(values(entry), null),
      content: content(entry),
    };
  };
  const api = async (query, variables) => {
    calls.push(query);
    if (query.includes('projectV2(number: 2)'))
      return {
        user: {
          projectV2: {
            id: 'project',
            fields: slice(
              definitions,
              variables.cursor,
              Math.ceil(definitions.length / definitionPages),
            ),
          },
        },
      };
    if (query.includes('updateProjectV2ItemFieldValue')) {
      mutations.push(variables);
      items.get(variables.item).status = variables.option.slice(
        'option-'.length,
      );
      return {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: variables.item },
        },
      };
    }
    if (query.includes('removeLabelsFromLabelable')) {
      removed.push(variables);
      const entry = byIssue(variables.id);
      entry.labels = entry.labels.filter(
        (name) => !variables.labels.includes(`label-${name}`),
      );
      return { removeLabelsFromLabelable: { clientMutationId: null } };
    }
    if (query.includes('labels: ["epic"]'))
      return {
        repository: {
          issues: slice(
            [...items.values()]
              .filter((entry) => entry.labels.includes('epic'))
              .map((entry) => ({
                id: entry.issueId,
                number: entry.number,
                labels: slice(labels(entry), null),
              })),
            variables.cursor,
          ),
        },
      };
    if (query.includes('issue(number: $number)')) {
      const entry = [...items.values()].find(
        (entry) => entry.number === variables.number && entry.type === 'ISSUE',
      );
      if (!entry) return { repository: { issue: null } };
      const issue = {
        id: entry.issueId,
        number: entry.number,
        state: entry.state,
        repository: { nameWithOwner: entry.repository },
        labels: slice(labels(entry), null),
      };
      if (query.includes('projectItems'))
        issue.projectItems = slice([node(`item-${entry.number}`)], null);
      return { repository: { issue } };
    }
    if (query.includes('projectItems(first: 100')) {
      const entry = byIssue(variables.id);
      return {
        node: {
          projectItems: slice([node(`item-${entry.number}`)], variables.cursor),
        },
      };
    }
    if (query.includes('items(first: 100'))
      return {
        node: {
          items: slice(
            [...items.keys()]
              .filter((id) => matches(items.get(id), variables.filter))
              .map(node),
            variables.cursor,
          ),
        },
      };
    if (query.includes('... on ProjectV2Item {')) {
      const entry = items.get(variables.id);
      if (!query.includes('content {'))
        return {
          node: { fieldValues: slice(values(entry), variables.cursor) },
        };
      if (!variables.cursor) {
        reads.push(variables.id);
        onRead?.(entry, variables.id);
      }
      return {
        node: {
          ...node(variables.id),
          fieldValues: slice(values(entry), variables.cursor),
        },
      };
    }
    if (
      query.includes('... on Issue {') &&
      query.includes('labels(first: 100')
    ) {
      const entry = byIssue(variables.id);
      return {
        node: {
          ...content(entry),
          labels: slice(labels(entry), variables.cursor),
        },
      };
    }
    throw new Error(`Unexpected mock query: ${query}`);
  };
  const count = (text) => calls.filter((query) => query.includes(text)).length;
  return { api, items, definitions, calls, reads, mutations, removed, count };
}

test('nested connections continue after the cursor of the inline page', async () => {
  const { api, calls } = board([
    triaged(1, { labels: ['severity: none', 'severity: high', 'area: x'] }),
  ]);
  const nodes = await nestedNodes(api, {
    id: 'issue-1',
    type: 'Issue',
    field: 'labels',
    selection: 'id name',
    connection: {
      nodes: [{ id: 'label-severity: none', name: 'severity: none' }],
      pageInfo: { hasNextPage: true, endCursor: 'at-1' },
    },
  });
  assert.deepEqual(
    nodes.map((label) => label.name),
    ['severity: none', 'severity: high', 'area: x'],
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(
    await nestedNodes(api, {
      id: 'issue-1',
      type: 'Issue',
      field: 'labels',
      selection: 'id name',
      connection: {
        nodes: [{ name: 'only' }],
        pageInfo: { hasNextPage: false },
      },
    }),
    [{ name: 'only' }],
  );
  assert.equal(calls.length, 1);
});

test('a sweep lists only the items a pass can act on, with their field values and labels', async () => {
  const settled = Array.from({ length: 141 }, (_, index) =>
    triaged(index + 1, {
      status: ['Ready', 'In progress', 'In review'][index % 3],
    }),
  );
  const f = board([
    ...settled,
    { number: 200, state: 'CLOSED', status: 'Done' },
    triaged(201),
  ]);
  await run({ api: f.api, dryRun: false, log() {} });
  assert.equal(f.count('projectV2(number: 2)'), 1);
  assert.equal(f.count('items(first: 100'), SWEEP_FILTERS.length);
  // Only #201 is listed; its write-boundary re-read is the one extra query.
  assert.deepEqual(f.reads, ['item-201']);
  assert.equal(f.count('labels: ["epic"]'), 1);
  // Discovery, two listings, the epic labels, the re-read, and the move.
  assert.equal(f.calls.length, 6);
  assert.equal(f.mutations.length, 1);
});

test('listing follows nested field value and label pages only when they have more', async () => {
  const f = board(
    [triaged(1, { labels: ['severity: none', 'severity: high'] })],
    { page: 1, definitionPages: 3 },
  );
  const context = await discover(f.api);
  assert.equal(context.fields.Size.id, 'field-Size');
  assert.equal(f.count('projectV2(number: 2)'), 3);
  const [item] = await listItems(f.api, context);
  assert.deepEqual(item.fields, { Status: 'Inbox', Priority: 'P2', Size: 'M' });
  assert.deepEqual(item.labels, ['severity: none', 'severity: high']);
  assert.equal(eligible(item), false);
  assert.equal(
    f.calls.filter(
      (query) =>
        query.includes('... on ProjectV2Item {') && !query.includes('content'),
    ).length,
    2,
  );
  assert.equal(f.count('labels(first: 100'), 1);
});

test('dry-run lists every item page and never mutates; apply is idempotent', async () => {
  const f = board(
    [
      { number: 10, type: 'PULL_REQUEST' },
      { number: 11, type: 'DRAFT_ISSUE' },
      triaged(12, { repository: 'other/repo' }),
      triaged(1),
    ],
    { page: 2 },
  );
  assert.deepEqual(await reconcile({ api: f.api, log: () => {} }), {
    candidates: 1,
    updated: 0,
  });
  assert.equal(f.mutations.length, 0);
  assert.equal(f.count('items(first: 100'), 2);
  // Only an eligible item costs a re-read.
  assert.deepEqual(f.reads, ['item-1']);
  assert.deepEqual(
    await reconcile({ api: f.api, dryRun: false, log: () => {} }),
    { candidates: 1, updated: 1 },
  );
  assert.deepEqual(f.mutations, [
    {
      project: 'project',
      item: 'item-1',
      field: 'field-Status',
      option: 'option-Ready',
    },
  ]);
  assert.deepEqual(
    await reconcile({ api: f.api, dryRun: false, log: () => {} }),
    { candidates: 0, updated: 0 },
  );
  assert.equal(f.mutations.length, 1);
});

test('re-read rejects eligibility changes at the mutation boundary', async () => {
  for (const race of [
    (entry) => {
      entry.status = 'In progress';
    },
    (entry) => {
      entry.priority = 'invalid';
    },
    (entry) => {
      entry.size = undefined;
    },
    (entry) => {
      entry.labels = [...entry.labels, 'severity: high'];
    },
    (entry) => {
      entry.state = 'CLOSED';
    },
    (entry) => {
      entry.repository = 'other/repo';
    },
    (entry) => {
      entry.project = 'other-project';
    },
  ]) {
    const f = board([triaged(1)], { onRead: race });
    assert.deepEqual(
      await reconcile({ api: f.api, dryRun: false, log: () => {} }),
      { candidates: 0, updated: 0 },
    );
    assert.deepEqual(f.reads, ['item-1']);
    assert.equal(f.mutations.length, 0);
  }
});

test('an issue run reads only that issue and leaves another eligible issue untouched', async () => {
  const filler = Array.from({ length: 250 }, (_, index) =>
    triaged(index + 100, { status: 'Ready' }),
  );
  for (const issueNumber of [1, 2]) {
    const f = board([triaged(1), triaged(2), ...filler]);
    const logs = [];
    assert.deepEqual(
      await reconcile({
        api: f.api,
        issueNumber,
        log: (line) => logs.push(line),
      }),
      { candidates: 1, updated: 0 },
    );
    assert.equal(f.mutations.length, 0);
    assert.match(logs[0], new RegExp(`issue #${issueNumber} Inbox -> Ready`));
    const selected = `item-${issueNumber}`;
    assert.deepEqual(f.reads, [selected]);
    assert.equal(f.count('items(first: 100'), 0);
    assert.deepEqual(
      await reconcile({
        api: f.api,
        issueNumber,
        dryRun: false,
        log: () => {},
      }),
      { candidates: 1, updated: 1 },
    );
    assert.deepEqual(
      f.mutations.map((mutation) => mutation.item),
      [selected],
    );
    assert.equal(f.items.get(`item-${3 - issueNumber}`).status, 'Inbox');
    assert.deepEqual(
      await reconcile({
        api: f.api,
        issueNumber,
        dryRun: false,
        log: () => {},
      }),
      { candidates: 0, updated: 0 },
    );
    assert.ok(f.reads.every((id) => id === selected));
    assert.equal(f.count('items(first: 100'), 0);
    // A sweep still processes the remaining eligible issue.
    assert.deepEqual(
      await reconcile({ api: f.api, dryRun: false, log: () => {} }),
      { candidates: 1, updated: 1 },
    );
    assert.equal(f.items.get('item-1').status, 'Ready');
    assert.equal(f.items.get('item-2').status, 'Ready');
  }
});

test('an issue run costs the same few queries whatever the project size', async () => {
  for (const size of [0, 250]) {
    const f = board([
      triaged(1),
      ...Array.from({ length: size }, (_, index) =>
        triaged(index + 100, { status: 'Ready' }),
      ),
    ]);
    await run({ api: f.api, issueNumber: 1, dryRun: false, log() {} });
    // Discovery, the issue with its item, the re-read, the move.
    assert.equal(f.calls.length, 4, `project of ${size + 1}`);
    assert.equal(f.count('items(first: 100'), 0);
    assert.equal(f.count('labels: ["epic"]'), 0);
    assert.equal(f.items.get('item-1').status, 'Ready');
  }
});

test('an issue run for a missing issue or one off the project reads nothing more and writes nothing', async () => {
  const f = board([triaged(1), triaged(4, { project: 'other-project' })]);
  const warnings = [];
  await run({
    api: f.api,
    issueNumber: 3,
    dryRun: false,
    log() {},
    warn: (line) => warnings.push(line),
  });
  assert.deepEqual(warnings, [
    'Issue #3 was not found; it may have been deleted or transferred. Nothing to triage.',
  ]);
  await run({ api: f.api, issueNumber: 4, dryRun: false, log() {} });
  assert.deepEqual(
    await reconcile({ api: f.api, issueNumber: 3, dryRun: false, log() {} }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.mutations, []);
  assert.equal(f.count('items(first: 100'), 0);
});

// GitHub's answer for a deleted or transferred issue, through ghGraphql.
function notFound(path) {
  return (query, variables, options) =>
    ghGraphql(query, variables, {
      ...options,
      run: () =>
        `HTTP/2.0 200 OK\n\r\n${JSON.stringify({
          data: { repository: { issue: null } },
          errors: [
            {
              type: 'NOT_FOUND',
              path,
              message: 'Could not resolve to an Issue with the number of 3.',
            },
          ],
        })}`,
    });
}

test('an issue run for a deleted or transferred issue warns, writes nothing, and succeeds', async () => {
  const f = board([triaged(1)]);
  const issueQuery = (path) => (query, variables, options) =>
    query.includes('issue(number: $number)')
      ? notFound(path)(query, variables, options)
      : f.api(query, variables);
  const warnings = [];
  await run({
    api: issueQuery(['repository', 'issue']),
    issueNumber: 3,
    dryRun: false,
    log() {},
    warn: (line) => warnings.push(line),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Issue #3 was not found/);
  assert.deepEqual(f.mutations, []);
  assert.deepEqual(
    await reconcileEpicLabels({
      api: issueQuery(['repository', 'issue']),
      issueNumber: 3,
      dryRun: false,
      log: assert.fail,
    }),
    undefined,
  );
  // A NOT_FOUND for anything else still fails the run.
  await assert.rejects(
    run({
      api: issueQuery(['repository', 'issue', 'labels']),
      issueNumber: 3,
      log() {},
      warn: assert.fail,
    }),
    /NOT_FOUND/,
  );
});

test('a write-boundary re-read of an item whose issue is gone reads as null', async () => {
  const gone = (data, path) => (query, variables, options) =>
    ghGraphql(query, variables, {
      ...options,
      run: () =>
        `HTTP/2.0 200 OK\n\r\n${JSON.stringify({
          data,
          errors: [{ type: 'NOT_FOUND', path, message: 'Not found.' }],
        })}`,
    });
  const context = { projectId: 'project', fields: {} };
  assert.equal(
    await readItem(gone({ node: null }, ['node']), 'item', context),
    null,
  );
  await assert.rejects(
    readItem(
      gone({ node: { id: 'item' } }, ['node', 'project']),
      'item',
      context,
    ),
    /NOT_FOUND/,
  );
});

test('issue filter is rechecked against fresh issue metadata before mutation', async () => {
  const f = board([triaged(1)], {
    onRead: (entry) => {
      entry.number = 2;
    },
  });
  assert.deepEqual(
    await reconcile({ api: f.api, issueNumber: 1, dryRun: false, log() {} }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(f.mutations, []);
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
  const { api, definitions } = board([]);
  definitions[0].options = definitions[0].options.filter(
    (option) => option.name !== 'Ready',
  );
  await assert.rejects(discover(api), /Status option Ready/);
  definitions[1].name = 'Status';
  await assert.rejects(discover(api), /Expected one Status/);
});

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
  const again = await reconcileDone({ api: f.api, dryRun: false, log() {} });
  assert.deepEqual(again, { candidates: 0, updated: 0 });
});

test('Done reconciliation dry-runs, honors the issue filter, and re-reads before writing', async () => {
  const dry = board([{ number: 1, state: 'CLOSED', status: 'In review' }]);
  const lines = [];
  assert.deepEqual(
    await reconcileDone({ api: dry.api, log: (line) => lines.push(line) }),
    { candidates: 1, updated: 0 },
  );
  assert.deepEqual(dry.mutations, []);
  assert.equal(
    lines[0],
    'DRY_RUN would move closed issue #1 In review -> Done',
  );

  const filtered = board([
    { number: 1, state: 'CLOSED', status: 'In review' },
    { number: 2, state: 'CLOSED', status: 'In review' },
  ]);
  await reconcileDone({
    api: filtered.api,
    dryRun: false,
    issueNumber: 2,
    log() {},
  });
  assert.deepEqual(filtered.reads, ['item-2']);
  assert.equal(filtered.count('items(first: 100'), 0);
  assert.deepEqual(
    filtered.mutations.map((m) => m.item),
    ['item-2'],
  );

  const changes = {
    'item-1': { state: 'OPEN' },
    'item-2': { status: 'Done' },
    'item-3': { state: 'CLOSED' },
  };
  const raced = board(
    [
      { number: 1, state: 'CLOSED', status: 'In review' },
      { number: 2, state: 'CLOSED', status: 'In review' },
      { number: 3, state: 'OPEN', status: 'Done' },
    ],
    { onRead: (entry, id) => Object.assign(entry, changes[id]) },
  );
  assert.deepEqual(
    await reconcileDone({ api: raced.api, dryRun: false, log() {} }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(raced.mutations, []);

  await assert.rejects(
    reconcileDone({ api: dry.api, issueNumber: 0 }),
    /positive safe integer/,
  );
});

test('the command-line run shares one discovery and one listing per filter across every pass', async () => {
  const f = board([
    { number: 1, state: 'CLOSED', status: 'In review' },
    triaged(2),
  ]);
  const lines = [];
  await run({ api: f.api, dryRun: false, log: (line) => lines.push(line) });
  assert.equal(f.count('projectV2(number: 2)'), 1);
  assert.equal(f.count('items(first: 100'), SWEEP_FILTERS.length);
  assert.deepEqual(
    f.mutations.map((m) => [m.item, m.option]),
    [
      ['item-2', 'option-Ready'],
      ['item-1', 'option-Done'],
    ],
  );
  assert.equal(
    lines.at(-1),
    'Done reconciliation: 1 eligible, 1 updated; DRY_RUN=false',
  );
});

test('an issue run moves its closed issue to Done without listing the project', async () => {
  const f = board([
    { number: 1, state: 'CLOSED', status: 'In review' },
    { number: 2, state: 'CLOSED', status: 'In review' },
  ]);
  await run({ api: f.api, issueNumber: 1, dryRun: false, log() {} });
  assert.equal(f.count('items(first: 100'), 0);
  assert.deepEqual(
    f.mutations.map((m) => [m.item, m.option]),
    [['item-1', 'option-Done']],
  );
});

test('epic label reconciliation removes conflicting category labels in a sweep and an issue run', async () => {
  const entries = () => [
    triaged(5, {
      status: 'Ready',
      labels: ['epic', 'bug', 'type: feature', 'area: tracker'],
    }),
    triaged(6, { status: 'Ready', labels: ['bug', 'type: feature'] }),
  ];
  const dry = board(entries());
  const lines = [];
  await reconcileEpicLabels({ api: dry.api, log: (line) => lines.push(line) });
  assert.deepEqual(dry.removed, []);
  assert.deepEqual(lines, [
    'DRY_RUN would remove 2 conflicting category labels from epic #5',
  ]);

  const sweep = board(entries());
  await run({ api: sweep.api, dryRun: false, log() {} });
  assert.deepEqual(sweep.removed, [
    { id: 'issue-5', labels: ['label-bug', 'label-type: feature'] },
  ]);
  assert.deepEqual(sweep.items.get('item-6').labels, ['bug', 'type: feature']);

  const event = board(entries());
  await run({ api: event.api, issueNumber: 5, dryRun: false, log() {} });
  assert.equal(event.count('labels: ["epic"]'), 0);
  assert.deepEqual(event.removed, sweep.removed);
  await run({ api: event.api, issueNumber: 6, dryRun: false, log() {} });
  assert.equal(event.removed.length, 1);

  const direct = board(entries());
  await reconcileEpicLabels({
    api: direct.api,
    issueNumber: 5,
    dryRun: false,
    log() {},
  });
  assert.equal(direct.count('labels: ["epic"]'), 0);
  assert.deepEqual(direct.removed, sweep.removed);
});

function rateLimitError() {
  return new GitHubApiError(
    'GitHub GraphQL request failed: RATE_LIMIT: API rate limit already exceeded for user ID 1. GitHub rate limit reached; it resets at 2026-10-16T05:00:00Z.',
    { kind: 'rate_limit' },
  );
}

// A stand-in for graphqlBudget that returns `readings` in order.
function budgets(...readings) {
  return () => {
    const reading = readings.shift();
    if (reading instanceof Error) throw reading;
    return { limit: 5000, used: 5000 - reading.remaining, ...reading };
  };
}

test('graphqlBudget reads the GraphQL budget from the REST rate_limit endpoint', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return `HTTP/2.0 200 OK\n\r\n${JSON.stringify({
      resources: {
        core: { limit: 5000, remaining: 1, used: 4999, reset: 1 },
        graphql: {
          limit: 5000,
          remaining: 4000,
          used: 1000,
          reset: 1792126800,
        },
      },
    })}`;
  };
  assert.deepEqual(graphqlBudget(run), {
    limit: 5000,
    remaining: 4000,
    used: 1000,
    resetAt: '2026-10-16T05:00:00Z',
  });
  assert.deepEqual(calls, [['gh', 'api', '--include', 'rate_limit']]);
  assert.throws(
    () => graphqlBudget(() => 'HTTP/2.0 200 OK\n\r\n{"resources":{}}'),
    /no GraphQL rate limit/,
  );
});

test('a sweep logs the GraphQL points before and after, and skips under the minimum', async () => {
  const logs = [];
  let runs = 0;
  const work = async () => {
    runs++;
  };
  assert.equal(
    await withinBudget(work, {
      budget: budgets(
        { remaining: 4000, resetAt: 'r' },
        { remaining: 3990, resetAt: 'r' },
      ),
      name: 'Triage',
      log: (line) => logs.push(line),
      warn: assert.fail,
    }),
    'done',
  );
  assert.equal(runs, 1);
  assert.deepEqual(logs, [
    'Triage sweep GraphQL points: 4000 remaining before, 3990 after, 10 used, counting other clients of the token',
  ]);

  logs.length = 0;
  await withinBudget(work, {
    budget: budgets(
      { remaining: 1200, resetAt: 'r1' },
      { remaining: 4990, resetAt: 'r2' },
    ),
    name: 'Container',
    log: (line) => logs.push(line),
  });
  assert.deepEqual(logs, [
    'Container sweep GraphQL points: 1200 remaining before, 4990 after the budget reset at r1',
  ]);

  const warnings = [];
  assert.equal(
    await withinBudget(work, {
      budget: budgets({ remaining: MIN_REMAINING - 1, resetAt: 'r' }),
      name: 'Triage',
      log: assert.fail,
      warn: (line) => warnings.push(line),
    }),
    'skipped',
  );
  assert.equal(runs, 2);
  assert.deepEqual(warnings, [
    'Triage sweep skipped: 999 GraphQL points remain, under 1000. The budget resets at r.',
  ]);
});

test('an issue run logs its GraphQL points too', async () => {
  const logs = [];
  await withinBudget(async () => {}, {
    budget: budgets(
      { remaining: 4000, resetAt: 'r' },
      { remaining: 3997, resetAt: 'r' },
    ),
    issueNumber: 7,
    name: 'Triage',
    log: (line) => logs.push(line),
    warn: assert.fail,
  });
  assert.deepEqual(logs, [
    'Triage issue #7 GraphQL points: 4000 remaining before, 3997 after, 3 used, counting other clients of the token',
  ]);
});

test('a budget that cannot be read warns and the run goes ahead', async () => {
  const warnings = [];
  let runs = 0;
  assert.equal(
    await withinBudget(
      async () => {
        runs++;
      },
      {
        budget: budgets(new Error('down'), { remaining: 10, resetAt: 'r' }),
        name: 'Triage',
        log: assert.fail,
        warn: (line) => warnings.push(line),
      },
    ),
    'done',
  );
  assert.equal(runs, 1);
  assert.deepEqual(warnings, [
    'Triage could not read the GraphQL budget: down',
  ]);
});

test('a sweep fails on any error, including the rate limit', async () => {
  for (const error of [rateLimitError(), new Error('boom')]) {
    await assert.rejects(
      withinBudget(
        async () => {
          throw error;
        },
        {
          budget: budgets({ remaining: 5000, resetAt: 'r' }),
          name: 'Triage',
          log() {},
          warn: assert.fail,
        },
      ),
      error,
    );
  }
});

test('an issue run warns and succeeds on the rate limit and fails on other errors', async () => {
  const budget = () => ({
    limit: 5000,
    remaining: 0,
    used: 5000,
    resetAt: 'r',
  });
  const warnings = [];
  assert.equal(
    await withinBudget(
      async () => {
        throw rateLimitError();
      },
      {
        budget,
        issueNumber: 7,
        name: 'Triage',
        log() {},
        warn: (line) => warnings.push(line),
      },
    ),
    'rate-limited',
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Triage skipped issue #7: GitHub GraphQL/);
  assert.match(warnings[0], /The next scheduled sweep reconciles it\.$/);
  for (const error of [
    new GitHubApiError('denied', { kind: 'auth' }),
    new Error('boom'),
  ])
    await assert.rejects(
      withinBudget(
        async () => {
          throw error;
        },
        { budget, issueNumber: 7, name: 'Triage', warn: assert.fail },
      ),
      error,
    );
  assert.equal(
    await withinBudget(async () => {}, {
      budget,
      issueNumber: 7,
      name: 'Triage',
      log() {},
    }),
    'done',
  );
});

test('both scripts exit 0 with a warning when an issue run hits the rate limit, and 1 for a sweep', (t) => {
  if (process.platform === 'win32')
    return t.skip('the fake gh is a shell script');
  const directory = mkdtempSync(join(tmpdir(), 'issue-triage-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const response = join(directory, 'response.txt');
  writeFileSync(
    response,
    `HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 0\r\n\r\n${JSON.stringify({
      errors: [
        { type: 'RATE_LIMIT', message: 'API rate limit already exceeded.' },
      ],
    })}`,
  );
  const gh = join(directory, 'gh');
  writeFileSync(
    gh,
    '#!/bin/sh\ncat > /dev/null\ncat "$FAKE_GH_RESPONSE"\nexit 1\n',
  );
  chmodSync(gh, 0o755);
  for (const name of ['issue-triage.mjs', 'issue-containers.mjs']) {
    const script = fileURLToPath(new URL(`./${name}`, import.meta.url));
    const env = {
      PATH: `${directory}:${process.env.PATH}`,
      GH_TOKEN: 'token',
      FAKE_GH_RESPONSE: response,
    };
    const event = spawnSync(process.execPath, [script, '--issue', '7'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(event.status, 0, `${name}: ${event.stderr}`);
    assert.match(event.stdout, /^::warning::\S+ skipped issue #7: /m, name);
    assert.equal(event.stderr, '', name);
    const sweep = spawnSync(process.execPath, [script], {
      env,
      encoding: 'utf8',
    });
    assert.equal(sweep.status, 1, name);
    assert.match(sweep.stderr, /RATE_LIMIT/, name);
  }
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
    ['--issue=1'],
    ['--unknown'],
    ['1'],
    ['--apply', '--apply'],
    ['--dry-run', '--dry-run'],
    ['--apply', '--dry-run', '--issue', '1'],
    ['--issue', '1', '2'],
  ])
    assert.throws(
      () => configuration({}, args),
      /Use --dry-run or --apply|--issue requires/,
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

test('catalog has unique names, supported severities, and all directly affected workspace labels', () => {
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

test('label descriptions do not name OpenTofu or Terraform', () => {
  const { labels } = JSON.parse(
    readFileSync(new URL('../.github/labels.json', import.meta.url), 'utf8'),
  );
  for (const label of labels)
    assert.doesNotMatch(label.description, /OpenTofu|Terraform/, label.name);
});
