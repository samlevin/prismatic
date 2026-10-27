import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copyMetadata,
  isReleasePullRequest,
  linkedIssues,
  metadataGraphql,
  readMetadata,
  RELEASE_BRANCH,
  releasedComponents,
} from './issue-pr-metadata.mjs';

const repository = 'example/suite';
test('description references support shorthand, qualified links and issue URLs', () => {
  assert.deepEqual(
    linkedIssues(
      'Closes #12, fixes example/suite#13. https://github.com/example/suite/issues/14\nAlso #12',
      repository,
    ),
    [12, 13, 14],
  );
});
test('references exclude parents, code, comments, other repositories and PR URLs', () => {
  assert.deepEqual(
    linkedIssues(
      'Parent issue or epic: #1\nParent epic: #2\n<!-- #3 -->\n`#4`\n```md\n#5\n```\n~~~\n#6\n~~~\nother/repo#7 https://github.com/other/repo/issues/8 https://github.com/example/suite/pull/9\nCloses #10',
      repository,
    ),
    [10],
  );
  assert.deepEqual(linkedIssues(null), []);
});

function fixture({
  body = 'Closes #1 and #2',
  milestone = null,
  state = 'OPEN',
  changed = false,
  existing = {},
  sources,
  head = {},
  blobs = {},
  repoLabels = {},
  pushed = false,
} = {}) {
  sources ??= {
    1: {
      id: 'i1',
      labels: ['l1', 'shared'],
      assignees: ['u1'],
      milestone: { id: 'm1' },
    },
    2: {
      id: 'i2',
      labels: ['l2', 'shared'],
      assignees: ['u1', 'u2'],
      milestone: { id: 'm1' },
    },
  };
  const writes = [];
  const calls = [];
  const api = async (query, variables) => {
    calls.push({ query, variables });
    if (query.startsWith('mutation')) {
      writes.push({ query, variables });
      return {};
    }
    if (query.includes('pullRequest(number:'))
      return {
        repository: {
          pullRequest: {
            id: 'pr',
            body,
            state,
            milestone,
            headRefName: 'agent/1-change',
            headRefOid: 'head-sha',
            baseRefOid: 'base-sha',
            isCrossRepository: false,
            ...head,
          },
        },
      };
    if (query.includes('object(expression:')) {
      const blob = (expression) =>
        expression in blobs
          ? { text: JSON.stringify(blobs[expression]) }
          : null;
      return {
        repository: {
          config: blob(variables.config),
          base: blob(variables.base),
          head: blob(variables.head),
        },
      };
    }
    if (query.includes('label(name:'))
      return {
        repository: {
          label:
            variables.label in repoLabels
              ? { id: repoLabels[variables.label] }
              : null,
        },
      };
    if (query.includes('issueOrPullRequest(')) {
      const issue = sources[variables.number];
      return {
        repository: {
          issueOrPullRequest: issue
            ? { __typename: 'Issue', ...issue }
            : { __typename: 'PullRequest' },
        },
      };
    }
    if (query.includes('labels(first:')) {
      const source =
        variables.id === 'pr'
          ? existing
          : Object.values(sources).find((issue) => issue.id === variables.id);
      return {
        node: {
          labels: {
            nodes: (source.labels ?? []).map((id) => ({ id })),
            pageInfo: { hasNextPage: false },
          },
        },
      };
    }
    if (query.includes('assignees(first:')) {
      const source =
        variables.id === 'pr'
          ? existing
          : Object.values(sources).find((issue) => issue.id === variables.id);
      return {
        node: {
          assignees: {
            nodes: (source.assignees ?? []).map((id) => ({ id })),
            pageInfo: { hasNextPage: false },
          },
        },
      };
    }
    if (query.includes('... on PullRequest { body'))
      return {
        node: {
          body: changed ? 'Closes #3' : body,
          state,
          milestone,
          headRefOid: pushed ? 'pushed-sha' : (head.headRefOid ?? 'head-sha'),
        },
      };
    throw new Error(`Unexpected query: ${query}`);
  };
  return { api, writes, calls, log: () => {} };
}

