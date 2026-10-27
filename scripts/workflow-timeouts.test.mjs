import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { workflow, workflowDirectory } from './workflow-test-helpers.mjs';

test('every workflow job has a timeout', () => {
  for (const file of readdirSync(workflowDirectory))
    for (const [id, job] of Object.entries(workflow(file).jobs)) {
      const minutes = job['timeout-minutes'];
      assert.ok(
        Number.isInteger(minutes) && minutes > 0,
        `${file} ${id} needs timeout-minutes`,
      );
    }
  assert.equal(
    workflow('ci-pr-title.yml').jobs['check-pr-title']['timeout-minutes'],
    5,
  );
  assert.equal(
    workflow('ci-secret-scan.yml').jobs['scan-secrets']['timeout-minutes'],
    10,
  );
});
