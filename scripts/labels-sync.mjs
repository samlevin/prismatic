import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ghApi } from './github-rest.mjs';
import { REPOSITORY } from './issue-triage.mjs';

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
// `usages` maps a label name to 'used', 'unused', or 'unknown'; only 'unused'
// allows deletion.
export function partitionPrune(deletes, usages) {
  const result = { delete: [], skip: [] };
  for (const label of deletes)
    (usages.get(label.name) === 'unused' ? result.delete : result.skip).push(
      label,
    );
  return result;
}

const gh = (args) => ghApi(args);

function liveLabels() {
  return JSON.parse(
    gh(['--paginate', '--slurp', `repos/${REPOSITORY}/labels?per_page=100`]),
  ).flat();
}

// Any lookup error keeps the label.
export function usage(name, api = ghApi) {
  try {
    const issues = JSON.parse(
      api([
        `repos/${REPOSITORY}/issues?labels=${encodeURIComponent(name)}&state=all&per_page=1`,
      ]),
    );
    return Array.isArray(issues) && issues.length === 0 ? 'unused' : 'used';
  } catch {
    console.log(`skip delete (lookup failed): ${name}`);
    return 'unknown';
  }
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
  if (argv.some((arg) => !['--apply', '--prune'].includes(arg)))
    throw new Error('Usage: labels-sync.mjs [--apply] [--prune]');
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
    const usages = new Map(plan.delete.map((l) => [l.name, usage(l.name)]));
    const { delete: unused, skip } = partitionPrune(plan.delete, usages);
    for (const label of skip)
      // usage() already logged why an unreadable label is kept.
      if (usages.get(label.name) === 'used')
        console.log(`${verb}skip delete (in use): ${label.name}`);
    for (const label of unused) {
      console.log(`${verb}delete: ${label.name}`);
      if (apply)
        gh(['-X', 'DELETE', `${base}/${encodeURIComponent(label.name)}`]);
    }
  }
  for (const label of plan.unchanged) console.log(`unchanged: ${label.name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
