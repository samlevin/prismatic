import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  evaluate,
  workflow,
  workflowDirectory,
} from './workflow-test-helpers.mjs';

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
        name: 'Tracker: copy issue labels, assignees, and milestone to PR',
        jobs: {
          'copy-issue-metadata':
            'Copy linked issue labels, assignees, and milestone to PR',
        },
      },
      'tracker-project-membership.yml': {
        name: 'Tracker: add issues to the project',
        jobs: { 'add-to-project': 'Add issues to the project' },
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
      ...(job.env && { env: job.env }),
      steps: job.steps.map(
        ({ if: condition, uses, with: inputs, env, run }) => ({
          ...(condition && { if: condition }),
          uses,
          with: inputs,
          env,
          run,
        }),
      ),
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
    with: { 'node-version': '24.22.0' },
    env: undefined,
    run: undefined,
  };
  const token = '${{ secrets.PRISMATIC_PROJECT_TOKEN }}';
  const dispatchDryRun =
    "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && 'true' || 'false' }}";
  const scoped = (script) =>
    [
      'if [ -n "$ISSUE_NUMBER" ]; then set -- --issue "$ISSUE_NUMBER"; fi',
      `node scripts/${script} "$@"`,
      '',
    ].join('\n');
  const afterNode = "${{ !cancelled() && steps.node.outcome == 'success' }}";
  assert.deepEqual(contract('tracker-issue-states.yml'), {
    on: {
      issues: {
        types: ['reopened', 'closed', 'labeled', 'unlabeled'],
      },
      schedule: [{ cron: '7 * * * *' }],
      workflow_dispatch: {
        inputs: {
          dry_run: {
            description:
              'Preview project membership, metadata, and container completion without writes',
            type: 'boolean',
            default: true,
          },
        },
      },
    },
    permissions: { contents: 'read' },
    concurrency: {
      group:
        "prismatic-issue-triage-${{ github.event.issue.number || 'sweep' }}",
      'cancel-in-progress': false,
    },
    if: [
      "github.repository == 'samlevin/prismatic' &&",
      "github.ref == format('refs/heads/{0}', github.event.repository.default_branch) &&",
      "(github.event_name != 'issues' ||",
      "github.event.action == 'reopened' ||",
      "github.event.action == 'closed' ||",
      "startsWith(github.event.label.name, 'severity:') ||",
      "github.event.label.name == 'epic' ||",
      "github.event.label.name == 'automation: container-closed' ||",
      "contains(github.event.issue.labels.*.name, 'epic'))",
    ].join(' '),
    env: {
      DRY_RUN: dispatchDryRun,
      ISSUE_NUMBER: '${{ github.event.issue.number }}',
    },
    steps: [
      checkout,
      node,
      {
        if: "${{ github.event_name != 'issues' && !cancelled() && steps.node.outcome == 'success' }}",
        uses: undefined,
        with: undefined,
        env: { PRISMATIC_PROJECT_TOKEN: token },
        run: 'node scripts/issue-project-membership.mjs --sweep',
      },
      {
        if: afterNode,
        uses: undefined,
        with: undefined,
        env: { PRISMATIC_PROJECT_TOKEN: token },
        run: scoped('issue-triage.mjs'),
      },
      {
        if: afterNode,
        uses: undefined,
        with: undefined,
        env: { PRISMATIC_PROJECT_TOKEN: token },
        run: scoped('issue-containers.mjs'),
      },
    ],
  });
  const prEvents = {
    types: ['opened', 'edited', 'reopened', 'ready_for_review'],
  };
  const bodyEdits =
    "(github.event.action != 'edited' || github.event.changes.body)";
  assert.deepEqual(contract('tracker-pr-issue-status.yml'), {
    on: { pull_request_target: prEvents },
    permissions: { contents: 'read' },
    concurrency: {
      group: 'pr-issue-status-${{ github.event.pull_request.number }}',
      'cancel-in-progress': false,
    },
    if: `github.repository == 'samlevin/prismatic' && !github.event.pull_request.draft && ${bodyEdits}`,
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
            description:
              'Preview labels, assignees, and milestone without writes',
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
    if: `github.repository == 'samlevin/prismatic' && (github.event_name == 'pull_request_target' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch)) && ${bodyEdits}`,
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
  const eventNumber = '${{ github.event.issue.number }}';
  assert.deepEqual(contract('tracker-project-membership.yml'), {
    on: {
      issues: { types: ['opened'] },
      workflow_dispatch: {
        inputs: {
          dry_run: {
            description: 'Preview the missing issues without adding them',
            type: 'boolean',
            default: true,
          },
        },
      },
    },
    permissions: { contents: 'read' },
    concurrency: {
      group: "project-membership-${{ github.event.issue.number || 'sweep' }}",
      'cancel-in-progress': false,
    },
    if: "github.repository == 'samlevin/prismatic' && (github.event_name == 'issues' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch))",
    steps: [
      checkout,
      node,
      {
        if: "github.event_name == 'issues'",
        uses: undefined,
        with: undefined,
        env: {
          PRISMATIC_PROJECT_TOKEN: token,
          ISSUE_NUMBER: eventNumber,
          DRY_RUN: 'false',
        },
        run: 'node scripts/issue-project-membership.mjs',
      },
      {
        if: "github.event_name == 'issues'",
        uses: undefined,
        with: undefined,
        env: { PRISMATIC_PROJECT_TOKEN: token, ISSUE_NUMBER: eventNumber },
        run: 'node scripts/issue-triage.mjs --apply --issue "$ISSUE_NUMBER"',
      },
      {
        if: "github.event_name != 'issues'",
        uses: undefined,
        with: undefined,
        env: { PRISMATIC_PROJECT_TOKEN: token, DRY_RUN: dispatchDryRun },
        run: 'node scripts/issue-project-membership.mjs --sweep',
      },
    ],
  });
});