test('copies the union once while preserving PR labels and assignees', async () => {
  const f = fixture({
    existing: {
      labels: ['manual', 'shared'],
      assignees: ['reviewer', 'u1'],
    },
  });
  await copyMetadata({ ...f, number: 10, dryRun: false });
  assert.deepEqual(
    f.writes.map((write) => write.variables),
    [
      { id: 'pr', labels: ['l1', 'l2'] },
      { id: 'pr', assignees: ['u2'] },
      { id: 'pr', milestone: 'm1' },
    ],
  );
  assert.ok(
    f.writes.every(
      (write) =>
        !write.query.includes('assigneeIds') || write.variables.id === 'pr',
    ),
  );
  // Project membership comes from tracker-project-membership.yml instead.
  assert.ok(
    f.calls.every(({ query }) => !/projectItems|ProjectV2/.test(query)),
  );
});
test('unassigned issues add no assignees', async () => {
  const f = fixture({
    sources: {
      1: { id: 'i1', labels: [], assignees: [], milestone: null },
    },
    body: 'Closes #1',
  });
  await copyMetadata({ ...f, number: 10, dryRun: false });
  assert.deepEqual(f.writes, []);
});
test('reruns with matching metadata make no writes', async () => {
  const f = fixture({
    existing: {
      labels: ['l1', 'l2', 'shared'],
      assignees: ['u1', 'u2'],
    },
    milestone: { id: 'm1' },
  });
  await copyMetadata({ ...f, number: 10, dryRun: false });
  assert.deepEqual(f.writes, []);
});
test('dry runs and unlinked or closed PRs make no writes', async () => {
  for (const options of [
    {},
    { body: null },
    { state: 'CLOSED' },
    { body: 'Closes #99' },
  ]) {
    const f = fixture(options);
    await copyMetadata({ ...f, number: 10 });
    assert.deepEqual(f.writes, []);
  }
});
test('conflicting milestones and existing PR milestones are preserved', async () => {
  for (const options of [
    {
      sources: {
        1: { id: 'i1', labels: [], milestone: { id: 'm1' } },
        2: { id: 'i2', labels: [], milestone: { id: 'm2' } },
      },
    },
    { milestone: { id: 'manual' } },
  ]) {
    const f = fixture(options);
    await copyMetadata({ ...f, number: 10, dryRun: false });
    assert.ok(
      f.writes.every((write) => !write.query.includes('updatePullRequest')),
    );
  }
});
test('changed descriptions prevent mutations', async () => {
  const f = fixture({ changed: true });
  await assert.rejects(
    copyMetadata({ ...f, number: 10, dryRun: false }),
    /changed during discovery/,
  );
  assert.deepEqual(f.writes, []);
});
test('label and assignee reads paginate', async () => {
  const cursors = [];
  const api = async (query, { cursor }) => {
    cursors.push(cursor);
    if (query.includes('assignees(first:'))
      return {
        node: {
          assignees: {
            nodes: [{ id: cursor ? 'u2' : 'u1' }],
            pageInfo: { hasNextPage: !cursor, endCursor: 'next' },
          },
        },
      };
    return {
      node: {
        labels: {
          nodes: [{ id: cursor ? 'l2' : 'l1' }],
          pageInfo: { hasNextPage: !cursor, endCursor: 'next' },
        },
      },
    };
  };
  assert.deepEqual(await readMetadata(api, 'issue'), {
    labels: ['l1', 'l2'],
    assignees: ['u1', 'u2'],
  });
  assert.deepEqual(cursors, [null, 'next', null, 'next']);
});
test('discovery failures prevent partial writes', async () => {
  const f = fixture();
  const original = f.api;
  f.api = async (query, variables) => {
    if (query.includes('assignees(first:'))
      throw new Error('Assignee access denied');
    return original(query, variables);
  };
  await assert.rejects(
    copyMetadata({ ...f, number: 10, dryRun: false }),
    /Assignee access denied/,
  );
  assert.deepEqual(f.writes, []);
});

test('indented and multi-backtick code examples cannot supply links', () => {
  assert.deepEqual(
    linkedIssues(
      '    Closes #1\n\tFixes #2\nUse ``Closes #3 and `#4` `` as an example.\nCloses #5',
    ),
    [5],
  );
});

