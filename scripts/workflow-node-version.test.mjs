import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

// `.tool-versions` is the one place the Node version is pinned. Every
// `actions/setup-node` step reads it, so no workflow or composite action may
// set `node-version` or point `node-version-file` anywhere else.
const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const definitions = [
  ...readdirSync(new URL('.github/workflows/', root))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => `.github/workflows/${file}`),
  ...(existsSync(new URL('.github/actions/', root))
    ? readdirSync(new URL('.github/actions/', root)).flatMap((name) =>
        ['action.yml', 'action.yaml']
          .map((file) => `.github/actions/${name}/${file}`)
          .filter((path) => existsSync(new URL(path, root))),
      )
    : []),
]
  .sort()
  .map((path) => [path, parse(read(path))]);

const jobsOf = (path, definition) =>
  definition.jobs
    ? Object.entries(definition.jobs).map(([id, job]) => [
        `${path} ${id}`,
        job.steps ?? [],
      ])
    : [[path, definition.runs?.steps ?? []]];

const isSetupNode = (step) =>
  typeof step.uses === 'string' && step.uses.startsWith('actions/setup-node@');
const isRootCheckout = (step) =>
  typeof step.uses === 'string' &&
  step.uses.startsWith('actions/checkout@') &&
  step.with?.path === undefined &&
  step.with?.['sparse-checkout-cone-mode'] !== false;

test('.tool-versions pins the Node version', () => {
  assert.match(read('.tool-versions'), /^nodejs \d+\.\d+\.\d+$/m);
});

test('every setup-node step reads the Node version from .tool-versions', () => {
  let count = 0;
  for (const [path, definition] of definitions) {
    for (const [where, steps] of jobsOf(path, definition)) {
      steps.forEach((step, index) => {
        if (!isSetupNode(step)) return;
        count += 1;
        const name = `${where} step ${step.name ?? index}`;
        assert.equal(step.with?.['node-version'], undefined, name);
        assert.equal(step.with?.['node-version-file'], '.tool-versions', name);
        // setup-node reads the file from the workspace, so a checkout of the
        // repository root (sparse checkouts in cone mode keep root files) must
        // come first.
        assert.ok(
          steps.slice(0, index).some(isRootCheckout),
          `${name} runs before the repository root is checked out`,
        );
      });
    }
  }
  assert.ok(count > 0, 'no setup-node steps found');
});

test('no workflow or action sets node-version anywhere', () => {
  for (const [path] of definitions) {
    assert.doesNotMatch(read(path), /^\s*node-version\s*:/m, path);
  }
});
