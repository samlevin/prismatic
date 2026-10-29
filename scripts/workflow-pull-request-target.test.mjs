import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { workflow } from './workflow-test-helpers.mjs';

// A `pull_request_target` workflow runs with the base repository's token and
// secrets, so it must only run trusted default-branch code. No checkout may
// select the pull request's head or another repository, and no `run` step may
// fetch the head.

const triggers = (definition) => {
  const on = definition?.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return on && typeof on === 'object' ? Object.keys(on) : [];
};

const isPullRequestTarget = (definition) =>
  triggers(definition).includes('pull_request_target');

// Expressions that name the pull request's head or merge commit, branch, or ref.
const PR_HEAD =
  /github\.event\.pull_request\.(?:head\.|merge_commit_sha)|github\.head_ref|GITHUB_HEAD_REF|refs\/pull\/|pull\/[^/\n]*\/(?:head|merge)\b/;
// An agenticool board workflow pinned at a full commit SHA or a board release tag.
const AGENTICOOL_REUSABLE =
  /^agenticool\/agenticool\/\.github\/workflows\/_board-[a-z0-9-]+\.yml@(?:[0-9a-f]{40}|board-v\d+\.\d+\.\d+)$/;
// Expressions that name the base repository.
const BASE_REPOSITORY = new Set([
  'github.repository',
  'github.event.repository.full_name',
  'github.event.pull_request.base.repo.full_name',
]);
const isBaseRepository = (value) =>
  value === 'samlevin/prismatic' || BASE_REPOSITORY.has(expression(value));
// A `git` command with `fetch` among its arguments, after joining
// backslash-continued lines.
const FETCH = /\bgit\b[^\n;&|]*?\sfetch\b/;
// `gh pr checkout` always checks out a pull request head.
const PR_CHECKOUT = /\bgh\s+pr\s+checkout\b/;
const joinLines = (script) => script.replace(/\\\r?\n/g, ' ');

const expression = (value) =>
  /^\$\{\{\s*([^}]*?)\s*\}\}$/.exec(String(value).trim())?.[1];

const isCheckout = (step) =>
  typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@');

const envText = (...scopes) =>
  scopes.flatMap((env) => Object.values(env ?? {}).map(String)).join('\n');

const untrustedCode = (definition) => {
  if (!isPullRequestTarget(definition)) return [];
  const problems = [];
  for (const [id, job] of Object.entries(definition.jobs ?? {})) {
    // A called workflow runs with this event's token and secrets, but its
    // own trigger is `workflow_call`, so its steps are not checked here. The
    // pinned agenticool board workflows check out only the default branch.
    if (typeof job?.uses === 'string' && !AGENTICOOL_REUSABLE.test(job.uses)) {
      problems.push(`${id} calls a reusable workflow: ${job.uses}`);
    }
    (job?.steps ?? []).forEach((step, index) => {
      const label = `${id} step ${index + 1} (${step.name ?? step.uses ?? 'run'})`;
      const env = envText(definition.env, job.env, step.env);
      if (isCheckout(step)) {
        const { ref, repository } = step.with ?? {};
        // A ref read from `env` is checked against the env values in scope.
        const refText = /\benv\./.test(String(ref)) ? `${ref}\n${env}` : ref;
        if (ref !== undefined && PR_HEAD.test(String(refText))) {
          problems.push(`${label} checks out the pull request head: ${ref}`);
        }
        if (repository !== undefined && !isBaseRepository(repository)) {
          problems.push(
            `${label} checks out a repository other than the base repository: ${repository}`,
          );
        }
      }
      if (typeof step.run === 'string') {
        const script = joinLines(step.run);
        if (PR_CHECKOUT.test(script)) {
          problems.push(`${label} checks out the pull request with gh`);
        } else if (FETCH.test(script) && PR_HEAD.test(`${script}\n${env}`)) {
          problems.push(`${label} fetches the pull request head`);
        }
      }
    });
  }
  return problems;
};

const names = readdirSync(new URL('../.github/workflows/', import.meta.url))
  .filter((file) => file.endsWith('.yml'))
  .map((file) => file.slice(0, -'.yml'.length))
  .sort();

test('pull_request_target workflows never check out or fetch pull request code', () => {
  const targets = names.filter((name) => isPullRequestTarget(workflow(name)));
  for (const name of ['board-pr-issue-status', 'board-pr-metadata']) {
    assert.ok(targets.includes(name), `${name} runs on pull_request_target`);
  }
  for (const name of targets) {
    assert.deepEqual(untrustedCode(workflow(name)), [], name);
  }
});

test('pull_request_target is found in string, list, and map triggers', () => {
  assert.ok(isPullRequestTarget(parse('on: pull_request_target')));
  assert.ok(isPullRequestTarget(parse('on: [push, pull_request_target]')));
  assert.ok(
    isPullRequestTarget(
      parse('on:\n  pull_request_target:\n    types: [opened]'),
    ),
  );
  assert.ok(!isPullRequestTarget(parse('on: [push, pull_request]')));
});

const target = (steps, extra = '') =>
  parse(
    `on: pull_request_target\n${extra}jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`,
  );
const checkout = (inputs) =>
  `      - name: Check out\n        uses: actions/checkout@0000000000000000000000000000000000000000 # v4\n        with:\n${inputs}`;