test('GitHub NOT_FOUND for a missing issue is skipped while other errors fail', () => {
  const query =
    'query { repository { issueOrPullRequest(number: 999) { id } } }';
  const response = (type, path = ['repository', 'issueOrPullRequest']) => ({
    data: { repository: { issueOrPullRequest: null } },
    errors: [{ type, path }],
  });
  const run = (result) => () => {
    throw Object.assign(new Error('gh exited with status 1'), {
      stdout: JSON.stringify(result),
    });
  };
  assert.deepEqual(metadataGraphql(query, {}, run(response('NOT_FOUND'))), {
    repository: { issueOrPullRequest: null },
  });
  assert.throws(() => metadataGraphql(query, {}, run(response('FORBIDDEN'))), {
    name: 'GitHubError',
    kind: 'access',
    message:
      'GitHub GraphQL request failed: FORBIDDEN. Check that the token is valid and has issue and Projects access.',
  });
  assert.throws(
    () =>
      metadataGraphql(query, {}, run(response('NOT_FOUND', ['repository']))),
    { kind: 'not-found', message: 'GitHub GraphQL request failed: NOT_FOUND.' },
  );
  assert.throws(
    () =>
      metadataGraphql(
        'query { repository { pullRequest { id } } }',
        {},
        run(response('NOT_FOUND')),
      ),
    { kind: 'not-found', message: 'GitHub GraphQL request failed: NOT_FOUND.' },
  );
  assert.throws(
    () =>
      metadataGraphql(
        query,
        {},
        run({
          ...response('NOT_FOUND'),
          errors: [
            ...response('NOT_FOUND').errors,
            ...response('FORBIDDEN').errors,
          ],
        }),
      ),
    {
      kind: 'access',
      message:
        'GitHub GraphQL request failed: NOT_FOUND; FORBIDDEN. Check that the token is valid and has issue and Projects access.',
    },
  );
});

test('a tolerated NOT_FOUND response with gh headers still passes silently', () => {
  const query =
    'query { repository { issueOrPullRequest(number: 999) { id } } }';
  const calls = [];
  const data = metadataGraphql(query, { number: 999 }, (command, args) => {
    calls.push([command, ...args]);
    throw Object.assign(new Error('gh exited with status 1'), {
      status: 1,
      stderr: 'gh: Could not resolve to an issue or pull request',
      stdout:
        'HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 4999\r\n\r\n' +
        JSON.stringify({
          data: { repository: { issueOrPullRequest: null } },
          errors: [
            {
              type: 'NOT_FOUND',
              path: ['repository', 'issueOrPullRequest'],
              message:
                'Could not resolve to an issue or pull request with the number of 999.',
            },
          ],
        }),
    });
  });
  assert.deepEqual(data, { repository: { issueOrPullRequest: null } });
  assert.deepEqual(calls, [
    ['gh', 'api', '--include', 'graphql', '--input', '-'],
  ]);
});

test('valid issues still supply metadata alongside missing references', async () => {
  const f = fixture({ body: 'Closes #1 and #999' });
  const original = f.api;
  f.api = async (query, variables) =>
    variables.number === 999
      ? metadataGraphql(query, variables, () => {
          throw Object.assign(new Error('gh exited with status 1'), {
            stdout: JSON.stringify({
              data: { repository: { issueOrPullRequest: null } },
              errors: [
                {
                  type: 'NOT_FOUND',
                  path: ['repository', 'issueOrPullRequest'],
                },
              ],
            }),
          });
        })
      : original(query, variables);
  await copyMetadata({ ...f, number: 10, dryRun: false });
  assert.deepEqual(
    f.writes.map((write) => write.variables),
    [
      { id: 'pr', labels: ['l1', 'shared'] },
      { id: 'pr', assignees: ['u1'] },
      { id: 'pr', milestone: 'm1' },
    ],
  );
});

const releaseHead = { headRefName: RELEASE_BRANCH };
const releaseBlobs = {
  'base-sha:release-please-config.json': {
    packages: {
      'packages/a': { component: 'a' },
      'packages/b': { component: 'b' },
      'applications/c': { component: 'c' },
    },
  },
  'base-sha:.release-please-manifest.json': {
    'packages/a': '1.0.0',
    'packages/b': '1.0.0',
    'applications/c': '2.0.0',
  },
  'head-sha:.release-please-manifest.json': {
    'packages/a': '1.1.0',
    'packages/b': '1.0.0',
    'applications/c': '2.0.1',
  },
};
const packageLabels = {
  'package: a': 'pa',
  'package: b': 'pb',
  'package: c': 'pc',
};

