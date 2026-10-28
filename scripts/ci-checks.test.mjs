import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checks, parseFull, runChecks, testFiles } from './ci-checks.mjs';
import { classify, selectScopes } from './ci-scope.mjs';
import { evaluate, runScript, workflow } from './workflow-test-helpers.mjs';

const require = createRequire(import.meta.url);
const ciWorkflow = workflow('ci-checks');
const documentationChecks = [
  ['npm', ['run', 'format:check']],
  ['npm', ['run', 'lint:md']],
];

test('Markdown and LICENSE changes select the format check and the Markdown lint', () => {
  for (const paths of [
    ['README.md'],
    ['LICENSE'],
    ['CONTRIBUTING.md', 'CLAUDE.md', 'LICENSE'],
    ['docs/guide/setup.md'],
    ['packages/api/README.md'],
  ]) {
    assert.deepEqual(selectScopes(paths), { full: false }, paths.join());
    assert.deepEqual(
      checks(selectScopes(paths)),
      documentationChecks,
      paths.join(),
    );
  }
});

test('tooling, manifest, and unknown paths select every check', () => {
  for (const path of [
    'scripts/ci-scope.mjs',
    'scripts/README.md',
    '.agents/policy.json',
    '.agents/evidence.md',
    'AGENTS.md',
    'ISSUE_TRIAGE.md',
    '.agents/local/roles/reviewer.md',
    '.claude/agents/prism-implementer.md',
    '.claude/settings.json',
    '.codex/agents/prism-implementer.toml',
    '.github/workflows/ci-checks.yml',
    '.github/pull_request_template.md',
    '.github/labels.json',
    'package.json',
    'package-lock.json',
    '.tool-versions',
    '.prettierrc.json',
    '.prettierignore',
    'eslint.config.mjs',
    'packages/api/src/index.js',
    'src/prompts/system.md',
    'src/core/index.ts',
    'apps/action/README.md',
    'tooling/CoverageGate.ts',
    'tests/security/README.md',
    'evals/README.md',
    'unexpected/file',
    'LICENSE.txt',
    'docs/LICENSE',
  ]) {
    assert.equal(classify(path), 'full', path);
    assert.deepEqual(selectScopes([path]), { full: true }, path);
    assert.deepEqual(selectScopes(['README.md', path]), { full: true }, path);
  }
  // An empty comparison has nothing to classify, so it selects every check.
  assert.deepEqual(selectScopes([]), { full: true });
});

test('the full selection runs format, lint, typecheck, agent definitions, every script test, and the coverage-gated unit tests', () => {
  const tests = readdirSync(new URL('.', import.meta.url))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `scripts/${name}`)
    .sort();
  assert.ok(tests.includes('scripts/ci-checks.test.mjs'));
  assert.deepEqual(testFiles(), tests);
  assert.deepEqual(checks({ full: true }), [
    ['npm', ['run', 'format:check']],
    ['npm', ['run', 'lint']],
    ['npm', ['run', 'typecheck']],
    ['npm', ['run', 'agents:check']],
    ['node', ['--test', ...tests]],
    ['npm', ['run', 'test:unit']],
  ]);
  assert.deepEqual(checks({ full: false }), documentationChecks);
  const { scripts } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  for (const name of [
    'format:check',
    'lint',
    'lint:md',
    'agents:check',
    'typecheck',
    'test:unit',
  ])
    assert.equal(typeof scripts[name], 'string', name);
  assert.equal(scripts.lint, 'eslint . --max-warnings 0');
  // The unit tests fail when coverage drops below the gate's thresholds.
  assert.match(
    scripts['test:unit'],
    /^vitest run --coverage && node tooling\/CoverageGate\.ts /,
  );
  // Both lint scripts fail on any warning, so a Markdown problem fails CI.
  assert.equal(scripts['lint:md'], 'eslint --max-warnings 0 "**/*.md"');
  // Markdown lint only reports. `lint:fix` fixes code and never rewrites
  // Markdown.
  assert.equal(
    scripts['lint:fix'],
    "eslint . --fix --ignore-pattern '**/*.md'",
  );
  // Prettier never reads Markdown; the Markdown lint is its only check.
  assert.match(
    readFileSync(new URL('../.prettierignore', import.meta.url), 'utf8'),
    /^\*\*\/\*\.md$/m,
  );
});

