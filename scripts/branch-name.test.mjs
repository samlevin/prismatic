import assert from 'node:assert/strict';
import test from 'node:test';
import {
  branchName,
  isCanonicalBranch,
  isExemptBranch,
  run,
  slugify,
} from './branch-name.mjs';

test('slugify lowercases and collapses punctuation', () => {
  assert.equal(slugify('Fix: the  API (v2)!'), 'fix-the-api-v2');
  assert.equal(slugify('--Hello, World--'), 'hello-world');
});

test('slugify cuts at 40 characters on a word boundary', () => {
  assert.equal(
    slugify('Generate and enforce branch names from the issue number'),
    'generate-and-enforce-branch-names-from',
  );
  assert.equal(slugify(`${'a'.repeat(39)} bb`), 'a'.repeat(39));
  assert.equal(slugify(`${'a'.repeat(37)} bb`), `${'a'.repeat(37)}-bb`);
  assert.equal(slugify('x'.repeat(60)), 'x'.repeat(40));
});

test('slugify is stable for numbers and Unicode', () => {
  assert.equal(slugify('Café résumé 2024'), 'cafe-resume-2024');
  assert.equal(slugify('日本語 only'), 'only');
  assert.equal(slugify('日本語'), '');
  assert.equal(slugify('Add 3 retries'), 'add-3-retries');
});

test('canonical names accept layers and reject other shapes', () => {
  for (const name of [
    'agent/48-generate',
    'samlevin/7-a-b-part-2',
    'agent/1-x-part-12',
  ])
    assert.ok(isCanonicalBranch(name), name);
  for (const name of [
    'agent/foo',
    'agent/0-x',
    'agent/01-x',
    'Agent/1-x',
    'agent/1-x-',
    'agent/1--x',
    'main',
    '',
    undefined,
  ])
    assert.ok(!isCanonicalBranch(name), String(name));
});

test('automation branches are exempt', () => {
  assert.ok(isExemptBranch('release-please--branches--main'));
  assert.ok(isExemptBranch('dependabot/npm_and_yarn/x'));
  assert.ok(!isExemptBranch('agent/1-x'));
});

test('branchName applies actor and layer', () => {
  assert.equal(
    branchName({ issue: '48', title: 'Do a Thing' }),
    'agent/48-do-a-thing',
  );
  assert.equal(
    branchName({ issue: 48, title: 'Do a Thing', actor: 'SamLevin', layer: 3 }),
    'samlevin/48-do-a-thing-part-3',
  );
  assert.equal(
    branchName({ issue: 48, title: 'Do a Thing', layer: 1 }),
    'agent/48-do-a-thing',
  );
  assert.throws(() => branchName({ issue: 'x', title: 'a' }));
  assert.throws(() => branchName({ issue: 1, title: '日本語' }));
  assert.throws(() => branchName({ issue: 1, title: 'a', actor: 'a/b' }));
  assert.throws(() => branchName({ issue: 1, title: 'a', layer: 0 }));
});

test('run generates and checks without calling GitHub', () => {
  const title = () => 'Do a Thing';
  assert.equal(run(['5'], { title }), 'agent/5-do-a-thing');
  assert.equal(
    run(['5', '--actor', 'sam', '--layer', '2'], { title }),
    'sam/5-do-a-thing-part-2',
  );
  assert.match(run(['--check', 'agent/5-x']), /valid/);
  assert.match(run(['--check'], { current: () => 'agent/5-x' }), /valid/);
  assert.match(run(['--check', 'dependabot/npm/x']), /Skipping/);
  assert.throws(() => run(['--check', 'agent/foo']), /must be/);
  assert.throws(() => run(['--check'], { current: () => 'main' }), /must be/);
  assert.throws(() => run([]), /Usage/);
  assert.throws(() => run(['1', '--bogus']), /Unknown/);
});

test('run rejects non-numeric issues before calling GitHub', () => {
  const title = () => assert.fail('GitHub must not be called');
  for (const value of ['-w', '--foo', 'abc', '0', '1x'])
    assert.throws(() => run([value], { title }), /Issue must be|Unknown/);
  assert.throws(() => run(['-w'], { title }), /Issue must be a positive/);
});

test('options that need a value reject a missing one', () => {
  const title = () => 'x';
  assert.throws(() => run(['5', '--actor'], { title }), /requires a value/);
  assert.throws(() => run(['5', '--layer'], { title }), /requires a value/);
  assert.throws(
    () => run(['5', '--actor', '--layer', '2'], { title }),
    /requires a value/,
  );
  assert.throws(
    () => run(['5', '--layer', '--check'], { title }),
    /requires a value/,
  );
});
