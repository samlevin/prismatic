import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPOSITORY } from './issue-triage.mjs';

const MAX_SLUG = 40;
const CANONICAL =
  /^[a-z0-9-]+\/[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*(-part-[2-9][0-9]*)?$/;
const EXEMPT = [/^release-please--/, /^dependabot\//];

export function slugify(title) {
  const words = String(title)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_SLUG) {
      // Never split a word, unless the first word alone is too long.
      if (!slug) slug = word.slice(0, MAX_SLUG);
      break;
    }
    slug = next;
  }
  return slug;
}

export function isCanonicalBranch(name) {
  return typeof name === 'string' && CANONICAL.test(name);
}

export function isExemptBranch(name) {
  return EXEMPT.some((pattern) => pattern.test(name));
}

export function branchName({ issue, title, actor = 'agent', layer = 1 }) {
  if (!/^[1-9][0-9]*$/.test(String(issue)))
    throw new Error('Issue must be a positive number');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(actor))
    throw new Error('Actor must be a GitHub login');
  if (!Number.isInteger(layer) || layer < 1)
    throw new Error('Layer must be a positive integer');
  const slug = slugify(title);
  if (!slug) throw new Error('Issue title has no usable characters');
  const suffix = layer > 1 ? `-part-${layer}` : '';
  const name = `${actor.toLowerCase()}/${issue}-${slug}${suffix}`;
  if (!isCanonicalBranch(name)) throw new Error(`Not a valid branch: ${name}`);
  return name;
}

export function parseArguments(argv) {
  const options = {
    actor: 'agent',
    layer: 1,
    check: false,
    requireIssue: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--require-issue') options.requireIssue = true;
    else if (argument === '--actor' || argument === '--layer') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`Option ${argument} requires a value`);
      if (argument === '--actor') options.actor = value;
      else options.layer = Number(value);
    } else if (argument.startsWith('--'))
      throw new Error(`Unknown option ${argument}`);
    else positional.push(argument);
  }
  if (positional.length > 1) throw new Error('Too many arguments');
  if (options.requireIssue && !options.check)
    throw new Error('--require-issue needs --check');
  options.value = positional[0];
  return options;
}

function currentBranch() {
  return execFileSync('git', ['branch', '--show-current'], {
    encoding: 'utf8',
  }).trim();
}

function fetchIssue(number) {
  const output = execFileSync(
    'gh',
    ['api', `repos/${REPOSITORY}/issues/${number}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(output);
}

export function issueNumber(name) {
  return name.slice(name.indexOf('/') + 1).match(/^[1-9][0-9]*/)[0];
}

export function run(
  argv,
  { current = currentBranch, issue = fetchIssue } = {},
) {
  const options = parseArguments(argv);
  if (options.check) {
    const name = options.value ?? current();
    if (isExemptBranch(name))
      return `Skipping the branch name check for automation branch ${name}`;
    if (!isCanonicalBranch(name))
      throw new Error(
        `Branch "${name}" must be <actor>/<issue>-<slug>[-part-N]; run: node scripts/branch-name.mjs <issue>`,
      );
    if (options.requireIssue) {
      const number = issueNumber(name);
      let found;
      try {
        found = issue(number);
      } catch (error) {
        // Never print stderr: it can contain authentication details.
        throw new Error(
          String(error?.stderr ?? '').includes('HTTP 404')
            ? `Issue #${number} was not found`
            : 'GitHub request failed',
          { cause: error },
        );
      }
      if (!found || typeof found !== 'object')
        throw new Error(`Issue #${number} was not found`);
      if ('pull_request' in found)
        throw new Error(`#${number} is a pull request, not an issue`);
    }
    return `Branch ${name} is valid`;
  }
  if (!options.value)
    throw new Error('Usage: branch-name.mjs <issue> | --check [name]');
  if (!/^[1-9][0-9]*$/.test(options.value))
    throw new Error('Issue must be a positive number');
  const found = issue(options.value);
  if (found?.pull_request)
    throw new Error(`Issue #${options.value} is a pull request`);
  const title = found?.title;
  if (typeof title !== 'string' || !title.trim())
    throw new Error(`Issue #${options.value} has no title`);
  return branchName({
    issue: options.value,
    title,
    actor: options.actor,
    layer: options.layer,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    // Do not print subprocess stderr, which can contain authentication details.
    console.error(error.status ? 'GitHub request failed' : error.message);
    process.exitCode = 1;
  }
}
