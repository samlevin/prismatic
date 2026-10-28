import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliHelp, defineCli, parseCli } from './cli.cjs';
import { run as branch } from './branch-name.mjs';
import { configuration } from './issue-triage.mjs';

const cli = defineCli('Usage: example [options]', [
  'actor',
  'layer',
  'issue',
  'dry-run',
]);

test('exact aliases, equals forms, and values preserve their meaning', () => {
  for (const args of [
    ['--actor', 'sam', '--layer', '2', '--issue', '7'],
    ['-a', 'sam', '-l', '2', '-i', '7'],
    ['--actor=sam', '--layer=2', '--issue=7'],
    ['-a=sam', '-l=2', '-i=7'],
  ])
    assert.deepEqual(parseCli(args, cli).options, {
      actor: 'sam',
      layer: '2',
      issue: '7',
    });
  assert.deepEqual(parseCli(['-n'], cli).options, { 'dry-run': true });
  assert.deepEqual(parseCli(['-a=--layer=x', '--', '-l', '2', '--help'], cli), {
    options: { actor: '--layer=x' },
    positionals: ['-l', '2', '--help'],
  });
  assert.equal(parseCli(['-a', '-sam'], cli).options.actor, '-sam');
  assert.equal(
    parseCli(['-a', 'space = value'], cli).options.actor,
    'space = value',
  );
  assert.throws(() => parseCli(['-a='], cli), /requires a value/);
});

test('known spellings reject duplicates, missing values, grouped flags, and unknowns', () => {
  for (const args of [
    ['-a', 'sam', '--actor=other'],
    ['--layer', '2', '-l=2'],
    ['-n', '--dry-run'],
    ['--issue'],
    ['-i'],
    ['-a', '-l', '2'],
    ['-a', '--'],
    ['-a', '--unknown'],
    ['-actor=sam'],
    ['-asam'],
    ['-nl'],
    ['--unknown'],
    ['--dry-run=false'],
    ['-l='],
  ])
    assert.throws(() => parseCli(args, cli), /Usage: example/, args.join(' '));
  assert.throws(
    () => defineCli('Usage: undefined', ['reason']),
    /Undefined option reason/,
  );
  for (const flag of ['-h', '--help'])
    assert.throws(() => parseCli([flag], cli), CliHelp);
});

test('branch and tracker aliases preserve machine results and dry-run defaults', () => {
  const api = () => '{"title":"Example"}';
  assert.equal(
    branch(['-a=sam', '-l=2', '--', '285'], { api }),
    'sam/285-example-part-2',
  );
  assert.equal(branch(['285', '-l', '3'], { api }), 'agent/285-example-part-3');
  assert.throws(
    () =>
      branch(['--actor=sam', '-a=agent', '285'], {
        api: () => assert.fail('GitHub called'),
      }),
    /more than once/,
  );
  assert.deepEqual(configuration({}, ['-i=42', '-n']), {
    issueNumber: 42,
    dryRun: true,
  });
  assert.deepEqual(configuration({ DRY_RUN: 'false' }, ['-n']), {
    dryRun: true,
  });
  assert.deepEqual(configuration({}, ['--apply', '-i', '42']), {
    issueNumber: 42,
    dryRun: false,
  });
  assert.throws(
    () => configuration({}, ['--apply', '-n']),
    /Use --dry-run or --apply/,
  );
  assert.throws(
    () => configuration({}, ['-i=42', '--issue=43']),
    /more than once/,
  );
  assert.throws(() => configuration({}, ['-i=-1']), /positive safe integer/);
  assert.throws(() => configuration({}, ['--', '42']), /Use --dry-run/);
});

const root = fileURLToPath(new URL('..', import.meta.url));
const node = (script, args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: '/nonexistent', ...env },
  });

test('CLI entries print help and reject malformed input without subprocesses', () => {
  for (const [script, invalid] of [
    ['branch-name', ['285', '-a=sam', '--actor=other']],
    ['issue-triage', ['--apply', '-n']],
    ['issue-containers', ['--apply', '-n']],
  ]) {
    for (const help of ['--help', '-h']) {
      const result = node(`scripts/${script}.mjs`, [help], {
        GITHUB_ACTIONS: 'true',
        DRY_RUN: 'invalid',
      });
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
      assert.match(result.stdout, /Usage:/);
      assert.equal(result.stderr, '');
    }
    const result = node(`scripts/${script}.mjs`, invalid);
    assert.equal(result.status, 1, `${script}: ${result.stderr}`);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  }
});
