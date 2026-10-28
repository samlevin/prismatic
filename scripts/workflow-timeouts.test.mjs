import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { workflow } from './workflow-test-helpers.mjs';

// A job that only calls a reusable workflow cannot set `timeout-minutes`, so
// the called workflow's jobs carry it. Every other job needs a positive whole
// number of minutes.
const missingTimeouts = (definition) =>
  Object.entries(definition.jobs)
    .filter(
      ([, job]) =>
        job.uses === undefined &&
        !(
          Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0
        ),
    )
    .map(([id]) => id);

test('missing timeouts are detected, except on reusable workflow calls', () => {
  assert.deepEqual(
    missingTimeouts({
      jobs: {
        bounded: { 'runs-on': 'ubuntu-latest', 'timeout-minutes': 5 },
        unbounded: { 'runs-on': 'ubuntu-latest' },
        zero: { 'runs-on': 'ubuntu-latest', 'timeout-minutes': 0 },
        call: { uses: './.github/workflows/_reusable.yml' },
      },
    }),
    ['unbounded', 'zero'],
  );
});

test('every workflow job that runs steps sets timeout-minutes', () => {
  const files = readdirSync(
    new URL('../.github/workflows/', import.meta.url),
  ).filter((file) => file.endsWith('.yml'));
  assert.ok(files.length > 0);
  for (const file of files)
    assert.deepEqual(
      missingTimeouts(workflow(file.replace(/\.yml$/, ''))),
      [],
      `${file} jobs without timeout-minutes`,
    );
});
