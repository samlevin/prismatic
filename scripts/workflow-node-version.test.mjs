import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { workflow, workflowDirectory } from './workflow-test-helpers.mjs';

test('every workflow reads the Node version from .tool-versions', () => {
  assert.match(
    readFileSync(new URL('../.tool-versions', import.meta.url), 'utf8'),
    /^nodejs \d+\.\d+\.\d+$/m,
  );
  const setups = [];
  for (const file of readdirSync(workflowDirectory))
    for (const [id, job] of Object.entries(workflow(file).jobs))
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith('actions/setup-node@')) continue;
        const where = `${file} ${id}`;
        assert.equal(
          step.with?.['node-version'],
          undefined,
          `${where} pins a Node version`,
        );
        assert.equal(step.with?.['node-version-file'], '.tool-versions', where);
        setups.push(file);
      }
  for (const file of [
    'ci-checks.yml',
    'tracker-issue-states.yml',
    'tracker-pr-issue-status.yml',
    'tracker-pr-metadata.yml',
    'tracker-project-membership.yml',
  ])
    assert.ok(setups.includes(file), `${file} sets up Node`);
});
