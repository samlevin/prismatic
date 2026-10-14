import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copyMetadata,
  linkedIssues,
  metadataGraphql,
  readMetadata,
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
} = {}) {
  sources ??= {
    1: {
      id: 'i1',
      labels: ['l1', 'shared'],
      projects: ['p1'],
      milestone: { id: 'm1' },
    },
    2: {
      id: 'i2',
      labels: ['l2', 'shared'],
      projects: ['p1', 'p2'],
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
        repository: { pullRequest: { id: 'pr', body, state, milestone } },
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
    if (query.includes('projectItems(first:')) {
      const source =
        variables.id === 'pr'
          ? existing
          : Object.values(sources).find((issue) => issue.id === variables.id);
      return {
        node: {
          projectItems: {
            nodes: (source.projects ?? []).map((id) => ({
              project: { id, closed: false },
            })),
            pageInfo: { hasNextPage: false },
          },
        },
      };
    }
    if (query.includes('... on PullRequest { body'))
      return { node: { body: changed ? 'Closes #3' : body, state, milestone } };
    throw new Error(`Unexpected query: ${query}`);
  };
  return { api, writes, calls, log: () => {} };
}

test('copies the union once while preserving PR labels and projects', async () => {
  const f = fixture({
    existing: {
      labels: ['manual', 'shared'],
      projects: ['manual-project', 'p1'],
    },
  });
  await copyMetadata({ ...f, number: 10, dryRun: false });
  assert.deepEqual(
    f.writes.map((write) => write.variables),
    [
      { id: 'pr', labels: ['l1', 'l2'] },
      { id: 'pr', milestone: 'm1' },
      { project: 'p2', id: 'pr' },
    ],
  );
});
test('reruns with matching metadata make no writes', async () => {
  const f = fixture({
    existing: { labels: ['l1', 'l2', 'shared'], projects: ['p1', 'p2'] },
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
        1: { id: 'i1', labels: [], projects: [], milestone: { id: 'm1' } },
        2: { id: 'i2', labels: [], projects: [], milestone: { id: 'm2' } },
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
test('project and label reads paginate and exclude closed projects', async () => {
  const cursors = [];
  const api = async (query, { cursor }) => {
    cursors.push(cursor);
    if (query.includes('labels(first:'))
      return {
        node: {
          labels: {
            nodes: [{ id: cursor ? 'l2' : 'l1' }],
            pageInfo: { hasNextPage: !cursor, endCursor: 'next' },
          },
        },
      };
    return {
      node: {
        projectItems: {
          nodes: [{ project: { id: cursor ? 'p2' : 'p1', closed: !!cursor } }],
          pageInfo: { hasNextPage: !cursor, endCursor: 'next' },
        },
      },
    };
  };
  assert.deepEqual(await readMetadata(api, 'issue'), {
    labels: ['l1', 'l2'],
    projects: ['p1'],
  });
  assert.deepEqual(cursors, [null, 'next', null, 'next']);
});
test('discovery failures prevent partial writes', async () => {
  const f = fixture();
  const original = f.api;
  f.api = async (query, variables) => {
    if (query.includes('projectItems('))
      throw new Error('Project access denied');
    return original(query, variables);
  };
  await assert.rejects(
    copyMetadata({ ...f, number: 10, dryRun: false }),
    /Project access denied/,
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
  assert.throws(
    () => metadataGraphql(query, {}, run(response('FORBIDDEN'))),
    /returned errors/,
  );
  assert.throws(
    () =>
      metadataGraphql(query, {}, run(response('NOT_FOUND', ['repository']))),
    /returned errors/,
  );
  assert.throws(
    () =>
      metadataGraphql(
        'query { repository { pullRequest { id } } }',
        {},
        run(response('NOT_FOUND')),
      ),
    /returned errors/,
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
    /returned errors/,
  );
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
      { id: 'pr', milestone: 'm1' },
      { project: 'p1', id: 'pr' },
    ],
  );
});
