import assert from 'node:assert/strict';
import test from 'node:test';
import { addToProject, sweep } from './issue-project-membership.mjs';
import { evaluate, workflow } from './workflow-test-helpers.mjs';

// A mocked GitHub that keeps one project item per content node, as
// addProjectV2ItemById does.
function github({
  issues = { 7: 'I_7' },
  project = { id: 'P_1', closed: false },
  items = new Map(),
} = {}) {
  const reads = [];
  const writes = [];
  const api = async (query, variables) => {
    if (query.startsWith('mutation')) {
      assert.match(query, /addProjectV2ItemById/);
      writes.push(variables);
      assert.equal(variables.project, project.id);
      assert.match(query, /item \{ id fullDatabaseId \}/);
      if (!items.has(variables.content))
        items.set(variables.content, String(100 + items.size + 1));
      const item = items.get(variables.content);
      return {
        addProjectV2ItemById: {
          item: { id: `PVTI_${item}`, fullDatabaseId: item },
        },
      };
    }
    reads.push({ query, variables });
    assert.deepEqual(variables, {
      owner: 'samlevin',
      name: 'prismatic',
      number: variables.number,
    });
    assert.match(query, /user\(login: "samlevin"\) \{ projectV2\(number: 2\)/);
    assert.match(query, /issue\(number: \$number\)/);
    assert.doesNotMatch(query, /pullRequest/);
    const id = issues[variables.number];
    return {
      repository: { issue: id ? { id } : null },
      user: { projectV2: project },
    };
  };
  return { api, reads, writes, items, log: () => {} };
}

test('adds a new issue to the project and prints its REST item ID', async () => {
  const f = github();
  const logs = [];
  assert.equal(
    await addToProject({
      ...f,
      kind: 'issue',
      number: 7,
      dryRun: false,
      log: (line) => logs.push(line),
    }),
    '101',
  );
  assert.deepEqual(f.writes, [{ project: 'P_1', content: 'I_7' }]);
  assert.deepEqual(logs, ['Issue #7: in Prismatic delivery as item 101.']);
});

test('pull request input fails before any API call, including dry runs', async () => {
  for (const dryRun of [true, false]) {
    const f = github();
    await assert.rejects(
      addToProject({ ...f, kind: 'pull_request', number: 9, dryRun }),
      /CONTENT_TYPE must be issue/,
    );
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.writes, []);
  }
});

test('an item already in the project is returned without a duplicate', async () => {
  const f = github({ items: new Map([['I_7', '276979720']]) });
  for (let run = 0; run < 2; run++)
    assert.equal(
      await addToProject({ ...f, kind: 'issue', number: 7, dryRun: false }),
      '276979720',
    );
  assert.equal(f.items.size, 1);
});

test('dry runs read but never write', async () => {
  const f = github();
  assert.equal(await addToProject({ ...f, kind: 'issue', number: 7 }), null);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.writes, []);
});