test('the release PR is the repository branch Release Please opens', () => {
  assert.equal(
    isReleasePullRequest({
      headRefName: RELEASE_BRANCH,
      isCrossRepository: false,
    }),
    true,
  );
  for (const pr of [
    { headRefName: RELEASE_BRANCH, isCrossRepository: true },
    { headRefName: 'agent/1-change', isCrossRepository: false },
    { headRefName: RELEASE_BRANCH },
  ])
    assert.equal(isReleasePullRequest(pr), false);
});

test('released components are the packages whose manifest version changes', () => {
  assert.deepEqual(
    releasedComponents(
      {
        packages: {
          'packages/a': { component: 'a' },
          'packages/same': { component: 'same' },
          'packages/new': { component: 'new' },
          'packages/removed': { component: 'removed' },
          'packages/unnamed': {},
        },
      },
      {
        'packages/a': '1.0.0',
        'packages/same': '1.0.0',
        'packages/removed': '1.0.0',
        'packages/unnamed': '1.0.0',
      },
      {
        'packages/a': '1.0.1',
        'packages/same': '1.0.0',
        'packages/new': '0.1.0',
        'packages/unnamed': '1.1.0',
      },
    ),
    ['a', 'new'],
  );
  assert.deepEqual(releasedComponents({}, {}, {}), []);
});

test('the release PR gets released package labels instead of issue labels', async () => {
  const f = fixture({
    head: releaseHead,
    blobs: releaseBlobs,
    repoLabels: packageLabels,
    existing: { labels: ['autorelease'] },
  });
  await copyMetadata({ ...f, number: 10, dryRun: false });
  assert.deepEqual(
    f.writes.map((write) => write.variables),
    [
      { id: 'pr', labels: ['pa', 'pc'] },
      { id: 'pr', assignees: ['u1', 'u2'] },
      { id: 'pr', milestone: 'm1' },
    ],
  );
  // The component mapping comes from the base commit, never the release branch.
  const blobRead = f.calls.find(({ query }) =>
    query.includes('object(expression:'),
  );
  assert.equal(
    blobRead.variables.config,
    'base-sha:release-please-config.json',
  );
});

test('the release PR gets package labels without linked issues and keeps existing ones', async () => {
  const logs = [];
  const f = fixture({
    body: 'No issue references',
    head: releaseHead,
    blobs: releaseBlobs,
    repoLabels: { 'package: a': 'pa' },
    existing: { labels: ['pa'] },
  });
  await copyMetadata({
    ...f,
    log: (line) => logs.push(line),
    number: 10,
    dryRun: false,
  });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(logs, [
    'Release PR releases a, c; issue labels are not copied.',
    'Label "package: c" does not exist; skipping it.',
    'PR #10: 0 labels, 0 assignees, 0 milestone to copy.',
  ]);
});

test('a release PR dry run reports package labels and writes nothing', async () => {
  const logs = [];
  const f = fixture({
    head: releaseHead,
    blobs: releaseBlobs,
    repoLabels: packageLabels,
  });
  await copyMetadata({ ...f, log: (line) => logs.push(line), number: 10 });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(logs, [
    'Release PR releases a, c; issue labels are not copied.',
    'PR #10: 2 labels, 2 assignees, 1 milestone to copy (dry run).',
  ]);
});

test('a forked PR from a release-named branch keeps issue labels', async () => {
  const f = fixture({
    head: { ...releaseHead, isCrossRepository: true },
    blobs: releaseBlobs,
    repoLabels: packageLabels,
  });
  await copyMetadata({ ...f, number: 10, dryRun: false });
  assert.deepEqual(f.writes[0].variables, {
    id: 'pr',
    labels: ['l1', 'shared', 'l2'],
  });
  assert.ok(
    f.calls.every(({ query }) => !query.includes('object(expression:')),
  );
});

test('a release PR push during discovery prevents mutations', async () => {
  const f = fixture({
    head: releaseHead,
    blobs: releaseBlobs,
    repoLabels: packageLabels,
    pushed: true,
  });
  await assert.rejects(
    copyMetadata({ ...f, number: 10, dryRun: false }),
    /changed during discovery/,
  );
  assert.deepEqual(f.writes, []);
});
