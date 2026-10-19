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
const ciWorkflow = workflow('ci-checks.yml');
const documentationChecks = [
  ['npm', ['run', 'format:check']],
  ['npm', ['run', 'lint:md']],
];

test('Markdown and LICENSE changes select the format check and the Markdown lint', () => {
  for (const paths of [
    ['README.md'],
    ['LICENSE'],
    ['CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE'],
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
    '.agents/roles/implementer.md',
    '.agents/README.md',
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
    'vendor/anti-slop/stop-slop/references/phrases.md',
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

test('every check runs even after one fails, and any failure rejects', async () => {
  const started = [];
  const run = async (command) => {
    started.push(command);
    return command === 'second' ? 1 : 0;
  };
  await assert.rejects(
    runChecks(
      [
        ['first', []],
        ['second', ['--flag']],
        ['third', []],
      ],
      run,
    ),
    /CI checks failed: second --flag$/,
  );
  assert.deepEqual(started, ['first', 'second', 'third']);
  await runChecks([['first', []]], run);
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
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CI_FULL/);
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