test('a checkout of the pull request head fails', () => {
  for (const ref of [
    '${{ github.event.pull_request.head.sha }}',
    '${{ github.event.pull_request.head.ref }}',
    '${{ github.head_ref }}',
    '${{ github.event.pull_request.merge_commit_sha }}',
    'refs/pull/${{ github.event.pull_request.number }}/merge',
  ]) {
    assert.deepEqual(
      untrustedCode(target(checkout(`          ref: ${ref}\n`))),
      [`build step 1 (Check out) checks out the pull request head: ${ref}`],
      ref,
    );
  }
});

test('a checkout ref read from env that names the pull request head fails', () => {
  const ref = '${{ env.PR_SHA }}';
  assert.deepEqual(
    untrustedCode(
      target(
        checkout(`          ref: ${ref}\n`),
        'env:\n  PR_SHA: ${{ github.event.pull_request.head.sha }}\n',
      ),
    ),
    [`build step 1 (Check out) checks out the pull request head: ${ref}`],
  );
  assert.deepEqual(
    untrustedCode(
      target(
        checkout(`          ref: ${ref}\n`),
        'env:\n  PR_SHA: ${{ github.sha }}\n',
      ),
    ),
    [],
  );
});

test('a checkout of another repository fails', () => {
  const repository = '${{ github.event.pull_request.head.repo.full_name }}';
  assert.deepEqual(
    untrustedCode(target(checkout(`          repository: ${repository}\n`))),
    [
      `build step 1 (Check out) checks out a repository other than the base repository: ${repository}`,
    ],
  );
  assert.equal(
    untrustedCode(target(checkout('          repository: someone/fork\n')))
      .length,
    1,
  );
});

test('a checkout of the default branch in the base repository passes', () => {
  for (const repository of [
    '${{ github.repository }}',
    '${{github.event.repository.full_name}}',
    'samlevin/prismatic',
  ]) {
    assert.deepEqual(
      untrustedCode(
        target(
          checkout(
            `          ref: \${{ github.event.repository.default_branch }}\n          repository: ${repository}\n          persist-credentials: false\n`,
          ),
        ),
      ),
      [],
      repository,
    );
  }
});

test('a run step that fetches the pull request head fails', () => {
  const run = (script, env = '') =>
    `      - name: Fetch\n${env}        run: ${script}\n`;
  for (const steps of [
    run('git fetch origin pull/${{ github.event.pull_request.number }}/head'),
    run('git fetch origin ${{ github.event.pull_request.head.sha }}'),
    run('git -C repo fetch origin refs/pull/1/head'),
    run('git -c protocol.version=2 fetch origin pull/1/head'),
    run('git -C "$DIR" fetch origin ${{ github.event.pull_request.head.sha }}'),
    run('|\n          git \\\n            fetch origin pull/1/head'),
    run('git fetch origin "$GITHUB_HEAD_REF"'),
    run(
      'git fetch origin "$HEAD_SHA"',
      '        env:\n          HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n',
    ),
  ]) {
    assert.deepEqual(
      untrustedCode(target(steps)),
      ['build step 1 (Fetch) fetches the pull request head'],
      steps,
    );
  }
  assert.deepEqual(untrustedCode(target(run('git fetch origin main'))), []);
  assert.deepEqual(
    untrustedCode(target(run('git -C "$DIR" fetch origin main'))),
    [],
  );
});

test('a run step that checks out the pull request with gh fails', () => {
  for (const script of [
    'gh pr checkout ${{ github.event.pull_request.number }}',
    'gh pr checkout "$PR"',
  ]) {
    assert.deepEqual(
      untrustedCode(
        target(`      - name: Check out PR\n        run: ${script}\n`),
      ),
      ['build step 1 (Check out PR) checks out the pull request with gh'],
      script,
    );
  }
});

test('a job that calls a reusable workflow fails unless it is a pinned agenticool board workflow', () => {
  assert.deepEqual(
    untrustedCode(
      parse(
        'on: pull_request_target\njobs:\n  call:\n    uses: ./.github/workflows/build.yml\n',
      ),
    ),
    ['call calls a reusable workflow: ./.github/workflows/build.yml'],
  );
  for (const uses of [
    'agenticool/agenticool/.github/workflows/_board-pr-metadata.yml@board-v0.1.0',
    `agenticool/agenticool/.github/workflows/_board-pr-metadata.yml@${'a'.repeat(40)}`,
  ]) {
    assert.deepEqual(
      untrustedCode(
        parse(`on: pull_request_target\njobs:\n  call:\n    uses: ${uses}\n`),
      ),
      [],
      uses,
    );
  }
  for (const uses of [
    'agenticool/agenticool/.github/workflows/_board-pr-metadata.yml@main',
    'agenticool/agenticool/.github/workflows/_release.yml@board-v0.1.0',
  ]) {
    assert.equal(
      untrustedCode(
        parse(`on: pull_request_target\njobs:\n  call:\n    uses: ${uses}\n`),
      ).length,
      1,
      uses,
    );
  }
});

test('the same steps pass outside pull_request_target', () => {
  const definition = target(
    checkout('          ref: ${{ github.event.pull_request.head.sha }}\n'),
  );
  definition.on = 'pull_request';
  assert.deepEqual(untrustedCode(definition), []);
});
