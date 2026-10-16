import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  configuration,
  discover,
  eligible,
  paginate,
  readItem,
  reconcile,
  REPOSITORY,
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

function mockApi({
  race,
  multipleSeverity = false,
  additionalIssue = false,
} = {}) {
  const state = {
    mutations: [],
    reads: 0,
    pages: new Set(),
    status: 'Inbox',
    otherStatus: 'Inbox',
    readItems: [],
  };
  const second = issue({
    id: 'item-2',
    content: { ...issue().content, id: 'issue-2', number: 2 },
  });
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
  const api = async (query, variables) => {
    const page = variables.cursor ? 1 : 0;
    if (query.includes('projectV2(number: 2)')) {
      state.pages.add(`definitions-${page}`);
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
    if (query.includes('items(first:')) {
      state.pages.add(`items-${page}`);
      return {
        node: {
          items: page
            ? connection(additionalIssue ? [issue(), second] : [issue()])
            : connection(
                [
                  { id: 'pr', type: 'PULL_REQUEST' },
                  { id: 'draft', type: 'DRAFT_ISSUE' },
                  {
                    ...issue(),
                    id: 'other',
                    content: { repository: { nameWithOwner: 'other/repo' } },
                  },
                ],
                true,
              ),
        },
      };
    }
    if (query.includes('fieldValues(first:')) {
      if (!page) {
        state.reads++;
        state.readItems.push(variables.id);
      }
      state.pages.add(`values-${page}`);
      const fields = {
        Status: variables.id === 'item-2' ? state.otherStatus : state.status,
        Priority: 'P2',
        Size: 'L',
      };
      if (state.reads >= 2 && race) race(fields, state);
      const values = Object.entries(fields).map(([name, value]) => ({
        field: { id: `field-${name}` },
        optionId: `option-${value}`,
      }));
      return {
        node: {
          ...(variables.id === 'item-2' ? second : issue()),
          project: { id: 'project' },
          fieldValues: page
            ? connection(values.slice(1))
            : connection(values.slice(0, 1), true),
        },
      };
    }
    if (query.includes('labels(first:')) {
      state.pages.add(`labels-${page}`);
      const content = {
        ...(variables.id === 'issue-2' ? second.content : issue().content),
      };
      if (state.renumbered) content.number = 2;
      if (state.closed) content.state = 'CLOSED';
      if (state.foreign) content.repository = { nameWithOwner: 'other/repo' };
      return {
        node: {
          ...content,
          labels: page
            ? connection(
                multipleSeverity || state.extraSeverity
                  ? [{ name: 'severity: high' }]
                  : [],
              )
            : connection([{ name: 'severity: none' }], true),
        },
      };
    }
    if (query.includes('updateProjectV2ItemFieldValue')) {
      state.mutations.push(variables);
      if (variables.item === 'item-2') state.otherStatus = 'Ready';
      else state.status = 'Ready';
      return {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: variables.item },
        },
      };
    }
    throw new Error('Unexpected mock query');
  };
  return { api, state, definitions };
}

test('discovery and item reads paginate definitions, field values and labels', async () => {
  const { api, state } = mockApi({ multipleSeverity: true });
  const context = await discover(api);
  assert.equal(context.fields.Size.id, 'field-Size');
  const item = await readItem(api, 'item', context);
  assert.equal(item.fields.Size, 'L');
  assert.deepEqual(item.labels, ['severity: none', 'severity: high']);
  assert.equal(eligible(item), false);
  assert.deepEqual([...state.pages].sort(), [
    'definitions-0',
    'definitions-1',
    'labels-0',
    'labels-1',
    'values-0',
    'values-1',
  ]);
});

test('dry-run discovers every item page and never mutates; apply is idempotent', async () => {
  const { api, state } = mockApi();
  assert.deepEqual(await reconcile({ api, log: () => {} }), {
    candidates: 1,
    updated: 0,
  });
  assert.equal(state.mutations.length, 0);
  assert.ok(state.pages.has('items-1'));
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
    assert.equal(state.reads, 2);
    assert.equal(state.mutations.length, 0);
  }
});

test('issue filter limits dry-run and apply to the requested issue and leaves another eligible issue untouched', async () => {
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
    assert.deepEqual(state.readItems, [selectedId, selectedId]);
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

test('a missing issue filter match reads no individual issue metadata and performs no writes', async () => {
  const { api, state } = mockApi({ additionalIssue: true });
  assert.deepEqual(
    await reconcile({ api, issueNumber: 3, dryRun: false, log: () => {} }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(state.readItems, []);
  assert.deepEqual(state.mutations, []);
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

// Every directory under packages/ that holds a package.json is an npm
// workspace and needs a `package: <directory>` label so issues and PRs can
// name it. A directory without a package.json is not a workspace yet, so a
// pull request that adds only `packages/<new>/README.md` stays docs-only and
// does not fail this test on the next push to main.
function workspacesWithoutLabels(directories, labels) {
  const names = new Set(labels.map((label) => label.name));
  return directories.filter((name) => !names.has(`package: ${name}`));
}

function workspaceDirectories(root = new URL('../packages/', import.meta.url)) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(new URL(`${entry.name}/package.json`, root)),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

test('every workspace under packages/ has a package label', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(manifest.workspaces, ['packages/*']);
  const { labels } = JSON.parse(
    readFileSync(new URL('../.github/labels.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(workspacesWithoutLabels(workspaceDirectories(), labels), []);
  for (const label of labels.filter(({ name }) => name.startsWith('package:')))
    assert.match(label.name, /^package: [a-z0-9][a-z0-9-]*$/);
});

test('a workspace without a package label is reported', () => {
  const labels = [{ name: 'package: api' }, { name: 'area: repository' }];
  assert.deepEqual(workspacesWithoutLabels(['api'], labels), []);
  assert.deepEqual(workspacesWithoutLabels(['api', 'web'], labels), ['web']);
  assert.deepEqual(workspacesWithoutLabels(['repository'], labels), [
    'repository',
  ]);
});

test('only directories with a package.json count as workspaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'prismatic-packages-'));
  try {
    const url = pathToFileURL(`${root}/`);
    assert.deepEqual(workspaceDirectories(url), []);
    mkdirSync(join(root, 'web'));
    writeFileSync(join(root, 'web', 'package.json'), '{}');
    mkdirSync(join(root, 'api'));
    writeFileSync(join(root, 'api', 'package.json'), '{}');
    mkdirSync(join(root, 'docs-only'));
    writeFileSync(join(root, 'docs-only', 'README.md'), '# Draft\n');
    mkdirSync(join(root, 'empty'));
    writeFileSync(join(root, 'notes.md'), '# Notes\n');
    assert.deepEqual(workspaceDirectories(url), ['api', 'web']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing packages directory has no workspaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'prismatic-packages-'));
  try {
    assert.deepEqual(
      workspaceDirectories(pathToFileURL(join(root, 'packages') + '/')),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('label descriptions do not name OpenTofu or Terraform', () => {
  const { labels } = JSON.parse(
    readFileSync(new URL('../.github/labels.json', import.meta.url), 'utf8'),
  );
  for (const label of labels)
    assert.doesNotMatch(label.description, /OpenTofu|Terraform/, label.name);
});
