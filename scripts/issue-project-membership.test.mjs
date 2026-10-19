import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  addMissingIssues,
  addToProject,
  configuration,
  PROJECT,
} from './issue-project-membership.mjs';

const PAGE = { hasNextPage: false };
const STATUS_OPTIONS = [
  { id: 'OPT_INBOX', name: 'Inbox' },
  { id: 'OPT_READY', name: 'Ready' },
];

// A mock project that behaves like addProjectV2ItemById: adding content that
// is already in the project returns the existing item. `existing` maps content
// IDs to items already on the board, each with an optional Status option ID.
// `repository` lists the issues and pull requests the sweep can find, each
// with a number, and `failing` holds content IDs whose add fails.
function fixture({
  content = { __typename: 'Issue', id: 'I_1' },
  project = { id: 'PVT_1', closed: false },
  statusOptions = STATUS_OPTIONS,
  existing = {},
  repository = [],
  pageSize = 100,
  failing = [],
} = {}) {
  const items = new Map(
    Object.entries(existing).map(([contentId, item]) => [contentId, item]),
  );
  const byItem = () =>
    new Map([...items].map(([contentId, item]) => [item.id, contentId]));
  const calls = [];
  const writes = [];
  const api = async (query, variables) => {
    calls.push({ query, variables });
    if (query.startsWith('mutation')) {
      writes.push(variables);
      if (/updateProjectV2ItemFieldValue/.test(query)) {
        assert.equal(variables.project, project.id);
        assert.equal(variables.field, 'FIELD_STATUS');
        items.get(byItem().get(variables.item)).status = variables.option;
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 1 } } };
      }
      assert.match(query, /addProjectV2ItemById/);
      if (failing.includes(variables.content))
        throw new Error('API rate limit exceeded');
      if (!items.has(variables.content))
        items.set(variables.content, { id: `PVTI_${items.size + 1}` });
      return {
        addProjectV2ItemById: {
          item: { id: items.get(variables.content).id },
        },
      };
    }
    if (/issues\(first: 100/.test(query)) {
      // Like GitHub, the issues connection holds open issues and no pull requests.
      const open = repository.filter(
        (issue) => issue.__typename === 'Issue' && issue.state === 'OPEN',
      );
      const start = Number(variables.cursor ?? 0);
      const end = start + pageSize;
      return {
        repository: {
          issues: {
            nodes: open.slice(start, end).map((issue) => ({
              number: issue.number,
              projectItems: {
                nodes: [
                  ...(issue.otherProject ? [{ project: { id: 'PVT_9' } }] : []),
                  ...(items.has(issue.id)
                    ? [{ project: { id: project?.id } }]
                    : []),
                ],
              },
            })),
            pageInfo: {
              hasNextPage: end < open.length,
              endCursor: String(end),
            },
          },
        },
        user: { projectV2: project },
      };
    }
    if (/issueOrPullRequest\(number: \$number\)/.test(query)) {
      const found =
        repository.find((issue) => issue.number === variables.number) ??
        content;
      const nodes = [...items.entries()]
        .filter(([contentId]) => contentId === found?.id)
        .map(([, item]) => ({ id: item.id, project: { id: project?.id } }));
      return {
        repository: {
          issueOrPullRequest:
            found?.__typename === 'Issue'
              ? {
                  __typename: 'Issue',
                  id: found.id,
                  projectItems: { nodes },
                }
              : found,
        },
        user: { projectV2: project },
      };
    }
    if (/fields\(first: 100/.test(query)) {
      const options = statusOptions;
      return {
        user: {
          projectV2: {
            id: project.id,
            fields: {
              nodes: [{ id: 'FIELD_STATUS', name: 'Status', options }],
              pageInfo: PAGE,
            },
          },
        },
      };
    }
    if (/on ProjectV2Item/.test(query)) {
      const item = items.get(byItem().get(variables.id));
      return {
        node: {
          id: item.id,
          type: 'ISSUE',
          project: { id: project.id },
          content: { __typename: 'Issue', id: content.id },
          fieldValues: {
            nodes: item.status
              ? [{ optionId: item.status, field: { id: 'FIELD_STATUS' } }]
              : [],
            pageInfo: PAGE,
          },
        },
      };
    }
    assert.match(query, /labels\(first: 100/);
    return {
      node: {
        id: variables.id,
        __typename: 'Issue',
        labels: { nodes: [], pageInfo: PAGE },
      },
    };
  };
  const lines = [];
  return { api, calls, writes, items, lines, log: (line) => lines.push(line) };
}

const statusWrites = (f) =>
  f.writes.filter((write) => 'option' in write).map((write) => write.option);

test('adds a new issue by node ID and sets its Status to Inbox', async () => {
  const f = fixture();
  const item = await addToProject({ ...f, number: 7, dryRun: false });
  assert.equal(item, 'PVTI_1');
  assert.deepEqual(f.calls[0].variables, {
    owner: 'samlevin',
    name: 'prismatic',
    number: 7,
    login: PROJECT.owner,
    project: PROJECT.number,
  });
  assert.deepEqual(f.writes, [
    { project: 'PVT_1', content: 'I_1' },
    {
      project: 'PVT_1',
      item: 'PVTI_1',
      field: 'FIELD_STATUS',
      option: 'OPT_INBOX',
    },
  ]);
  assert.equal(f.items.get('I_1').status, 'OPT_INBOX');
  assert.deepEqual(f.lines, [
    'Added issue #7 to Prismatic delivery as item PVTI_1.',
    'Set Status Inbox on issue #7.',
  ]);
});

test('an issue already on the board keeps its Status', async () => {
  const f = fixture({
    existing: { I_1: { id: 'PVTI_5', status: 'OPT_READY' } },
  });
  assert.equal(
    await addToProject({ ...f, number: 7, dryRun: false }),
    'PVTI_5',
  );
  assert.deepEqual(statusWrites(f), []);
  assert.equal(f.items.get('I_1').status, 'OPT_READY');
  assert.deepEqual(f.lines, [
    'Added issue #7 to Prismatic delivery as item PVTI_5.',
    'Kept Status Ready on issue #7.',
  ]);
});

test('an issue already on the board without a Status gets Inbox', async () => {
  const f = fixture({ existing: { I_1: { id: 'PVTI_5' } } });
  await addToProject({ ...f, number: 7, dryRun: false });
  assert.deepEqual(statusWrites(f), ['OPT_INBOX']);
});

test('a pull request is skipped without writing', async () => {
  for (const dryRun of [false, true]) {
    const f = fixture({
      content: { __typename: 'PullRequest', id: 'PR_9' },
      statusOptions: [],
    });
    assert.equal(await addToProject({ ...f, number: 9, dryRun }), null);
    assert.deepEqual(f.writes, []);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.lines, [
      'Skipped pull request #9; only issues go on the board.',
    ]);
  }
});

