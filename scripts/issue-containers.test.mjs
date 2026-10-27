import assert from 'node:assert/strict';
import test from 'node:test';
import { ghGraphql } from './github-api.mjs';
import { reconcileContainers } from './issue-containers.mjs';
import { REPOSITORY } from './issue-triage.mjs';

const MARKER = 'automation: container-closed';

// A fake repository. Each entry is an issue with its number, state, parent
// number, labels, and project Status; sub-issues are the entries that name it
// as their parent. `page` caps every connection page, so a test can force
// nested pages. `writes` records every mutation in order.
function repository(entries, { page = 100, marker = true, onSnapshot } = {}) {
  const issues = new Map(
    entries.map((entry) => [
      entry.number,
      {
        state: 'OPEN',
        labels: [],
        status: 'Ready',
        onProject: true,
        repository: REPOSITORY,
        ...entry,
      },
    ]),
  );
  const calls = [];
  const writes = [];
  const id = (number) => `issue-${number}`;
  const number = (value) => Number(value.slice('issue-'.length));
  const slice = (nodes, cursor) => {
    const start = cursor ? Number(cursor.slice('at-'.length)) : 0;
    const end = start + page;
    return {
      nodes: nodes.slice(start, end),
      pageInfo: { hasNextPage: end < nodes.length, endCursor: `at-${end}` },
    };
  };
  const children = (parent) =>
    [...issues.values()].filter((entry) => entry.parent === parent);
  const child = (entry) => ({
    id: id(entry.number),
    repository: { nameWithOwner: entry.repository },
    subIssuesSummary: { total: children(entry.number).length },
  });
  const projectItems = (entry) =>
    entry.onProject
      ? [
          {
            id: `item-${entry.number}`,
            project: { id: 'project' },
            fieldValueByName: entry.status ? { name: entry.status } : null,
          },
        ]
      : [];
  const node = (entry) =>
    entry && {
      id: id(entry.number),
      number: entry.number,
      state: entry.state,
      repository: { nameWithOwner: entry.repository },
      parent: entry.parent
        ? {
            id: id(entry.parent),
            repository: {
              nameWithOwner: issues.get(entry.parent)?.repository ?? REPOSITORY,
            },
          }
        : null,
      subIssuesSummary: {
        total: children(entry.number).length,
        completed: children(entry.number).filter(
          (child) => child.state === 'CLOSED',
        ).length,
      },
      subIssues: slice(children(entry.number).map(child), null),
      labels: slice(
        entry.labels.map((name) => ({ name })),
        null,
      ),
      projectItems: slice(projectItems(entry), null),
    };
  const label = marker ? { id: 'label-marker' } : null;
  const own = () =>
    [...issues.values()].filter((entry) => entry.repository === REPOSITORY);
  const api = async (query, variables, options) => {
    calls.push(query);
    const entry = variables.id ? issues.get(number(variables.id)) : undefined;
    if (query.includes('projectV2(number: 2)'))
      return {
        user: {
          projectV2: {
            id: 'project',
            fields: {
              nodes: [
                {
                  id: 'field-Status',
                  name: 'Status',
                  options: ['Inbox', 'Ready', 'In progress', 'Done'].map(
                    (name) => ({ id: `option-${name}`, name }),
                  ),
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    if (query.includes('issue(number: $number)'))
      return {
        repository: {
          label,
          issue: node(issues.get(variables.number)) ?? null,
        },
      };
    if (query.includes(`label(name: "${MARKER}")`))
      return {
        repository: {
          label: label && {
            ...label,
            issues: slice(
              own()
                .filter((entry) => entry.labels.includes(MARKER))
                .map((entry) => ({
                  id: id(entry.number),
                  projectItems: slice(projectItems(entry), null),
                })),
              variables.cursor,
            ),
          },
        },
      };
    if (query.includes('issues(first: 100'))
      return {
        repository: { issues: slice(own().map(node), variables.cursor) },
      };
    if (query.includes('... on Issue { id number state')) {
      onSnapshot?.(issues);
      const found = node(issues.get(number(variables.id)));
      if (found) return { node: found };
      // GitHub's answer for a deleted or transferred issue.
      const result = {
        data: { node: null },
        errors: [{ type: 'NOT_FOUND', path: ['node'] }],
      };
      if (!options?.allowErrors?.(result)) throw new Error('NOT_FOUND');
      return result.data;
    }
    if (query.includes('subIssues(first: 100'))
      return {
        node: {
          subIssues: slice(children(entry.number).map(child), variables.cursor),
        },
      };
    if (query.includes('labels(first: 100'))
      return {
        node: {
          labels: slice(
            entry.labels.map((name) => ({ name })),
            variables.cursor,
          ),
        },
      };
    if (query.includes('projectItems(first: 100'))
      return {
        node: { projectItems: slice(projectItems(entry), variables.cursor) },
      };
    if (query.includes('addLabelsToLabelable')) {
      writes.push(`mark ${entry.number}`);
      entry.labels.push(MARKER);
      return {};
    }
    if (query.includes('removeLabelsFromLabelable')) {
      writes.push(`unmark ${entry.number}`);
      entry.labels = entry.labels.filter((name) => name !== MARKER);
      return {};
    }
    if (query.includes('closeIssue')) {
      writes.push(`close ${entry.number}`);
      entry.state = 'CLOSED';
      return {};
    }
    if (query.includes('reopenIssue')) {
      writes.push(`reopen ${entry.number}`);
      entry.state = 'OPEN';
      return {};
    }
    if (query.includes('updateProjectV2ItemFieldValue')) {
      const status = variables.option.slice('option-'.length);
      const target = issues.get(Number(variables.item.slice('item-'.length)));
      writes.push(`status ${target.number} ${status}`);
      target.status = status;
      return {};
    }
    throw new Error(`Unexpected mock query: ${query}`);
  };
  const count = (text) => calls.filter((query) => query.includes(text)).length;
  return { api, issues, calls, writes, count };
}

const SNAPSHOT = '... on Issue { id number state';
const LISTING = 'nodes { id number state';

// Container 1 holds container 2 and closed leaf 4; container 2 holds closed
// leaf 3. Container 10 holds open leaf 11.
function nested() {
  return [
    { number: 1 },
    { number: 2, parent: 1 },
    { number: 3, parent: 2, state: 'CLOSED' },
    { number: 4, parent: 1, state: 'CLOSED' },
    { number: 10 },
    { number: 11, parent: 10 },
  ];
}

test('a sweep closes a finished container and then its parent, reading no untouched container', async () => {
  const f = repository(nested());
  const lines = [];
  assert.deepEqual(
    await reconcileContainers({
      api: f.api,
      dryRun: false,
      log: (line) => lines.push(line),
    }),
    { updated: 2 },
  );
  assert.deepEqual(f.writes, [
    'mark 2',
    'close 2',
    'status 2 Done',
    'mark 1',
    'close 1',
    'status 1 Done',
  ]);
  assert.deepEqual(lines, [
    'Will close container #2',
    'Will close container #1',
    'Container reconciliation: 2 state changes; DRY_RUN=false',
  ]);
  // Container 2 is re-read once at the write boundary. Container 1 is re-read
  // because container 2 changed, then again at the write boundary.
  assert.equal(f.count(SNAPSHOT), 3);
  f.calls.length = 0;
  assert.deepEqual(
    await reconcileContainers({ api: f.api, dryRun: false, log() {} }),
    { updated: 0 },
  );
  // The marker listing and the issue listing; every marked container already
  // has its Status, so no field discovery.
  assert.equal(f.calls.length, 2);
  assert.equal(f.writes.length, 6);
});

test('a sweep costs one query per 100 issues and a few more', async () => {
  const entries = [];
  // 16 containers, each with 16 closed sub-issues and one open one.
  for (let container = 1; container < 288; container += 18) {
    entries.push({ number: container });
    for (let leaf = container + 1; leaf < container + 17; leaf++)
      entries.push({ number: leaf, parent: container, state: 'CLOSED' });
    entries.push({ number: container + 17, parent: container });
  }
  const f = repository(entries);
  await reconcileContainers({ api: f.api, dryRun: false, log() {} });
  assert.equal(f.issues.size, 288);
  assert.equal(f.count(LISTING), 3);
  // The marker listing and three issue pages; with nothing to change, no
  // field discovery.
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.writes, []);
});

test('dry-run reports without writes and never closes a parent ahead of its sub-issues', async () => {
  const f = repository(nested());
  const lines = [];
  assert.deepEqual(
    await reconcileContainers({ api: f.api, log: (line) => lines.push(line) }),
    { updated: 0 },
  );
  assert.deepEqual(lines, [
    'DRY_RUN would close container #2',
    'Container reconciliation: 0 state changes; DRY_RUN=true',
  ]);
  assert.deepEqual(f.writes, []);
});

test('a marked container that gains an open sub-issue reopens; one a person closed stays closed', async () => {
  const f = repository([
    { number: 5, state: 'CLOSED', labels: [MARKER], status: 'Done' },
    { number: 6, parent: 5 },
    { number: 7, state: 'CLOSED', status: 'Done' },
    { number: 8, parent: 7 },
  ]);
  assert.deepEqual(
    await reconcileContainers({ api: f.api, dryRun: false, log() {} }),
    { updated: 1 },
  );
  assert.deepEqual(f.writes, ['reopen 5', 'status 5 Ready', 'unmark 5']);
  assert.equal(f.issues.get(7).state, 'CLOSED');
});

test('a reopened container keeps its marker when another run closed it again', async () => {
  let snapshots = 0;
  const f = repository(
    [
      { number: 5, state: 'CLOSED', labels: [MARKER], status: 'Done' },
      { number: 6, parent: 5 },
    ],
    {
      // The second read follows the reopen; another run has closed #5 since.
      onSnapshot: (issues) => {
        if (++snapshots === 2) issues.get(5).state = 'CLOSED';
      },
    },
  );
  await reconcileContainers({ api: f.api, dryRun: false, log() {} });
  assert.deepEqual(f.writes, ['reopen 5', 'status 5 Ready']);
  assert.deepEqual(f.issues.get(5).labels, [MARKER]);
});

test('a container deleted during a sweep is skipped with a warning', async () => {
  const f = repository(nested(), {
    onSnapshot: (issues) => issues.delete(2),
  });
  const warnings = [];
  await reconcileContainers({
    api: f.api,
    dryRun: false,
    log() {},
    warn: (line) => warnings.push(line),
  });
  assert.deepEqual(warnings, [
    'Container #2 was not found; it may have been deleted or transferred. Skipping it.',
  ]);
  assert.deepEqual(f.writes, ['mark 2']);
});

test('marked containers get their Status repaired only when it is wrong', async () => {
  const entries = () => [
    { number: 20, state: 'CLOSED', labels: [MARKER], status: 'In progress' },
    { number: 21, parent: 20, state: 'CLOSED' },
    { number: 22, state: 'CLOSED', labels: [MARKER], status: 'Done' },
    { number: 23, parent: 22, state: 'CLOSED' },
    { number: 24, labels: [MARKER], status: 'In progress' },
    { number: 25, parent: 24 },
  ];
  const dry = repository(entries());
  await reconcileContainers({ api: dry.api, log() {} });
  assert.deepEqual(dry.writes, []);
  const f = repository(entries());
  assert.deepEqual(
    await reconcileContainers({ api: f.api, dryRun: false, log() {} }),
    { updated: 0 },
  );
  assert.deepEqual(f.writes, [
    'status 20 Done',
    'status 24 Ready',
    'unmark 24',
  ]);
  // Only the two containers that need a write are re-read; 22 is not.
  assert.equal(f.count(SNAPSHOT), 2);
  assert.equal(f.count('projectItems(first: 100'), 0);
});

test('a marked container repair acts on a fresh read, not the listing', async () => {
  // Another run closes container 24 after the listing: its Status becomes
  // Done and its marker stays, so automation still owns it.
  const closed = repository(
    [
      { number: 24, labels: [MARKER], status: 'In progress' },
      { number: 25, parent: 24 },
    ],
    {
      onSnapshot: (issues) => {
        issues.get(24).state = 'CLOSED';
        issues.get(25).state = 'CLOSED';
      },
    },
  );
  await reconcileContainers({ api: closed.api, dryRun: false, log() {} });
  assert.deepEqual(closed.writes, ['status 24 Done']);
  assert.deepEqual(closed.issues.get(24).labels, [MARKER]);

  // Another run already removed the marker: nothing is left to repair.
  const unmarked = repository(
    [
      { number: 20, state: 'CLOSED', labels: [MARKER], status: 'Ready' },
      { number: 21, parent: 20, state: 'CLOSED' },
    ],
    {
      onSnapshot: (issues) => {
        issues.get(20).labels = [];
      },
    },
  );
  await reconcileContainers({ api: unmarked.api, dryRun: false, log() {} });
  assert.deepEqual(unmarked.writes, []);
});

test('an issue run reads only the issue, its container sub-issues, and its parents', async () => {
  const f = repository([
    ...nested(),
    // Finished but open: a sweep would close it, an issue run elsewhere must not.
    { number: 30 },
    { number: 31, parent: 30, state: 'CLOSED' },
  ]);
  assert.deepEqual(
    await reconcileContainers({
      api: f.api,
      issueNumber: 3,
      dryRun: false,
      log() {},
    }),
    { updated: 2 },
  );
  assert.deepEqual(f.writes, [
    'mark 2',
    'close 2',
    'status 2 Done',
    'mark 1',
    'close 1',
    'status 1 Done',
  ]);
  assert.equal(f.issues.get(30).state, 'OPEN');
  assert.equal(f.count(LISTING), 0);
  assert.equal(f.count('states: [OPEN, CLOSED]'), 0);

  const root = repository(nested());
  assert.deepEqual(
    await reconcileContainers({
      api: root.api,
      issueNumber: 1,
      dryRun: false,
      log() {},
    }),
    { updated: 2 },
  );
  assert.equal(root.issues.get(1).state, 'CLOSED');
  assert.equal(root.issues.get(2).state, 'CLOSED');
  assert.equal(root.issues.get(10).state, 'OPEN');
  assert.equal(root.count(LISTING), 0);
});

test('an issue run costs the same few queries whatever the repository size', async () => {
  for (const size of [0, 300]) {
    const f = repository([
      ...nested(),
      ...Array.from({ length: size }, (_, index) => ({ number: index + 100 })),
    ]);
    await reconcileContainers({ api: f.api, issueNumber: 3, log() {} });
    // The issue and its two parents; with nothing to change, no field
    // discovery.
    assert.equal(f.calls.length, 3, `repository of ${size + 6}`);
  }
});

test('nested sub-issue, label, and project item pages are followed, and other repositories are ignored', async () => {
  const f = repository(
    [
      { number: 1 },
      { number: 2, parent: 1, state: 'CLOSED' },
      { number: 3, parent: 1, state: 'CLOSED' },
      { number: 4, parent: 1, state: 'CLOSED', repository: 'other/repo' },
      { number: 5, state: 'CLOSED', labels: ['bug', MARKER], status: 'Ready' },
      { number: 6, parent: 5, state: 'CLOSED' },
    ],
    { page: 1 },
  );
  await reconcileContainers({ api: f.api, dryRun: false, log() {} });
  assert.deepEqual(f.writes, [
    'mark 1',
    'close 1',
    'status 1 Done',
    'status 5 Done',
  ]);
  assert.ok(f.count('subIssues(first: 100') > 0);

  const event = repository(
    [
      { number: 5, state: 'CLOSED', labels: ['bug', MARKER], status: 'Ready' },
      { number: 6, parent: 5, state: 'CLOSED' },
      { number: 7, parent: 5, state: 'CLOSED' },
    ],
    { page: 1 },
  );
  await reconcileContainers({
    api: event.api,
    issueNumber: 5,
    dryRun: false,
    log() {},
  });
  assert.deepEqual(event.writes, ['status 5 Done']);
  assert.ok(event.count('labels(first: 100') > 0);
});

// GitHub's answer for a deleted or transferred issue, through ghGraphql.
function notFound(path = ['repository', 'issue']) {
  return (query, variables, options) =>
    ghGraphql(query, variables, {
      ...options,
      run: () =>
        `HTTP/2.0 200 OK\n\r\n${JSON.stringify({
          data: { repository: { label: { id: 'label-marker' }, issue: null } },
          errors: [
            {
              type: 'NOT_FOUND',
              path,
              message: 'Could not resolve to an Issue with the number of 99.',
            },
          ],
        })}`,
    });
}

test('an issue run for a deleted or transferred issue warns and writes nothing', async () => {
  const warnings = [];
  assert.deepEqual(
    await reconcileContainers({
      api: notFound(),
      issueNumber: 99,
      dryRun: false,
      log: assert.fail,
      warn: (line) => warnings.push(line),
    }),
    { updated: 0 },
  );
  assert.deepEqual(warnings, [
    'Issue #99 was not found; it may have been deleted or transferred. No container to reconcile.',
  ]);
  // A NOT_FOUND anywhere else still fails.
  await assert.rejects(
    reconcileContainers({
      api: notFound(['repository', 'label']),
      issueNumber: 99,
      warn: assert.fail,
    }),
    /NOT_FOUND/,
  );
});

test('a missing marker label, cycles, and invalid filters fail closed', async () => {
  for (const issueNumber of [undefined, 3])
    await assert.rejects(
      reconcileContainers({
        api: repository(nested(), { marker: false }).api,
        issueNumber,
        log() {},
      }),
      /Missing managed label/,
    );
  const cycle = () => [
    { number: 1, parent: 2 },
    { number: 2, parent: 1 },
  ];
  for (const issueNumber of [undefined, 1])
    await assert.rejects(
      reconcileContainers({
        api: repository(cycle()).api,
        issueNumber,
        dryRun: false,
        log() {},
      }),
      /Issue hierarchy cycle/,
    );
  for (const issueNumber of [0, -1, 1.5, '1'])
    await assert.rejects(
      reconcileContainers({
        api: () => assert.fail('API access with invalid issue filter'),
        issueNumber,
      }),
      /positive safe integer/,
    );
});