test('project membership adds and triages one issue when it opens and sweeps on dispatch', () => {
  const definition = definitions.get('tracker-project-membership.yml');
  const job = definition.jobs['add-to-project'];
  const format = (template, ...values) =>
    template.replace(/\{(\d+)\}/g, (_, index) => values[index]);
  const interpolate = (text, values) =>
    text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) =>
      evaluate(expression, values),
    );
  const start = (eventName, { event = {}, inputs = {}, ref } = {}) => {
    const values = {
      format,
      inputs,
      github: {
        repository: 'samlevin/prismatic',
        ref: ref ?? 'refs/heads/main',
        event_name: eventName,
        // Actions reads a property of a missing object as null, so `issue: {}`
        // stands in for the absent issue on schedule and dispatch events.
        event: { repository: { default_branch: 'main' }, issue: {}, ...event },
      },
    };
    return {
      name: interpolate(definition['run-name'], values),
      group: interpolate(definition.concurrency.group, values),
      runs: evaluate(job.if, values),
      steps: job.steps
        .filter((step) => step.if && evaluate(step.if, values))
        .map((step) => ({
          run: step.run,
          ...(step.env.DRY_RUN && {
            dryRun: interpolate(step.env.DRY_RUN, values),
          }),
        })),
    };
  };
  assert.deepEqual(start('issues', { event: { issue: { number: 41 } } }), {
    name: 'Add issue #41 to the project',
    group: 'project-membership-41',
    runs: true,
    steps: [
      { run: 'node scripts/issue-project-membership.mjs', dryRun: 'false' },
      { run: 'node scripts/issue-triage.mjs --apply --issue "$ISSUE_NUMBER"' },
    ],
  });
  const sweep = 'node scripts/issue-project-membership.mjs --sweep';
  for (const [dryRunInput, dryRun] of [
    [true, 'true'],
    [false, 'false'],
  ])
    assert.deepEqual(
      start('workflow_dispatch', { inputs: { dry_run: dryRunInput } }),
      {
        name: 'Add missing issues to the project (workflow_dispatch)',
        group: 'project-membership-sweep',
        runs: true,
        steps: [{ run: sweep, dryRun }],
      },
    );
  assert.equal(
    start('workflow_dispatch', {
      inputs: { dry_run: false },
      ref: 'refs/heads/feature',
    }).runs,
    false,
  );
});

test('workflows started by pull_request_target never check out or run pull request code', () => {
  for (const [file, definition] of definitions) {
    if (!triggers(definition).includes('pull_request_target')) continue;
    for (const [id, job] of Object.entries(definition.jobs))
      for (const step of job.steps ?? []) {
        const where = `${file} ${id} ${step.name}`;
        if (step.uses?.startsWith('actions/checkout@')) {
          assert.equal(
            step.with?.ref,
            '${{ github.event.repository.default_branch }}',
            where,
          );
          assert.equal(step.with['persist-credentials'], false, where);
          assert.equal(step.with['sparse-checkout'], 'scripts', where);
        }
        assert.doesNotMatch(
          JSON.stringify(step),
          /github\.event\.pull_request\.(?:head|merge_commit_sha|title|body)|github\.head_ref/,
          where,
        );
      }
  }
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
