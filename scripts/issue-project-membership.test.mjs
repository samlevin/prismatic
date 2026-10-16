import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  addToProject,
  configuration,
  PROJECT,
} from './issue-project-membership.mjs';

// A mock project that behaves like addProjectV2ItemById: adding content that
// is already in the project returns the existing item.
function fixture({
  content = { __typename: 'Issue', id: 'I_1' },
  project = { id: 'PVT_1', closed: false },
} = {}) {
  const items = new Map();
  const calls = [];
  const writes = [];
  const api = async (query, variables) => {
    calls.push({ query, variables });
    if (query.startsWith('mutation')) {
      writes.push(variables);
      assert.match(query, /addProjectV2ItemById/);
      if (!items.has(variables.content))
        items.set(variables.content, `PVTI_${items.size + 1}`);
      return {
        addProjectV2ItemById: { item: { id: items.get(variables.content) } },
      };
    }
    assert.match(query, /issueOrPullRequest\(number: \$number\)/);
    return {
      repository: { issueOrPullRequest: content },
      user: { projectV2: project },
    };
  };
  const lines = [];
  return { api, calls, writes, items, lines, log: (line) => lines.push(line) };
}

test('adds an issue to the project by node ID', async () => {
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
  assert.deepEqual(f.writes, [{ project: 'PVT_1', content: 'I_1' }]);
  assert.deepEqual(f.lines, [
    'Added issue #7 to Prismatic delivery as item PVTI_1.',
  ]);
});

test('adds a pull request the same way', async () => {
  const f = fixture({ content: { __typename: 'PullRequest', id: 'PR_9' } });
  await addToProject({ ...f, number: 9, dryRun: false });
  assert.deepEqual(f.writes, [{ project: 'PVT_1', content: 'PR_9' }]);
  assert.match(f.lines[0], /^Added pull request #9 /);
});

test('adding content already in the project returns the same item', async () => {
  const f = fixture();
  const first = await addToProject({ ...f, number: 7, dryRun: false });
  const second = await addToProject({ ...f, number: 7, dryRun: false });
  assert.equal(second, first);
  assert.equal(f.items.size, 1);
});

test('dry runs read but never write', async () => {
  const f = fixture();
  assert.equal(await addToProject({ ...f, number: 7 }), null);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.lines, [
    'DRY_RUN would add issue #7 to Prismatic delivery.',
  ]);
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
