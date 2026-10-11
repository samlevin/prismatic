import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  branchName,
  isCanonicalBranch,
  isExemptBranch,
  run,
  slugify,
} from './branch-name.mjs';

// Adapts a number-to-issue stub to the ghApi call shape.
const asApi = (fetch) => (args) =>
  JSON.stringify(fetch(args[0].split('/').pop()));

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
    'a-b/1-x',
  ])
    assert.ok(isCanonicalBranch(name), name);
  for (const name of [
    'agent/foo',
    'agent/0-x',
    'agent/01-x',
    'Agent/1-x',
    'agent/1-x-',
    'agent/1-x-part-2-part-3',
    'agent/1-x-part-2-part-2',
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
  const issue = () => ({ title: 'Do a Thing' });
  assert.equal(run(['5'], { api: asApi(issue) }), 'agent/5-do-a-thing');
  assert.equal(
    run(['5', '--actor', 'sam', '--layer', '2'], { api: asApi(issue) }),
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
  const issue = () => assert.fail('GitHub must not be called');
  for (const value of ['-w', '--foo', 'abc', '0', '1x'])
    assert.throws(
      () => run([value], { api: asApi(issue) }),
      /Issue must be|Unknown/,
    );
  assert.throws(
    () => run(['-w'], { api: asApi(issue) }),
    /Issue must be a positive/,
  );
});

test('options that need a value reject a missing one', () => {
  const issue = () => ({ title: 'x' });
  assert.throws(
    () => run(['5', '--actor'], { api: asApi(issue) }),
    /requires a value/,
  );
  assert.throws(
    () => run(['5', '--layer'], { api: asApi(issue) }),
    /requires a value/,
  );
  assert.throws(
    () => run(['5', '--actor', '--layer', '2'], { api: asApi(issue) }),
    /requires a value/,
  );
  assert.throws(
    () => run(['5', '--layer', '--check'], { api: asApi(issue) }),
    /requires a value/,
  );
});

test('--require-issue accepts an existing issue', () => {
  const seen = [];
  const message = run(['--check', 'agent/48-foo', '--require-issue'], {
    api: asApi((number) => {
      seen.push(number);
      return { number: 48 };
    }),
  });
  assert.equal(message, 'Branch agent/48-foo is valid');
  assert.deepEqual(seen, ['48']);
});

test('--require-issue rejects a pull request number', () => {
  assert.throws(
    () =>
      run(['--check', 'agent/52-foo', '--require-issue'], {
        api: asApi(() => ({ number: 52, pull_request: {} })),
      }),
    /pull request, not an issue/,
  );
});

test('--require-issue rejects a missing issue', () => {
  const missing = () => {
    throw Object.assign(new Error('GitHub request failed'), {
      httpStatus: 404,
    });
  };
  assert.throws(
    () =>
      run(['--check', 'agent/9-foo', '--require-issue'], {
        api: asApi(missing),
      }),
    /not found/,
  );
  assert.throws(
    () =>
      run(['--check', 'agent/9-foo', '--require-issue'], {
        api: asApi(() => null),
      }),
    /not found/,
  );
});

test('--require-issue reports other GitHub failures without stderr', () => {
  const unavailable = () => {
    throw Object.assign(new Error('GitHub request failed'), {
      httpStatus: 503,
    });
  };
  assert.throws(
    () =>
      run(['--check', 'agent/9-foo', '--require-issue'], {
        api: asApi(unavailable),
      }),
    (error) =>
      error.message === 'GitHub request failed' &&
      !error.message.includes('secret'),
  );
});

test('generation rejects a pull request number', () => {
  assert.throws(
    () => run(['52'], { api: asApi(() => ({ title: 'x', pull_request: {} })) }),
    /Issue #52 is a pull request/,
  );
});

test('generation rejects a missing or blank title', () => {
  for (const found of [{}, { title: '   ' }, { title: 5 }, null])
    assert.throws(
      () => run(['7'], { api: asApi(() => found) }),
      /has no title/,
    );
});

test('--require-issue skips exempt branches and needs --check', () => {
  const never = () => assert.fail('must not fetch');
  assert.match(
    run(['--check', 'dependabot/npm/x', '--require-issue'], {
      api: asApi(never),
    }),
    /Skipping/,
  );
  assert.throws(() => run(['48', '--require-issue']), /needs --check/);
});

test('part suffixes only pass for layers 2 and up', () => {
  for (const name of [
    'agent/1-x-part-1',
    'agent/1-x-part-0',
    'agent/1-x-part-01',
  ])
    assert.equal(isCanonicalBranch(name), false, name);
  for (const name of [
    'agent/1-x-part-2',
    'agent/1-x-part-12',
    'agent/1-x',
    'a-b/1-x',
  ])
    assert.equal(isCanonicalBranch(name), true, name);
});

test('--actor and --layer only apply when generating', () => {
  assert.throws(
    () => run(['--check', 'agent/5-x', '--actor', 'sam']),
    /only apply when generating/,
  );
  assert.throws(
    () => run(['--check', '--layer', '2']),
    /only apply when generating/,
  );
});

test('generation maps 404 and other failures like --require-issue', () => {
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

test('a title that slugs to only part-N cannot be a branch', () => {
  assert.throws(
    () => branchName({ issue: 1, title: 'Part 2' }),
    /Not a valid branch/,
  );
});

test('--layer accepts only canonical positive integers', () => {
  const api = asApi(() => ({ title: 'x' }));
  for (const value of ['0x10', '1e1', ' 2 ', '01', '0', '-1', '1.5', 'abc'])
    assert.throws(
      () => run(['5', '--layer', value], { api }),
      /--layer requires a positive integer/,
      value,
    );
  assert.equal(run(['5', '--layer', '2'], { api }), 'agent/5-x-part-2');
});

test('a git failure reads as not inside a work tree', () => {
  const original = process.cwd();
  process.chdir(tmpdir());
  try {
    assert.throws(() => run(['--check']), /Not inside a git work tree/);
  } finally {
    process.chdir(original);
  }
});
