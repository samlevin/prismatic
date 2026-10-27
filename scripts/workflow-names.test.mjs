import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { workflow } from './workflow-test-helpers.mjs';

// The naming convention lives in CONTRIBUTING.md. Terrateam owns its workflow
// file and marks it DO NOT MODIFY, so it keeps the vendor's names.
const VENDOR_WORKFLOWS = ['terrateam.yml'];
const AREAS = {
  ci: 'CI',
  release: 'Release',
  delivery: 'Delivery',
  tracker: 'Tracker',
};

const files = readdirSync(new URL('../.github/workflows/', import.meta.url))
  .filter((file) => !VENDOR_WORKFLOWS.includes(file))
  .sort();
const definitions = new Map(
  files.map((file) => [file, workflow(file.replace(/\.yml$/, ''))]),
);
const triggers = ({ on }) =>
  typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on);

test('workflow files and names match the convention table', () => {
  assert.deepEqual(
    Object.fromEntries(
      [...definitions].map(([file, definition]) => [file, definition.name]),
    ),
    {
      'ci-checks.yml': 'CI: checks',
      'ci-pr-title.yml': 'CI: PR title',
      'ci-secret-scan.yml': 'CI: secret scan',
      'tracker-issue-states.yml': 'Tracker: reconcile issue states',
      'tracker-pr-issue-status.yml':
        'Tracker: move closing issues to In review',
      'tracker-pr-metadata.yml': 'Tracker: copy issue metadata to PR',
      'tracker-project-membership.yml': 'Tracker: add issues to the project',
    },
  );
  for (const [file, definition] of definitions) {
    const match = file.match(/^(_?)([a-z]+)-[a-z0-9]+(?:-[a-z0-9]+)*\.yml$/);
    assert.ok(match, `${file} is not <area>-<purpose>.yml`);
    const [, reusable, area] = match;
    assert.ok(AREAS[area], `${file} has unknown area ${area}`);
    assert.ok(
      definition.name.startsWith(`${AREAS[area]}: `),
      `${file} name must start with ${AREAS[area]}:`,
    );
    assert.equal(
      triggers(definition).includes('workflow_call'),
      reusable === '_',
      `${file}: only reusable workflows start with _`,
    );
    assert.equal(
      definition.name.endsWith(' (reusable)'),
      reusable === '_',
      `${file}: only reusable workflow names end with (reusable)`,
    );
  }
});

test('every job and step has a sentence-case name and a kebab-case ID', () => {
  // A name may be an expression, such as a matrix or input value, but the
  // literal text must start with a capital letter.
  const sentence = /^(?:\$\{\{.*\}\}|[A-Z])/;
  for (const [file, definition] of definitions) {
    for (const [id, job] of Object.entries(definition.jobs)) {
      const where = `${file} ${id}`;
      assert.match(id, /^[a-z]+(?:-[a-z]+)*$/, `${where} ID`);
      assert.equal(typeof job.name, 'string', `${where} has no name`);
      assert.match(job.name, sentence, `${where} name`);
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

test('names write the environments as dev and prod', () => {
  for (const [file, definition] of definitions) {
    const names = [
      definition.name,
      definition['run-name'] ?? '',
      ...Object.values(definition.jobs).flatMap((job) => [
        job.name,
        ...(job.steps ?? []).map((step) => step.name),
      ]),
    ];
    for (const name of names)
      assert.doesNotMatch(name, /production/i, `${file}: ${name}`);
  }
});

test('workflows not started by a pull request or push name their subject', () => {
  for (const [file, definition] of definitions) {
    const events = triggers(definition);
    if (
      events.includes('workflow_call') ||
      events.includes('pull_request') ||
      events.includes('push')
    )
      continue;
    assert.equal(typeof definition['run-name'], 'string', file);
    assert.match(definition['run-name'], /\$\{\{/, file);
  }
});

test('workflow_run triggers name existing workflows', () => {
  const names = new Set(
    [...definitions.values()].map((definition) => definition.name),
  );
  for (const [file, definition] of definitions) {
    for (const name of definition.on.workflow_run?.workflows ?? [])
      assert.ok(names.has(name), `${file} waits for unknown workflow ${name}`);
  }
});

test('required status checks keep the names the main ruleset requires', () => {
  // Renaming one of these jobs needs a matching ruleset change at merge.
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
