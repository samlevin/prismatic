import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isMap, isSeq, parseDocument } from 'yaml';

// A checkout keeps its token in the local Git config unless it sets
// `persist-credentials: false`. A checkout that must keep it for a later
// step in the same job carries a comment directly above it:
//   # persist-credentials: kept for "<later step name>"
const KEEP = /persist-credentials: kept for "([^"]+)"/;
const MISSING =
  'persists credentials: add `persist-credentials: false`, or put `# persist-credentials: kept for "<later step name>"` directly above it';

const isCheckout = (step) =>
  typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@');

const persistedCheckouts = (source) => {
  const document = parseDocument(source);
  const jobs = document.get('jobs');
  const problems = [];
  if (!isMap(jobs)) return problems;
  for (const { key, value: job } of jobs.items) {
    const steps = isMap(job) ? job.get('steps') : undefined;
    if (!isSeq(steps)) continue;
    steps.items.forEach((node, index) => {
      const step = node.toJSON();
      if (!isCheckout(step) || step.with?.['persist-credentials'] === false) {
        return;
      }
      const label = `${key.value} step ${index + 1} (${step.name ?? step.uses})`;
      // The parser attaches a comment above the first step to the list.
      const comments = [node.commentBefore, node.comment];
      if (index === 0) comments.push(steps.commentBefore);
      const kept = KEEP.exec(comments.filter(Boolean).join('\n'))?.[1];
      if (!kept) {
        problems.push(`${label} ${MISSING}`);
      } else if (
        !steps.items
          .slice(index + 1)
          .some((later) => later.get('name') === kept)
      ) {
        problems.push(`${label} names "${kept}", which is not a later step`);
      }
    });
  }
  return problems;
};

const workflows = new URL('../.github/workflows/', import.meta.url);

test('every workflow checkout drops its credentials or names the step that needs them', () => {
  const files = readdirSync(workflows).filter((file) => file.endsWith('.yml'));
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.deepEqual(
      persistedCheckouts(readFileSync(new URL(file, workflows), 'utf8')),
      [],
      file,
    );
  }
});

const job = (steps) => `jobs:\n  build:\n    steps:\n${steps}`;
const checkout =
  '      - name: Check out repository\n        uses: actions/checkout@0000000000000000000000000000000000000000 # v4\n';
const push = '      - name: Push tags\n        run: git push --tags\n';

test('a checkout without persist-credentials false and without a comment fails', () => {
  const [problem, ...rest] = persistedCheckouts(job(checkout + push));
  assert.deepEqual(rest, []);
  assert.equal(problem, `build step 1 (Check out repository) ${MISSING}`);
  // The message states both accepted fixes.
  assert.ok(problem.includes('`persist-credentials: false`'));
  assert.ok(problem.includes('# persist-credentials: kept for "'));
  assert.deepEqual(
    persistedCheckouts(
      job(`${checkout}        with:\n          persist-credentials: true\n`),
    ),
    [`build step 1 (Check out repository) ${MISSING}`],
  );
});

test('a checkout with persist-credentials false passes', () => {
  assert.deepEqual(
    persistedCheckouts(
      job(`${checkout}        with:\n          persist-credentials: false\n`),
    ),
    [],
  );
});

test('a kept checkout must name a later step in the same job', () => {
  const comment = (name) =>
    `      # persist-credentials: kept for "${name}"\n${checkout}`;
  assert.deepEqual(persistedCheckouts(job(comment('Push tags') + push)), []);
  assert.deepEqual(persistedCheckouts(job(comment('Missing step') + push)), [
    'build step 1 (Check out repository) names "Missing step", which is not a later step',
  ]);
  assert.deepEqual(persistedCheckouts(job(push + comment('Push tags'))), [
    'build step 2 (Check out repository) names "Push tags", which is not a later step',
  ]);
});
