import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { workflow, workflowDirectory } from './workflow-test-helpers.mjs';

// Workflow files are <area>-<name>.yml and the workflow is named
// `<Area>: <name>`. CONTRIBUTING.md describes the convention.
const AREAS = { ci: 'CI', tracker: 'Tracker' };

const files = readdirSync(workflowDirectory).sort();
const definitions = new Map(files.map((file) => [file, workflow(file)]));
const triggers = ({ on }) =>
  typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on);

test('workflow files, workflow names, and job names match the convention', () => {
  assert.deepEqual(
    Object.fromEntries(
      [...definitions].map(([file, definition]) => [
        file,
        {
          name: definition.name,
          jobs: Object.fromEntries(
            Object.entries(definition.jobs).map(([id, job]) => [id, job.name]),
          ),
        },
      ]),
    ),
    {
      'ci-checks.yml': {
        name: 'CI: checks',
        jobs: {
          'detect-changes': 'Detect changed areas',
          'run-checks': 'Run checks selected for the changed files',
          'require-scoped-checks':
            'Require every check selected for the changed files',
        },
      },
      'ci-pr-title.yml': {
        name: 'CI: PR title',
        jobs: {
          'check-pr-title': 'Check PR title follows Conventional Commits',
        },
      },
      'ci-secret-scan.yml': {
        name: 'CI: secret scan',
        jobs: { 'scan-secrets': 'Scan commits for secrets' },
      },
      'tracker-issue-states.yml': {
        name: 'Tracker: reconcile issue states',
        jobs: { 'reconcile-issues': 'Reconcile issue project states' },
      },
      'tracker-pr-issue-status.yml': {
        name: 'Tracker: move closing issues to In review',
        jobs: { 'mark-issues-in-review': 'Move closing issues to In review' },
      },
      'tracker-pr-metadata.yml': {
        name: 'Tracker: copy issue metadata to PR',
        jobs: { 'copy-issue-metadata': 'Copy linked issue metadata to PR' },
      },
    },
  );
  for (const [file, definition] of definitions) {
    const match = file.match(/^([a-z]+)-[a-z0-9]+(?:-[a-z0-9]+)*\.yml$/);
    assert.ok(match, `${file} is not <area>-<name>.yml`);
    const area = AREAS[match[1]];
    assert.ok(area, `${file} has unknown area ${match[1]}`);
    assert.match(
      definition.name,
      new RegExp(`^${area}: \\S`),
      `${file} name must be "${area}: <name>"`,
    );
  }
});

test('every job and step has a sentence-case name and a kebab-case ID', () => {
  for (const [file, definition] of definitions) {
    for (const [id, job] of Object.entries(definition.jobs)) {
      const where = `${file} ${id}`;
      assert.match(id, /^[a-z]+(?:-[a-z]+)*$/, `${where} ID`);
      assert.equal(typeof job.name, 'string', `${where} has no name`);
      assert.match(job.name, /^[A-Z]/, `${where} name`);
      for (const [index, step] of (job.steps ?? []).entries()) {
        assert.equal(
          typeof step.name,
          'string',
          `${where} step ${index + 1} (${step.uses ?? step.run}) has no name`,
        );
        assert.match(step.name, /^[A-Z]/, `${where} step ${step.name}`);
      }
    }
  }
});

