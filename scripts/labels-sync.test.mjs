import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionPrune, planLabelSync } from './labels-sync.mjs';

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

test('prune skips labels still in use and deletes unused ones', () => {
  const used = { name: 'used' };
  const unused = { name: 'unused' };
  const counts = new Map([
    ['used', 3],
    ['unused', 0],
  ]);
  assert.deepEqual(partitionPrune([used, unused], counts), {
    delete: [unused],
    skip: [used],
  });
});

test('never deletes a live autorelease: tagged label absent from the file', () => {
  const plan = planLabelSync(
    [bug],
    [bug, { name: 'autorelease: tagged', color: 'ededed' }],
  );
  assert.deepEqual(plan.delete, []);
});
