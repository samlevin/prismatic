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

test('prune skips labels in use and deletes only confirmed unused ones', () => {
  const used = { name: 'used' };
  const unused = { name: 'unused' };
  const unknown = { name: 'unknown' };
  const usages = new Map([
    ['used', 'used'],
    ['unused', 'unused'],
    ['unknown', 'unknown'],
  ]);
  assert.deepEqual(
    partitionPrune([used, unused, unknown, { name: 'x' }], usages),
    {
      delete: [unused],
      skip: [used, unknown, { name: 'x' }],
    },
  );
});

test('never deletes a live autorelease: tagged label absent from the file', () => {
  const plan = planLabelSync(
    [bug],
    [bug, { name: 'autorelease: tagged', color: 'ededed' }],
  );
  assert.deepEqual(plan.delete, []);
});

test('usage queries issues by encoded label and reads the array', () => {
  const urls = [];
  const api = (args) => {
    urls.push(args[0]);
    return urls.length === 1 ? '[]' : '[{"number":1}]';
  };
  assert.equal(usage('say "hi" & more', api), 'unused');
  assert.equal(usage('old', api), 'used');
  assert.ok(
    urls[0].endsWith(
      `issues?labels=${encodeURIComponent('say "hi" & more')}&state=all&per_page=1`,
    ),
  );
});

test('usage keeps the label when the lookup fails instead of aborting', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const found = usage('old', () => {
    throw new Error('GitHub request failed');
  });
  assert.equal(found, 'unknown');
  assert.deepEqual(
    partitionPrune([{ name: 'old' }], new Map([['old', found]])),
    { delete: [], skip: [{ name: 'old' }] },
  );
  assert.equal(
    log.mock.calls[0].arguments[0],
    'skip delete (lookup failed): old',
  );
});