test('checks overlap and any failing check rejects the gate after all checks settle', async () => {
  const started = [];
  const pending = [];
  let settled = false;
  const result = runChecks(
    [
      ['first', []],
      ['second', []],
    ],
    (command) => {
      started.push(command);
      return new Promise((resolve) => pending.push(resolve));
    },
    () => {},
  ).finally(() => {
    settled = true;
  });
  assert.deepEqual(started, ['first', 'second']);
  pending[0]({ code: 1, output: '' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  pending[1]({ code: 0, output: '' });
  await assert.rejects(result, /CI checks failed/);
});

// Settles each fake check in the given order and records what the gate writes.
async function runFakeChecks(commands, results, order) {
  const pending = new Map();
  const log = [];
  const result = runChecks(
    commands,
    (command) => new Promise((resolve) => pending.set(command, resolve)),
    (text) => log.push(text),
  ).then(
    () => undefined,
    (error) => error,
  );
  for (const command of order) {
    pending.get(command)(results[command]);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { log: log.join(''), error: await result };
}

const fakeCommands = [
  ['format', ['run', 'format:check']],
  ['lint', ['.', '--max-warnings', '0']],
  ['test', ['--test', 'a.test.mjs']],
];

test('each check prints a start line outside any group, then its buffered output in one group named after its command, in completion order', async () => {
  const { log, error } = await runFakeChecks(
    fakeCommands,
    {
      format: { code: 0, output: 'format line 1\nformat line 2\n' },
      lint: { code: 0, output: 'lint output' },
      test: { code: 0, output: '' },
    },
    ['test', 'format', 'lint'],
  );
  assert.equal(error, undefined);
  assert.equal(
    log,
    [
      'Started format run format:check',
      'Started lint . --max-warnings 0',
      'Started test --test a.test.mjs',
      '::group::test --test a.test.mjs',
      '::endgroup::',
      '::group::format run format:check',
      'format line 1',
      'format line 2',
      '::endgroup::',
      '::group::lint . --max-warnings 0',
      'lint output',
      '::endgroup::',
      '',
    ].join('\n'),
  );
});

test('one failing check is named with its exit code after every check runs', async () => {
  const { log, error } = await runFakeChecks(
    fakeCommands,
    {
      format: { code: 0, output: 'formatted\n' },
      lint: { code: 1, output: 'lint error\n' },
      test: { code: 0, output: 'tests passed\n' },
    },
    ['lint', 'format', 'test'],
  );
  assert.equal(
    error?.message,
    '1 of 3 CI checks failed:\n  lint . --max-warnings 0 (exit code 1)',
  );
  for (const output of ['formatted', 'lint error', 'tests passed'])
    assert.match(log, new RegExp(output));
});

test('two failing checks are both named with their exit codes in command order', async () => {
  const { error } = await runFakeChecks(
    fakeCommands,
    {
      format: { code: 2, output: '' },
      lint: { code: 0, output: '' },
      test: { code: 1, output: '' },
    },
    ['test', 'lint', 'format'],
  );
  assert.equal(
    error?.message,
    [
      '2 of 3 CI checks failed:',
      '  format run format:check (exit code 2)',
      '  test --test a.test.mjs (exit code 1)',
    ].join('\n'),
  );
});

test('the default runner buffers stdout and stderr and reports a failed exit code', async () => {
  const log = [];
  const script =
    "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(3)";
  await assert.rejects(
    runChecks([[process.execPath, ['-e', script]]], undefined, (text) =>
      log.push(text),
    ),
    (error) => error.message.endsWith('(exit code 3)'),
  );
  const output = log.join('');
  assert.match(output, /^Started .+ -e .+\n::group::.+ -e /);
  assert.match(output, /out\n/);
  assert.match(output, /err\n/);
  assert.match(output, /::endgroup::\n$/);
});

test('the check runner accepts only an explicit selection', () => {
  assert.equal(parseFull('true'), true);
  assert.equal(parseFull('false'), false);
  for (const value of [undefined, '', 'TRUE', '1'])
    assert.throws(() => parseFull(value), /CI_FULL/);
  const env = { ...process.env };
  delete env.CI_FULL;
  const result = spawnSync(
    process.execPath,
    [new URL('./ci-checks.mjs', import.meta.url).pathname],
    { env, encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Expected CI_FULL to be true or false\n');
  const emptySummary = spawnSync(
    process.execPath,
    [new URL('./ci-checks.mjs', import.meta.url).pathname],
    {
      env: { ...process.env, CI_FULL: 'false', GITHUB_STEP_SUMMARY: '' },
      encoding: 'utf8',
    },
  );
  assert.equal(emptySummary.status, 1);
  assert.equal(
    emptySummary.stderr,
    'Expected GITHUB_STEP_SUMMARY to name a file when set\n',
  );
});

test('the checks job runs after detection with its selection', () => {
  const { jobs } = ciWorkflow;
  assert.deepEqual(ciWorkflow.on, {
    pull_request: null,
    push: { branches: ['main'] },
  });
  assert.deepEqual(jobs['detect-changes'].outputs, {
    full: '${{ steps.scope.outputs.full }}',
  });
  // Classification needs no checkout; it reads the base classifier through the API.
  assert.deepEqual(
    jobs['detect-changes'].steps.map((step) => step.uses?.split('@')[0]),
    ['actions/github-script'],
  );
  assert.match(
    jobs['detect-changes'].steps[0].uses,
    /^actions\/github-script@[a-f0-9]{40}$/,
  );
  const run = jobs['run-checks'];
  assert.equal(run.needs, 'detect-changes');
  assert.equal(run.if, undefined);
  const step = run.steps.find(
    (candidate) => candidate.run === 'node scripts/ci-checks.mjs',
  );
  assert.deepEqual(step.env, {
    CI_FULL: '${{ needs.detect-changes.outputs.full }}',
  });
  assert.ok(run.steps.some((candidate) => candidate.run === 'npm ci'));
});

test('the required job waits for every other job and runs even when the run is cancelled', () => {
  const { jobs } = ciWorkflow;
  const required = jobs['require-scoped-checks'];
  assert.deepEqual(
    [...required.needs].sort(),
    Object.keys(jobs)
      .filter((id) => id !== 'require-scoped-checks')
      .sort(),
  );
  // A skipped job reports success, so a cancelled run must still fail here.
  for (const cancelled of [true, false])
    assert.equal(
      evaluate(required.if, {
        always: () => true,
        cancelled: () => cancelled,
        success: () => !cancelled,
        failure: () => false,
      }),
      true,
    );
  assert.deepEqual(required.steps[0].env, {
    SCOPE_RESULT: '${{ needs.detect-changes.result }}',
    CHECKS_RESULT: '${{ needs.run-checks.result }}',
  });
});

test('the required job passes only when detection and the selected checks passed', () => {
  const script = ciWorkflow.jobs['require-scoped-checks'].steps[0].run;
  const passes = (env) => {
    try {
      execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
        env: { ...process.env, ...env },
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  };
  const results = ['success', 'failure', 'cancelled', 'skipped'];
  for (const scope of results)
    for (const checksResult of results)
      assert.equal(
        passes({ SCOPE_RESULT: scope, CHECKS_RESULT: checksResult }),
        scope === 'success' && checksResult === 'success',
        `${scope} ${checksResult}`,
      );
});

test('the scope step selects checks for pushes, pull requests, and failures', async () => {
  const script = ciWorkflow.jobs['detect-changes'].steps[0].with.script;
  const currentClassifier = readFileSync(
    new URL('./ci-scope.mjs', import.meta.url),
    'utf8',
  );
  const run = async ({
    event = 'pull_request',
    files = [],
    baseline = currentClassifier,
    apiError,
  }) => {
    const directory = mkdtempSync(join(tmpdir(), 'ci-scope-script-'));
    const oldRunnerTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = directory;
    const outputs = {};
    const warnings = [];
    const calls = [];
    const github = {
      rest: {
        repos: {
          compareCommitsWithBasehead: async (request) => {
            calls.push(['compare', request]);
            if (apiError) throw new Error(apiError);
            return {
              data: { files, merge_base_commit: { sha: 'c'.repeat(40) } },
            };
          },
          getContent: async (request) => {
            calls.push(['content', request]);
            return {
              data: { content: Buffer.from(baseline).toString('base64') },
            };
          },
        },
      },
    };
    const context = {
      eventName: event,
      repo: { owner: 'owner', repo: 'repo' },
      sha: 'b'.repeat(40),
      payload: {
        before: 'a'.repeat(40),
        pull_request: {
          base: { sha: 'a'.repeat(40) },
          head: { sha: 'b'.repeat(40) },
        },
      },
    };
    try {
      await runScript(script, {
        require: (name) => {
          assert.ok(['fs', 'path', 'url'].includes(name), name);
          return require(name);
        },
        context,
        github,
        core: {
          info: () => {},
          setOutput: (name, value) => {
            outputs[name] = value;
          },
          warning: (message) => warnings.push(message),
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
      if (oldRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = oldRunnerTemp;
    }
    return { outputs, warnings, calls };
  };
  const named = (...names) => names.map((filename) => ({ filename }));

  const docs = await run({ files: named('README.md', 'LICENSE') });
  assert.deepEqual(docs.outputs, { full: 'false' });
  assert.deepEqual(docs.warnings, []);
  assert.deepEqual(docs.calls, [
    [
      'compare',
      {
        owner: 'owner',
        repo: 'repo',
        basehead: `${'a'.repeat(40)}...${'b'.repeat(40)}`,
      },
    ],
    // The classifier comes from the base commit, not the pull request head.
    [
      'content',
      {
        owner: 'owner',
        repo: 'repo',
        path: 'scripts/ci-scope.mjs',
        ref: 'a'.repeat(40),
      },
    ],
  ]);

  const tooling = await run({ files: named('README.md', 'scripts/x.mjs') });
  assert.deepEqual(tooling.outputs, { full: 'true' });

  // A rename counts both paths, so moving tooling into a doc path still selects it.
  const renamed = await run({
    files: [{ filename: 'notes.md', previous_filename: 'scripts/notes.mjs' }],
  });
  assert.deepEqual(renamed.outputs, { full: 'true' });

  // The base commit's classifier decides, whatever the head's says.
  const strictBase = await run({
    files: named('README.md'),
    baseline: 'export const selectScopes = () => ({ full: true });',
  });
  assert.deepEqual(strictBase.outputs, { full: 'true' });

  const push = await run({ event: 'push', files: named('README.md') });
  assert.deepEqual(push.outputs, { full: 'true' });
  assert.deepEqual(push.calls, []);

  for (const [options, warning] of [
    [{ apiError: 'comparison unavailable' }, /comparison unavailable/],
    [
      { files: named(...Array.from({ length: 300 }, (_, i) => `${i}.md`)) },
      /file list limit/,
    ],
    [
      { files: named('README.md'), baseline: 'export function classify() {}' },
      /no selectScopes export/,
    ],
    [
      {
        files: named('README.md'),
        baseline: 'export const selectScopes = () => ({ full: "false" });',
      },
      /no full selection/,
    ],
    [{ files: named('README.md'), baseline: 'syntax error (' }, /./],
  ]) {
    const failed = await run(options);
    assert.deepEqual(failed.outputs, { full: 'true' });
    assert.match(failed.warnings.join('\n'), /running every check/);
    assert.match(failed.warnings.join('\n'), warning);
  }
});
