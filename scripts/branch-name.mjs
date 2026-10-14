import { pathToFileURL } from 'node:url';
import { REPOSITORY, ghRest } from './issue-triage.mjs';

const MAX_SLUG = 40;
// Titles with no ASCII letters or digits still need a usable slug.
const FALLBACK_SLUG = 'issue';
const NUMBER = '[1-9][0-9]*';
const POSITIVE_INTEGER = new RegExp(`^${NUMBER}$`);
const ACTOR = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const CANONICAL = new RegExp(
  `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/${NUMBER}-(?!part-[0-9]+(?:-|$))[a-z0-9]+(?:-(?!part-[0-9]+(?:-|$))[a-z0-9]+)*(?:-part-(?:[2-9]|[1-9][0-9]+))?$`,
);

export function slugify(title) {
  const words = String(title)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // Join "part N" into "partN" so a title never reads as a stack layer suffix.
  const joined = [];
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === 'part' && /^[0-9]+$/.test(words[index + 1] ?? ''))
      joined.push(`part${words[++index]}`);
    else joined.push(words[index]);
  }
  let slug = '';
  for (const word of joined) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_SLUG) {
      // Never split a word, unless the first word alone is too long.
      if (!slug) slug = word.slice(0, MAX_SLUG);
      break;
    }
    slug = next;
  }
  return slug || FALLBACK_SLUG;
}

export function isCanonicalBranch(name) {
  return typeof name === 'string' && CANONICAL.test(name);
}

export function branchName({ issue, title, actor = 'agent', layer = 1 }) {
  if (!POSITIVE_INTEGER.test(String(issue)))
    throw new Error('Issue must be a positive number');
  if (!ACTOR.test(actor)) throw new Error('Actor must be a GitHub login');
  if (!Number.isInteger(layer) || layer < 1)
    throw new Error('Layer must be a positive integer');
  const suffix = layer > 1 ? `-part-${layer}` : '';
  const name = `${actor.toLowerCase()}/${issue}-${slugify(title)}${suffix}`;
  if (!isCanonicalBranch(name)) throw new Error(`Not a valid branch: ${name}`);
  return name;
}

export function parseArguments(argv) {
  const options = { actor: 'agent', layer: 1 };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--actor' || argument === '--layer') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`Option ${argument} requires a value`);
      if (argument === '--actor') options.actor = value;
      else {
        if (!POSITIVE_INTEGER.test(value))
          throw new Error('--layer requires a positive integer');
        options.layer = Number(value);
      }
    } else if (argument.startsWith('--'))
      throw new Error(`Unknown option ${argument}`);
    else positional.push(argument);
  }
  if (positional.length > 1) throw new Error('Too many arguments');
  options.value = positional[0];
  return options;
}

// Returns an issue with a title, or throws a readable error.
function lookupIssue(api, number) {
  let found;
  try {
    found = JSON.parse(api([`repos/${REPOSITORY}/issues/${number}`]));
  } catch (error) {
    if (error?.httpStatus === 404)
      throw new Error(`Issue #${number} was not found`, { cause: error });
    throw error;
  }
  if (!found || typeof found !== 'object')
    throw new Error(`Issue #${number} was not found`);
  if (found.pull_request)
    throw new Error(`#${number} is a pull request, not an issue`);
  if (typeof found.title !== 'string' || !found.title.trim())
    throw new Error(`Issue #${number} has no title`);
  return found;
}

export function run(argv, { api = ghRest } = {}) {
  const options = parseArguments(argv);
  if (!options.value)
    throw new Error(
      'Usage: branch-name.mjs <issue> [--layer <n>] [--actor <login>]',
    );
  if (!POSITIVE_INTEGER.test(options.value))
    throw new Error('Issue must be a positive number');
  const { title } = lookupIssue(api, options.value);
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
    console.error(error.message);
    process.exitCode = 1;
  }
}
