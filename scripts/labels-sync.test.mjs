import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionPrune, planLabelSync, usage } from './labels-sync.mjs';

const bug = { name: 'bug', color: 'd73a4a', description: 'Broken' };

test('creates labels missing from the repository', () => {
  const plan = planLabelSync([bug], []);
  assert.deepEqual(plan.create, [bug]);
  assert.deepEqual([plan.update, plan.delete, plan.unchanged], [[], [], []]);
});

test('updates changed description, ignoring color case', () => {
  const docs = { name: 'docs', color: 'ABCDEF', description: 'D' };
  const plan = planLabelSync(
    [bug, docs],
    [
      { ...bug, description: 'Old' },
      { name: 'docs', color: 'abcdef', description: 'D' },
    ],
  );
  assert.deepEqual(plan.update, [{ ...bug, current: 'bug' }]);
  assert.deepEqual(plan.unchanged, [docs]);
  assert.deepEqual(plan.create, []);
});

test('updates a changed color', () => {
  const plan = planLabelSync([bug], [{ ...bug, color: '000000' }]);
  assert.deepEqual(plan.update, [{ ...bug, current: 'bug' }]);
});

test('treats a missing live description as empty', () => {
  const wanted = { name: 'x', color: 'ffffff', description: '' };
  const plan = planLabelSync(
    [wanted],
    [{ name: 'x', color: 'ffffff', description: null }],
  );
  assert.deepEqual(plan.unchanged, [wanted]);
});

test('lists file-absent labels for deletion but never autorelease: pending', () => {
  const plan = planLabelSync(
    [bug],
    [
      bug,
      { name: 'type: task', color: '000000' },
      { name: 'autorelease: pending', color: 'ededed' },
    ],
  );
  assert.deepEqual(
    plan.delete.map((label) => label.name),
    ['type: task'],
  );
  assert.deepEqual(plan.unchanged, [bug]);
});

test('renames a label that differs only by name case', () => {
  const plan = planLabelSync([bug], [{ ...bug, name: 'Bug' }]);
  assert.deepEqual(plan.update, [{ ...bug, current: 'Bug' }]);
});

const found = (total_count, incomplete_results = false) => ({
  total_count,
  incomplete_results,
});

test('prune skips labels still in use and deletes unused ones', () => {
  const used = { name: 'used' };
  const unused = { name: 'unused' };
  const usages = new Map([
    ['used', found(3)],
    ['unused', found(0)],
  ]);
  assert.deepEqual(partitionPrune([used, unused], usages), {
    delete: [unused],
    skip: [used],
  });
});

test('prune never deletes when the usage search was incomplete or missing', () => {
  const timedOut = { name: 'timed-out' };
  const missing = { name: 'missing' };
  const usages = new Map([['timed-out', found(0, true)]]);
  assert.deepEqual(partitionPrune([timedOut, missing], usages), {
    delete: [],
    skip: [timedOut, missing],
  });
});

test('never deletes a live autorelease: tagged label absent from the file', () => {
  const plan = planLabelSync(
    [bug],
    [bug, { name: 'autorelease: tagged', color: 'ededed' }],
  );
  assert.deepEqual(plan.delete, []);
});

test('usage keeps labels whose name contains a quote without searching', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const search = () => assert.fail('search must not run');
  assert.deepEqual(usage('say "hi"', search), {
    total_count: null,
    incomplete_results: true,
  });
  assert.equal(
    log.mock.calls[0].arguments[0],
    'skip delete (name contains a quote): say "hi"',
  );
});

test('usage keeps the label when the search fails instead of aborting', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const search = () => {
    throw new Error('rate limited');
  };
  const found = usage('old', search);
  assert.deepEqual(found, { total_count: null, incomplete_results: true });
  assert.deepEqual(
    partitionPrune([{ name: 'old' }], new Map([['old', found]])),
    { delete: [], skip: [{ name: 'old' }] },
  );
  assert.equal(
    log.mock.calls[0].arguments[0],
    'skip delete (search failed): old',
  );
  const ok = usage('old', () =>
    JSON.stringify({ total_count: 0, incomplete_results: false }),
  );
  assert.deepEqual(ok, { total_count: 0, incomplete_results: false });
});