test('workflows not started by a pull request or push name their subject', () => {
  for (const [file, definition] of definitions) {
    const events = triggers(definition);
    if (events.includes('pull_request') || events.includes('push')) continue;
    assert.equal(typeof definition['run-name'], 'string', file);
    assert.match(definition['run-name'], /\$\{\{/, file);
  }
});

test('required status check candidates keep their names', () => {
  // These are the jobs the main ruleset should require. Renaming one needs a
  // matching ruleset change at merge once the ruleset requires it.
  for (const [file, id, name] of [
    [
      'ci-checks.yml',
      'require-scoped-checks',
      'Require every check selected for the changed files',
    ],
    ['ci-secret-scan.yml', 'scan-secrets', 'Scan commits for secrets'],
    [
      'ci-pr-title.yml',
      'check-pr-title',
      'Check PR title follows Conventional Commits',
    ],
  ]) {
    const job = definitions.get(file).jobs[id];
    assert.equal(job.name, name, `${file} ${id}`);
    assert.equal(job.strategy, undefined, `${file} ${id} must not be a matrix`);
  }
});

test('tracker workflows keep their triggers, permissions, secrets, concurrency, and scripts', () => {
  const contract = (file) => {
    const definition = definitions.get(file);
    const [job] = Object.values(definition.jobs);
    return {
      on: definition.on,
      permissions: definition.permissions,
      concurrency: definition.concurrency,
      if: job.if,
      steps: job.steps.map(({ uses, with: inputs, env, run }) => ({
        uses,
        with: inputs,
        env,
        run,
      })),
    };
  };
  const checkout = {
    uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    with: {
      ref: '${{ github.event.repository.default_branch }}',
      'persist-credentials': false,
      'sparse-checkout': 'scripts',
    },
    env: undefined,
    run: undefined,
  };
  const node = {
    uses: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    with: { 'node-version': '22.16.0' },
    env: undefined,
    run: undefined,
  };
  const token = '${{ secrets.PRISMATIC_PROJECT_TOKEN }}';
  const dispatchDryRun =
    "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && 'true' || 'false' }}";
  assert.deepEqual(contract('tracker-issue-states.yml'), {
    on: {
      issues: {
        types: [
          'opened',
          'reopened',
          'closed',
          'edited',
          'labeled',
          'unlabeled',
        ],
      },
      schedule: [{ cron: '7,22,37,52 * * * *' }],
      workflow_dispatch: {
        inputs: {
          dry_run: {
            description:
              'Preview metadata and container completion without writes',
            type: 'boolean',
            default: true,
          },
        },
      },
    },
    permissions: { contents: 'read' },
    concurrency: {
      group: 'prismatic-issue-triage',
      'cancel-in-progress': false,
    },
    if: "github.repository == 'samlevin/prismatic' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    steps: [
      checkout,
      node,
      {
        uses: undefined,
        with: undefined,
        env: { PRISMATIC_PROJECT_TOKEN: token, DRY_RUN: dispatchDryRun },
        run: 'node scripts/issue-triage.mjs\nnode scripts/issue-containers.mjs\n',
      },
    ],
  });
  const prEvents = {
    types: ['opened', 'edited', 'reopened', 'ready_for_review'],
  };
  assert.deepEqual(contract('tracker-pr-issue-status.yml'), {
    on: { pull_request_target: prEvents },
    permissions: { contents: 'read' },
    concurrency: {
      group: 'pr-issue-status-${{ github.event.pull_request.number }}',
      'cancel-in-progress': false,
    },
    if: "github.repository == 'samlevin/prismatic' && !github.event.pull_request.draft",
    steps: [
      checkout,
      node,
      {
        uses: undefined,
        with: undefined,
        env: {
          PRISMATIC_PROJECT_TOKEN: token,
          PR_NUMBER: '${{ github.event.pull_request.number }}',
          PR_ACTION: '${{ github.event.action }}',
          DRY_RUN: 'false',
        },
        run: 'node scripts/issue-pr-status.mjs',
      },
    ],
  });
  const prNumber =
    '${{ github.event.pull_request.number || inputs.pull_request }}';
  assert.deepEqual(contract('tracker-pr-metadata.yml'), {
    on: {
      pull_request_target: prEvents,
      workflow_dispatch: {
        inputs: {
          pull_request: {
            description: 'Pull request number to reconcile',
            required: true,
            type: 'string',
          },
          dry_run: {
            description: 'Preview metadata without writes',
            type: 'boolean',
            default: true,
          },
        },
      },
    },
    permissions: { contents: 'read' },
    concurrency: {
      group:
        'pr-issue-metadata-${{ github.event.pull_request.number || inputs.pull_request }}',
      'cancel-in-progress': false,
    },
    if: "github.repository == 'samlevin/prismatic' && (github.event_name == 'pull_request_target' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch))",
    steps: [
      checkout,
      node,
      {
        uses: undefined,
        with: undefined,
        env: {
          PRISMATIC_PROJECT_TOKEN: token,
          PR_NUMBER: prNumber,
          DRY_RUN: dispatchDryRun,
        },
        run: 'node scripts/issue-pr-metadata.mjs',
      },
    ],
  });
});

test('every pinned Node version matches .tool-versions', () => {
  const pinned = readFileSync(
    new URL('../.tool-versions', import.meta.url),
    'utf8',
  ).match(/^nodejs (\S+)$/m)?.[1];
  assert.match(pinned ?? '', /^\d+\.\d+\.\d+$/);
  for (const [file, definition] of definitions)
    for (const job of Object.values(definition.jobs))
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith('actions/setup-node@')) continue;
        if (step.with['node-version-file'] !== undefined)
          assert.equal(step.with['node-version-file'], '.tool-versions', file);
        else assert.equal(step.with['node-version'], pinned, file);
      }
});
