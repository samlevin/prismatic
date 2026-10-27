import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { workflow, workflowDirectory } from './workflow-test-helpers.mjs';

// A checkout that keeps its credentials, keyed `<file> <job>`, with the reason
// a later step needs them, such as a push. None does today.
const PERSISTED = {};

test('checkouts drop their credentials unless a reason is recorded', () => {
  const persisted = [];
  for (const file of readdirSync(workflowDirectory))
    for (const [id, job] of Object.entries(workflow(file).jobs))
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith('actions/checkout@')) continue;
        const where = `${file} ${id}`;
        if (step.with?.['persist-credentials'] === false) continue;
        assert.ok(
          PERSISTED[where],
          `${where} must set persist-credentials: false or record why it persists them`,
        );
        persisted.push(where);
      }
  assert.deepEqual(persisted.sort(), Object.keys(PERSISTED).sort());
  assert.equal(
    workflow('ci-secret-scan.yml').jobs['scan-secrets'].steps[0].with[
      'persist-credentials'
    ],
    false,
  );
});