test('invalid input, missing content, and an unavailable project fail before writing', async () => {
  const cases = [
    [{ kind: 'discussion', number: 7 }, /CONTENT_TYPE/],
    [{ kind: 'constructor', number: 7 }, /CONTENT_TYPE/],
    [{ kind: undefined, number: 7 }, /CONTENT_TYPE/],
    [{ kind: 'issue', number: 0 }, /positive/],
    [{ kind: 'issue', number: Number.NaN }, /positive/],
    [{ kind: 'issue', number: 8 }, /Issue #8 not found/],
  ];
  for (const [options, error] of cases) {
    const f = github();
    await assert.rejects(
      addToProject({ ...f, ...options, dryRun: false }),
      error,
    );
    assert.deepEqual(f.writes, []);
  }
  for (const project of [null, { id: 'P_1', closed: true }]) {
    const f = github({ project });
    await assert.rejects(
      addToProject({ ...f, kind: 'issue', number: 7, dryRun: false }),
      /project is unavailable/,
    );
    assert.deepEqual(f.writes, []);
  }
});

test('a mutation without a REST item ID fails', async () => {
  for (const response of [
    { addProjectV2ItemById: null },
    { addProjectV2ItemById: { item: { id: 'PVTI_1' } } },
    { addProjectV2ItemById: { item: { id: 'PVTI_1', fullDatabaseId: 'x1' } } },
  ]) {
    const f = github();
    const api = async (query, variables) =>
      query.startsWith('mutation') ? response : f.api(query, variables);
    await assert.rejects(
      addToProject({ ...f, api, kind: 'issue', number: 7, dryRun: false }),
      /no project item/,
      JSON.stringify(response),
    );
  }
});

// A mocked GitHub for sweeps: `open` lists open issues as [number, projects],
// served `pageSize` per page, and `failing` holds issue numbers whose add
// fails.
function repository({
  open = [],
  project = { id: 'P_1', closed: false },
  pageSize = 2,
  failing = new Set(),
} = {}) {
  const calls = [];
  const writes = [];
  const logs = [];
  const errors = [];
  const api = async (query, variables) => {
    if (query.startsWith('mutation')) {
      const number = Number(variables.content.slice(2));
      if (failing.has(number))
        throw new Error(`Issue #${number} could not be added`);
      writes.push(number);
      return {
        addProjectV2ItemById: {
          item: { id: `PVTI_${number}`, fullDatabaseId: String(number) },
        },
      };
    }
    if (query.includes('issue(number: $number)')) {
      calls.push(['read', variables.number]);
      return {
        repository: { issue: { id: `I_${variables.number}` } },
        user: { projectV2: project },
      };
    }
    if (query.includes('issues(first: 100')) {
      assert.match(query, /states: \[OPEN\]/);
      assert.doesNotMatch(query, /pullRequest/);
      assert.equal(variables.owner, 'samlevin');
      assert.equal(variables.name, 'prismatic');
      const start = variables.cursor ? Number(variables.cursor) : 0;
      calls.push(['list', start]);
      const end = start + pageSize;
      return {
        repository: {
          issues: {
            nodes: open.slice(start, end).map(([number, projects]) => ({
              number,
              projectItems: {
                nodes: projects.map((id) => ({ project: { id } })),
              },
            })),
            pageInfo: {
              hasNextPage: end < open.length,
              endCursor: String(end),
            },
          },
        },
      };
    }
    assert.match(query, /user\(login: "samlevin"\) \{ projectV2\(number: 2\)/);
    calls.push(['project']);
    return { user: { projectV2: project } };
  };
  return {
    api,
    calls,
    writes,
    logs,
    errors,
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  };
}

test('a sweep adds only the open issues missing from the project', async () => {
  const f = repository({
    open: [
      [4, ['P_1']],
      [9, []],
      [5, ['P_other']],
      [6, ['P_other', 'P_1']],
      [3, []],
    ],
  });
  assert.deepEqual(await sweep({ ...f, dryRun: false }), {
    missing: [3, 5, 9],
    failed: [],
  });
  assert.deepEqual(f.writes, [3, 5, 9]);
  assert.deepEqual(
    f.calls.filter(([kind]) => kind === 'list'),
    [
      ['list', 0],
      ['list', 2],
      ['list', 4],
    ],
  );
  assert.deepEqual(f.errors, []);
});

test('a sweep with nothing missing makes no write and no per-issue read', async () => {
  const f = repository({
    open: [
      [1, ['P_1']],
      [2, ['P_1']],
      [3, ['P_1']],
    ],
  });
  assert.deepEqual(await sweep({ ...f, dryRun: false }), {
    missing: [],
    failed: [],
  });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(
    f.calls.filter(([kind]) => kind === 'read'),
    [],
  );
  assert.deepEqual(f.logs, ['All 3 open issues are in Prismatic delivery.']);
});

test('a dry-run sweep reports missing issues without writing', async () => {
  for (const options of [{}, { dryRun: true }]) {
    const f = repository({
      open: [
        [8, []],
        [2, ['P_1']],
      ],
    });
    assert.deepEqual(await sweep({ ...f, ...options }), {
      missing: [8],
      failed: [],
    });
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.logs, [
      'Open issues missing from Prismatic delivery: #8.',
      'Issue #8: would add to Prismatic delivery (dry run).',
    ]);
  }
});

test('a failing issue is logged, the rest are added, and the sweep fails', async () => {
  const f = repository({
    open: [
      [1, []],
      [2, []],
      [3, []],
    ],
    failing: new Set([2]),
  });
  await assert.rejects(
    sweep({ ...f, dryRun: false }),
    /Could not add 1 of 3 missing issues: #2$/,
  );
  assert.deepEqual(f.writes, [1, 3]);
  assert.deepEqual(f.errors, ['Issue #2: Issue #2 could not be added']);
});

test('a sweep against an unavailable project fails before listing issues', async () => {
  for (const project of [null, { id: 'P_1', closed: true }]) {
    const f = repository({ open: [[1, []]], project });
    await assert.rejects(
      sweep({ ...f, dryRun: false }),
      /project is unavailable/,
    );
    assert.deepEqual(f.calls, [['project']]);
    assert.deepEqual(f.writes, []);
  }
});

// Evaluate a workflow expression such as `${{ a && format('x{0}', b) }}`.
const expression = (value, context) =>
  evaluate(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    format: (text, ...args) =>
      text.replace(/\{(\d+)\}/g, (_, index) => args[index]),
    ...context,
  });
const DEFAULT_BRANCH = { repository: { default_branch: 'main' } };