test('adding content already in the project returns the same item', async () => {
  const f = fixture();
  const first = await addToProject({ ...f, number: 7, dryRun: false });
  const second = await addToProject({ ...f, number: 7, dryRun: false });
  assert.equal(second, first);
  assert.equal(f.items.size, 1);
  assert.deepEqual(statusWrites(f), ['OPT_INBOX']);
});

test('dry runs report the planned Status but never write', async () => {
  for (const [options, number, line] of [
    [
      {},
      7,
      'DRY_RUN would add issue #7 to Prismatic delivery and set its Status to Inbox.',
    ],
    [
      { existing: { I_1: { id: 'PVTI_5' } } },
      7,
      'DRY_RUN would keep issue #7 as item PVTI_5 and set its Status to Inbox.',
    ],
    [
      { existing: { I_1: { id: 'PVTI_5', status: 'OPT_READY' } } },
      7,
      'DRY_RUN would keep issue #7 as item PVTI_5 with Status Ready.',
    ],
  ]) {
    const f = fixture(options);
    assert.equal(await addToProject({ ...f, number }), null);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.lines, [line]);
  }
});

test('a missing Status field or Inbox option fails an issue before writing', async () => {
  for (const [statusOptions, message] of [
    [
      [{ id: 'OPT_READY', name: 'Ready' }],
      /Missing or ambiguous Status option Inbox/,
    ],
    [
      [...STATUS_OPTIONS, { id: 'OPT_INBOX_2', name: 'Inbox' }],
      /Missing or ambiguous Status option Inbox/,
    ],
  ]) {
    for (const dryRun of [false, true]) {
      const f = fixture({ statusOptions });
      await assert.rejects(addToProject({ ...f, number: 7, dryRun }), message);
      assert.deepEqual(f.writes, []);
    }
  }
  const f = fixture();
  const original = f.api;
  f.api = async (query, variables) => {
    const data = await original(query, variables);
    if (/fields\(first: 100/.test(query))
      data.user.projectV2.fields.nodes[0].name = 'State';
    return data;
  };
  await assert.rejects(
    addToProject({ ...f, number: 7, dryRun: false }),
    /Expected one Status single-select field/,
  );
  assert.deepEqual(f.writes, []);
});

test('missing content, a missing or closed project, and bad numbers fail before writing', async () => {
  for (const [options, message] of [
    [{ content: null }, /#7 not found in samlevin\/prismatic/],
    [{ project: null }, /project is unavailable/],
    [{ project: { id: 'PVT_1', closed: true } }, /project is unavailable/],
  ]) {
    const f = fixture(options);
    await assert.rejects(
      addToProject({ ...f, number: 7, dryRun: false }),
      message,
    );
    assert.deepEqual(f.writes, []);
  }
  for (const number of [0, -1, 1.5, NaN]) {
    const f = fixture();
    await assert.rejects(
      addToProject({ ...f, number, dryRun: false }),
      /positive issue number/,
    );
    assert.deepEqual(f.calls, []);
  }
});

test('a mutation without an item fails', async () => {
  const f = fixture();
  const original = f.api;
  f.api = async (query, variables) =>
    query.startsWith('mutation')
      ? { addProjectV2ItemById: null }
      : original(query, variables);
  await assert.rejects(
    addToProject({ ...f, number: 7, dryRun: false }),
    /did not return a project item/,
  );
});

const issue = (number, options = {}) => ({
  __typename: 'Issue',
  id: `I_${number}`,
  number,
  state: 'OPEN',
  ...options,
});
const listings = (f) =>
  f.calls.filter(({ query }) => /issues\(first: 100/.test(query));

test('a sweep adds only open issues missing from the project, across pages', async () => {
  const f = fixture({
    repository: [
      issue(1),
      issue(2),
      issue(3, { otherProject: true }),
      issue(4),
      issue(5, { state: 'CLOSED' }),
      { __typename: 'PullRequest', id: 'PR_6', number: 6, state: 'OPEN' },
      issue(7),
    ],
    existing: {
      I_2: { id: 'PVTI_2', status: 'OPT_READY' },
      I_4: { id: 'PVTI_4' },
    },
    pageSize: 2,
  });
  assert.deepEqual(await addMissingIssues({ ...f, dryRun: false }), {
    missing: [1, 3, 7],
    added: 3,
    failed: [],
  });
  assert.match(
    listings(f)[0].query,
    /repository\(owner: \$owner, name: \$name\) \{\s*issues\(first: 100, after: \$cursor, states: \[OPEN\]\)/,
  );
  assert.deepEqual(
    listings(f).map(({ variables }) => variables.cursor),
    [null, '2', '4'],
  );
  assert.deepEqual(
    f.writes
      .filter((write) => 'content' in write)
      .map((write) => write.content),
    ['I_1', 'I_3', 'I_7'],
  );
  assert.deepEqual(statusWrites(f), ['OPT_INBOX', 'OPT_INBOX', 'OPT_INBOX']);
  assert.equal(f.items.get('I_2').status, 'OPT_READY');
  assert.equal(f.items.get('I_4').status, undefined);
  assert.equal(f.items.has('PR_6'), false);
  assert.equal(f.items.has('I_5'), false);
  assert.equal(
    f.lines.at(-1),
    'Project membership sweep: 5 open, 3 missing, 3 added, 0 failed; DRY_RUN=false',
  );
});

test('a sweep that finds nothing missing makes one query per page and no writes', async () => {
  const f = fixture({
    repository: [issue(1), issue(2)],
    existing: { I_1: { id: 'PVTI_1' }, I_2: { id: 'PVTI_2' } },
  });
  assert.deepEqual(await addMissingIssues({ ...f, dryRun: false }), {
    missing: [],
    added: 0,
    failed: [],
  });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.lines, [
    'Project membership sweep: 2 open, 0 missing, 0 added, 0 failed; DRY_RUN=false',
  ]);
});

test('a dry-run sweep reports the missing issues and writes nothing', async () => {
  const f = fixture({
    repository: [issue(1), issue(2)],
    existing: { I_2: { id: 'PVTI_2' } },
  });
  assert.deepEqual(await addMissingIssues(f), {
    missing: [1],
    added: 0,
    failed: [],
  });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.lines, [
    'DRY_RUN would add issue #1 to Prismatic delivery and set its Status to Inbox.',
    'Project membership sweep: 2 open, 1 missing, 0 added, 0 failed; DRY_RUN=true',
  ]);
});

test('a sweep logs a failing issue, adds the rest, and then fails', async () => {
  const f = fixture({
    repository: [issue(1), issue(2), issue(3)],
    failing: ['I_2'],
  });
  await assert.rejects(
    addMissingIssues({ ...f, dryRun: false }),
    /Could not add #2 to Prismatic delivery/,
  );
  assert.deepEqual([...f.items.keys()], ['I_1', 'I_3']);
  assert.deepEqual(statusWrites(f), ['OPT_INBOX', 'OPT_INBOX']);
  assert.ok(
    f.lines.includes('Could not add issue #2: API rate limit exceeded'),
    f.lines.join('\n'),
  );
  assert.equal(
    f.lines.at(-1),
    'Project membership sweep: 3 open, 3 missing, 2 added, 1 failed; DRY_RUN=false',
  );
});

test('a sweep fails before writing when the project is missing or closed', async () => {
  for (const project of [null, { id: 'PVT_1', closed: true }]) {
    const f = fixture({ project, repository: [issue(1)] });
    await assert.rejects(
      addMissingIssues({ ...f, dryRun: false }),
      /project is unavailable/,
    );
    assert.deepEqual(f.writes, []);
  }
});

test('configuration requires the token and repository in Actions and defaults to a dry run', () => {
  assert.deepEqual(configuration({}, ['--sweep']), {
    sweep: true,
    dryRun: true,
  });
  assert.deepEqual(configuration({ DRY_RUN: 'false' }, ['--sweep']), {
    sweep: true,
    dryRun: false,
  });
  for (const args of [['--apply'], ['--sweep', '--sweep']])
    assert.throws(
      () => configuration({ ISSUE_NUMBER: '12' }, args),
      /only option is --sweep/,
    );
  assert.throws(
    () => configuration({ GITHUB_ACTIONS: 'true' }, ['--sweep']),
    /PRISMATIC_PROJECT_TOKEN/,
  );
  assert.deepEqual(configuration({ ISSUE_NUMBER: '12' }), {
    number: 12,
    dryRun: true,
  });
  assert.deepEqual(
    configuration({
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'samlevin/prismatic',
      PRISMATIC_PROJECT_TOKEN: 'token',
      ISSUE_NUMBER: '12',
      DRY_RUN: 'false',
    }),
    { number: 12, dryRun: false },
  );
  const actions = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'samlevin/prismatic',
    PRISMATIC_PROJECT_TOKEN: 'token',
    ISSUE_NUMBER: '12',
  };
  for (const [env, message] of [
    [{ ...actions, PRISMATIC_PROJECT_TOKEN: '' }, /PRISMATIC_PROJECT_TOKEN/],
    [{ ...actions, GITHUB_REPOSITORY: 'other/repo' }, /Unexpected repository/],
    [{ ISSUE_NUMBER: '12', DRY_RUN: 'yes' }, /DRY_RUN/],
    [{}, /ISSUE_NUMBER/],
    [{ ISSUE_NUMBER: '0' }, /ISSUE_NUMBER/],
    [{ ISSUE_NUMBER: '12abc' }, /ISSUE_NUMBER/],
    [{ ISSUE_NUMBER: '99999999999999999999' }, /ISSUE_NUMBER/],
  ])
    assert.throws(() => configuration(env), message);
});

test('the command line reports configuration errors without calling GitHub', () => {
  const script = fileURLToPath(
    new URL('./issue-project-membership.mjs', import.meta.url),
  );
  let failure;
  try {
    execFileSync(process.execPath, [script], {
      env: { PATH: process.env.PATH, GITHUB_ACTIONS: 'true' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.status, 1);
  assert.match(failure.stderr, /PRISMATIC_PROJECT_TOKEN is required/);
});
