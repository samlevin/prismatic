import assert from 'node:assert/strict';
import test from 'node:test';
import { branchName, isCanonicalBranch, run, slugify } from './branch-name.mjs';

// Adapts a number-to-issue stub to the ghRest call shape.
const asApi = (fetch) => (args) =>
  JSON.stringify(fetch(args[0].split('/').pop()));
const issue = (title) => () => ({ title, state: 'open' });

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
  assert.equal(slugify('日本語'), 'issue');
  assert.equal(slugify('!!!'), 'issue');
  assert.equal(slugify('Add 3 retries'), 'add-3-retries');
});

test('titles that mention "part N" never read as a layer suffix', () => {
  assert.equal(branchName({ issue: 1, title: 'Part 2' }), 'agent/1-part2');
  assert.equal(
    branchName({ issue: 5, title: 'Support part 2 of the spec' }),
    'agent/5-support-part2-of-the-spec',
  );
  assert.equal(
    branchName({ issue: 5, title: 'Handle invoice part 3', layer: 2 }),
    'agent/5-handle-invoice-part3-part-2',
  );
  assert.equal(slugify('A part of the plan'), 'a-part-of-the-plan');
});

test('canonical names accept layers and reject other shapes', () => {
  for (const name of [
    'agent/48-generate',
    'samlevin/7-a-b-part-2',
    'agent/1-x-part-12',
    'a-b/1-x',
  ])
    assert.ok(isCanonicalBranch(name), name);
  for (const name of [
    'agent/foo',
    'agent/0-x',
    'agent/01-x',
    'Agent/1-x',
    'agent/1-x-',
    'agent/1-x-part-1',
    'agent/1-x-part-01',
    'agent/1-x-part-2-part-3',
    'agent/1-x-part-2-y',
    '-agent/1-x',
    'agent-/1-x',
    'agent/1-part-2',
    'agent/1--x',
    'main',
    '',
    undefined,
  ])
    assert.ok(!isCanonicalBranch(name), String(name));
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
  assert.equal(branchName({ issue: 1, title: '日本語' }), 'agent/1-issue');
  assert.throws(() => branchName({ issue: 'x', title: 'a' }));
  assert.throws(() => branchName({ issue: 1, title: 'a', layer: 0 }));
  for (const actor of ['a/b', 'foo-', '-foo'])
    assert.throws(
      () => branchName({ issue: 1, title: 'a', actor }),
      /Actor must be a GitHub login/,
      actor,
    );
});

test('run prints the name from the issue title', () => {
  const api = asApi(issue('Do a Thing'));
  assert.equal(run(['5'], { api }), 'agent/5-do-a-thing');
  assert.equal(
    run(['5', '--actor', 'sam', '--layer', '2'], { api }),
    'sam/5-do-a-thing-part-2',
  );
  assert.throws(() => run([], { api }), /Usage/);
  assert.throws(() => run(['1', '2'], { api }), /Too many arguments/);
  assert.throws(() => run(['1', '--check'], { api }), /Unknown option/);
});

test('run rejects non-numeric issues before calling GitHub', () => {
  const api = asApi(() => assert.fail('GitHub must not be called'));
  for (const value of ['-w', 'abc', '0', '1x'])
    assert.throws(() => run([value], { api }), /Issue must be a positive/);
});

test('options that need a value reject a missing one', () => {
  const api = asApi(issue('x'));
  for (const argv of [
    ['5', '--actor'],
    ['5', '--layer'],
    ['5', '--actor', '--layer', '2'],
  ])
    assert.throws(() => run(argv, { api }), /requires a value/);
});

test('--layer accepts only canonical positive integers', () => {
  const api = asApi(issue('x'));
  for (const value of ['0x10', '1e1', ' 2 ', '01', '0', '-1', '1.5', 'abc'])
    assert.throws(
      () => run(['5', '--layer', value], { api }),
      /--layer requires a positive integer/,
      value,
    );
  assert.equal(run(['5', '--layer', '2'], { api }), 'agent/5-x-part-2');
});

test('run rejects pull requests, missing issues, and blank titles', () => {
  assert.throws(
    () => run(['52'], { api: asApi(() => ({ title: 'x', pull_request: {} })) }),
    /#52 is a pull request, not an issue/,
  );
  for (const found of [{}, { title: '   ' }, { title: 5 }])
    assert.throws(
      () => run(['7'], { api: asApi(() => found) }),
      /has no title/,
    );
  assert.throws(() => run(['7'], { api: asApi(() => null) }), /not found/);
});

test('run maps a 404 and passes other GitHub failures through', () => {
  const fail = (httpStatus) => () => {
    throw Object.assign(new Error('GitHub request failed'), { httpStatus });
  };
  assert.throws(() => run(['9'], { api: fail(404) }), /Issue #9 was not found/);
  assert.throws(
    () => run(['9'], { api: fail(503) }),
    (error) =>
      error.message === 'GitHub request failed' && error.httpStatus === 503,
  );
});
