import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
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
function fixture({
  content = { __typename: 'Issue', id: 'I_1' },
  project = { id: 'PVT_1', closed: false },
  statusOptions = STATUS_OPTIONS,
  existing = {},
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
      if (!items.has(variables.content))
        items.set(variables.content, { id: `PVTI_${items.size + 1}` });
      return {
        addProjectV2ItemById: {
          item: { id: items.get(variables.content).id },
        },
      };
    }
    if (/issueOrPullRequest\(number: \$number\)/.test(query)) {
      const nodes = [...items.entries()]
        .filter(([contentId]) => contentId === content?.id)
        .map(([, item]) => ({ id: item.id, project: { id: project?.id } }));
      return {
        repository: {
          issueOrPullRequest:
            content?.__typename === 'Issue'
              ? { ...content, projectItems: { nodes } }
              : content,
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

test('adds a pull request without setting a Status', async () => {
  const f = fixture({ content: { __typename: 'PullRequest', id: 'PR_9' } });
  await addToProject({ ...f, number: 9, dryRun: false });
  assert.deepEqual(f.writes, [{ project: 'PVT_1', content: 'PR_9' }]);
  assert.equal(f.items.get('PR_9').status, undefined);
  assert.deepEqual(f.lines, [
    'Added pull request #9 to Prismatic delivery as item PVTI_1.',
  ]);
  assert.ok(f.calls.every((call) => !/fields\(first: 100/.test(call.query)));
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
    [
      { content: { __typename: 'PullRequest', id: 'PR_9' } },
      9,
      'DRY_RUN would add pull request #9 to Prismatic delivery.',
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

test('a pull request does not need the Status field', async () => {
  const f = fixture({
    content: { __typename: 'PullRequest', id: 'PR_9' },
    statusOptions: [],
  });
  assert.equal(
    await addToProject({ ...f, number: 9, dryRun: false }),
    'PVTI_1',
  );
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
      /positive issue or pull request number/,
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

test('configuration requires the token and repository in Actions and defaults to a dry run', () => {
  assert.deepEqual(configuration({ ISSUE_OR_PR_NUMBER: '12' }), {
    number: 12,
    dryRun: true,
  });
  assert.deepEqual(
    configuration({
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'samlevin/prismatic',
      PRISMATIC_PROJECT_TOKEN: 'token',
      ISSUE_OR_PR_NUMBER: '12',
      DRY_RUN: 'false',
    }),
    { number: 12, dryRun: false },
  );
  const actions = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'samlevin/prismatic',
    PRISMATIC_PROJECT_TOKEN: 'token',
    ISSUE_OR_PR_NUMBER: '12',
  };
  for (const [env, message] of [
    [{ ...actions, PRISMATIC_PROJECT_TOKEN: '' }, /PRISMATIC_PROJECT_TOKEN/],
    [{ ...actions, GITHUB_REPOSITORY: 'other/repo' }, /Unexpected repository/],
    [{ ISSUE_OR_PR_NUMBER: '12', DRY_RUN: 'yes' }, /DRY_RUN/],
    [{}, /ISSUE_OR_PR_NUMBER/],
    [{ ISSUE_OR_PR_NUMBER: '0' }, /ISSUE_OR_PR_NUMBER/],
    [{ ISSUE_OR_PR_NUMBER: '12abc' }, /ISSUE_OR_PR_NUMBER/],
    [{ ISSUE_OR_PR_NUMBER: '99999999999999999999' }, /ISSUE_OR_PR_NUMBER/],
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
