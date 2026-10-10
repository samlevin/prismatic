import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'samlevin/prismatic';
// Release Please owns every `autorelease:` label; the sync never deletes them.
const isProtected = (name) => name.startsWith('autorelease:');
const CATALOG = new URL('../.github/labels.json', import.meta.url);

const same = (a, b) =>
  a.name === b.name &&
  (a.color ?? '').toLowerCase() === (b.color ?? '').toLowerCase() &&
  (a.description ?? '') === (b.description ?? '');

// Pure: compares the desired catalogue with live labels. GitHub matches names
// case-insensitively.
export function planLabelSync(desired, actual) {
  const live = new Map(
    actual.map((label) => [label.name.toLowerCase(), label]),
  );
  const wanted = new Set(desired.map((label) => label.name.toLowerCase()));
  const plan = { create: [], update: [], delete: [], unchanged: [] };
  for (const label of desired) {
    const current = live.get(label.name.toLowerCase());
    if (!current) plan.create.push(label);
    else if (same(label, current)) plan.unchanged.push(label);
    else plan.update.push({ ...label, current: current.name });
  }
  for (const label of actual)
    if (!wanted.has(label.name.toLowerCase()) && !isProtected(label.name))
      plan.delete.push(label);
  return plan;
}

// Pure: a label still carried by any issue or pull request is never deleted.
export function partitionPrune(deletes, counts) {
  const result = { delete: [], skip: [] };
  for (const label of deletes)
    (counts.get(label.name) > 0 ? result.skip : result.delete).push(label);
  return result;
}

function gh(args) {
  return execFileSync('gh', ['api', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function liveLabels() {
  return JSON.parse(
    gh(['--paginate', '--slurp', `repos/${REPOSITORY}/labels?per_page=100`]),
  ).flat();
}

function usage(name) {
  const query = `repo:${REPOSITORY} label:"${name}"`;
  return JSON.parse(
    gh(['-X', 'GET', 'search/issues', '-f', `q=${query}`, '-F', 'per_page=1']),
  ).total_count;
}

const fields = (label) => [
  '-f',
  `color=${label.color}`,
  '-f',
  `description=${label.description ?? ''}`,
];

export function run(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const prune = argv.includes('--prune');
  if (
    argv.some((arg) => !['--apply', '--prune'].includes(arg)) ||
    (prune && !apply)
  )
    throw new Error('Usage: labels-sync.mjs [--apply [--prune]]');
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
  if (catalog.repository !== REPOSITORY)
    throw new Error(`labels.json targets ${catalog.repository}`);
  const plan = planLabelSync(catalog.labels, liveLabels());
  const base = `repos/${REPOSITORY}/labels`;
  const verb = apply ? '' : 'would ';
  for (const label of plan.create) {
    console.log(`${verb}create: ${label.name}`);
    if (apply)
      gh(['-X', 'POST', base, '-f', `name=${label.name}`, ...fields(label)]);
  }
  for (const label of plan.update) {
    console.log(`${verb}update: ${label.name}`);
    if (apply)
      gh([
        '-X',
        'PATCH',
        `${base}/${encodeURIComponent(label.current)}`,
        '-f',
        `new_name=${label.name}`,
        ...fields(label),
      ]);
  }
  if (!prune)
    for (const label of plan.delete)
      console.log(`would delete (needs --prune): ${label.name}`);
  else {
    const counts = new Map(plan.delete.map((l) => [l.name, usage(l.name)]));
    const { delete: unused, skip } = partitionPrune(plan.delete, counts);
    for (const label of skip)
      console.log(
        `skip delete (${counts.get(label.name)} issues or pull requests): ${label.name}`,
      );
    for (const label of unused) {
      console.log(`delete: ${label.name}`);
      gh(['-X', 'DELETE', `${base}/${encodeURIComponent(label.name)}`]);
    }
  }
  for (const label of plan.unchanged) console.log(`unchanged: ${label.name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run();
