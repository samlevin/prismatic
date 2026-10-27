import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliError, CliHelp, defineCli, parseCli } from './cli.mjs';

const cli = defineCli('Usage: example [options]', [
  'issue',
  'resume',
  'output',
  'next',
]);

test('exact aliases, equals forms, and values preserve their meaning', () => {
  for (const args of [
    ['--issue', '12', '--resume', '14', '--output', 'out.json'],
    ['-i', '12', '--resume', '14', '-o', 'out.json'],
    ['--issue=12', '--resume=14', '--output=out.json'],
    ['-i=12', '--resume=14', '-o=out.json'],
  ])
    assert.deepEqual(parseCli(args, cli).options, {
      issue: '12',
      resume: '14',
      output: 'out.json',
    });
  assert.deepEqual(parseCli(['-o=--next=x', '--', '-i', '3', '--help'], cli), {
    options: { output: '--next=x' },
    positionals: ['-i', '3', '--help'],
  });
  assert.equal(
    parseCli(['-o', 'space = value'], cli).options.output,
    'space = value',
  );
  assert.deepEqual(parseCli(['12', '--next'], cli), {
    options: { next: true },
    positionals: ['12'],
  });
});

test('known spellings reject duplicates, missing values, grouped flags, and unknowns', () => {
  for (const args of [
    ['-i', '1', '--issue=2'],
    ['--issue', '1', '-i=1'],
    ['--next', '--next'],
    ['--output'],
    ['-i'],
    ['-i', '-o', 'x'],
    ['-i', '--'],
    ['-i', '--unknown'],
    ['-issue=1'],
    ['-i1'],
    ['-no'],
    ['--unknown'],
    ['--next=false'],
    ['-o='],
    ['--resume='],
  ])
    assert.throws(() => parseCli(args, cli), CliError, args.join(' '));
  assert.throws(
    () => defineCli('Usage: missing', ['environment']),
    /Undefined option environment/,
  );
  for (const flag of ['-h', '--help'])
    assert.throws(() => parseCli([flag], cli), CliHelp);
  assert.match(cli.help, /--issue, -i <value> {2}Positive issue number/);
});

test('every command-line script prints help and exits 0', () => {
  for (const [script, args] of [
    ['agent-policy.mjs', ['--help']],
    ['agent-policy.mjs', ['resolve', '--help']],
    ['delivery-queue.mjs', ['--help']],
    ['spec-to-issues.mjs', ['--help']],
  ]) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(`./${script}`, import.meta.url)), ...args],
      { encoding: 'utf8', env: { PATH: process.env.PATH } },
    );
    assert.equal(result.status, 0, `${script} ${args.join(' ')}`);
    assert.match(result.stdout, /^Usage: /, script);
  }
});