// The hourly membership sweep runs in tracker-issue-states.yml.
test('the workflow adds opened issues and sweeps by hand', () => {
  const definition = workflow('tracker-project-membership');
  const { issues, workflow_dispatch: dispatch } = definition.on;
  assert.deepEqual(Object.keys(definition.on).sort(), [
    'issues',
    'workflow_dispatch',
  ]);
  assert.deepEqual(issues, { types: ['opened'] });
  assert.equal(dispatch.inputs.dry_run.type, 'boolean');
  assert.equal(dispatch.inputs.dry_run.default, true);
  assert.equal(definition.name, 'Tracker: add issues to the project');
  assert.deepEqual(definition.permissions, { contents: 'read' });
  const opened = {
    event_name: 'issues',
    event: { issue: { number: 7 }, ...DEFAULT_BRANCH },
  };
  assert.equal(
    expression(definition['run-name'], { github: opened }),
    'Add issue #7 to Prismatic delivery',
  );
  assert.equal(
    expression(definition.concurrency.group, { github: opened }),
    'project-membership-issue-7',
  );
  {
    const event_name = 'workflow_dispatch';
    const github = { event_name, event: DEFAULT_BRANCH };
    assert.equal(
      expression(definition['run-name'], { github }),
      `Add missing issues to Prismatic delivery (${event_name})`,
    );
    assert.equal(
      expression(definition.concurrency.group, { github }),
      'project-membership-sweep',
    );
  }
  assert.equal(definition.concurrency['cancel-in-progress'], false);
  assert.deepEqual(Object.keys(definition.jobs), [
    'add-to-project',
    'add-missing-issues',
  ]);
  for (const job of Object.values(definition.jobs)) {
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    assert.deepEqual(checkout.with, {
      ref: '${{ github.event.repository.default_branch }}',
      'persist-credentials': false,
      'sparse-checkout': 'scripts',
    });
    const runs = job.steps.filter((step) => step.run);
    assert.equal(runs[0].run, 'node scripts/issue-project-membership.mjs');
    for (const run of runs)
      assert.equal(
        run.env.PRISMATIC_PROJECT_TOKEN,
        '${{ secrets.PRISMATIC_PROJECT_TOKEN }}',
      );
  }
  assert.equal(
    definition.jobs['add-missing-issues'].steps.filter((step) => step.run)
      .length,
    1,
  );
});

test('opened issues are added to the project, then triaged once', () => {
  const job = workflow('tracker-project-membership').jobs['add-to-project'];
  assert.equal(job.name, 'Add the new issue to Prismatic delivery');
  const [run, triage, ...rest] = job.steps.filter((step) => step.run);
  assert.deepEqual(rest, []);
  assert.equal(triage.name, 'Triage the new issue');
  assert.equal(
    triage.run,
    'node scripts/issue-triage.mjs --apply --issue "$ISSUE_NUMBER"',
  );
  assert.deepEqual(Object.keys(triage.env).sort(), [
    'ISSUE_NUMBER',
    'PRISMATIC_PROJECT_TOKEN',
  ]);
  assert.equal(
    expression(triage.env.ISSUE_NUMBER, {
      github: { event: { issue: { number: 7 } } },
    }),
    7,
  );
  assert.deepEqual(Object.keys(run.env).sort(), [
    'CONTENT_NUMBER',
    'CONTENT_TYPE',
    'DRY_RUN',
    'PRISMATIC_PROJECT_TOKEN',
  ]);
  assert.equal(run.env.DRY_RUN, 'false');
  assert.equal(run.env.CONTENT_TYPE, 'issue');
  assert.equal(
    expression(run.env.CONTENT_NUMBER, {
      github: { event: { issue: { number: 7 } } },
    }),
    7,
  );
});

test('each event runs one job, and the sweep runs only from the default branch', () => {
  const { jobs } = workflow('tracker-project-membership');
  const runs = (github) =>
    Object.entries(jobs)
      .filter(([, job]) => expression(job.if, { github }))
      .map(([id]) => id);
  const github = (event_name, overrides = {}) => ({
    event_name,
    repository: 'samlevin/prismatic',
    ref: 'refs/heads/main',
    event: { issue: { number: 7 }, ...DEFAULT_BRANCH },
    ...overrides,
  });
  assert.deepEqual(runs(github('issues')), ['add-to-project']);
  assert.deepEqual(runs(github('issues', { ref: 'refs/heads/feature' })), [
    'add-to-project',
  ]);
  assert.deepEqual(runs(github('workflow_dispatch')), ['add-missing-issues']);
  assert.deepEqual(
    runs(github('workflow_dispatch', { ref: 'refs/heads/feature' })),
    [],
  );
  for (const event_name of ['issues', 'workflow_dispatch'])
    assert.deepEqual(
      runs(github(event_name, { repository: 'someone/fork' })),
      [],
    );
});

test('a manual sweep follows its dry_run input', () => {
  const job = workflow('tracker-project-membership').jobs['add-missing-issues'];
  assert.equal(job.name, 'Add missing open issues to Prismatic delivery');
  const run = job.steps.find((step) => step.run);
  assert.deepEqual(Object.keys(run.env).sort(), [
    'DRY_RUN',
    'PRISMATIC_PROJECT_TOKEN',
    'SWEEP',
  ]);
  assert.equal(run.env.SWEEP, 'true');
  const dryRun = (event_name, inputs = {}) =>
    expression(run.env.DRY_RUN, { github: { event_name }, inputs });
  assert.equal(dryRun('workflow_dispatch', { dry_run: true }), 'true');
  assert.equal(dryRun('workflow_dispatch', { dry_run: false }), 'false');
});
