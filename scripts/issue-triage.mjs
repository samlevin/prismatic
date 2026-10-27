import { CliHelp, cliError, defineCli, parseCli } from './cli.cjs';
import { execFileSync } from 'node:child_process';
import {
  failureMessage,
  GitHubError,
  ghGraphql,
  ghRest,
} from './github-api.mjs';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'samlevin/prismatic';
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'none'].map(
  (value) => `severity: ${value}`,
);
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SIZES = ['XS', 'S', 'M', 'L'];
const PAGE = 'pageInfo { hasNextPage endCursor }';
const EMPTY = { nodes: [], pageInfo: { hasNextPage: false } };
const VALUES = `nodes {
  ... on ProjectV2ItemFieldSingleSelectValue { optionId field {
    ... on ProjectV2SingleSelectField { id }
  } }
} ${PAGE}`;
// One project item with the first page of its field values and issue labels,
// so reading an item costs one request unless a connection overflows.
const ITEM = `id type project { id } fieldValues(first: 50) { ${VALUES} } content {
  __typename ... on Issue { id number state repository { nameWithOwner }
    labels(first: 50) { nodes { name } ${PAGE} } }
}`;

export function eligible(item) {
  const severity = item.labels.filter((label) => label.startsWith('severity:'));
  return (
    item.type === 'ISSUE' &&
    item.content?.__typename === 'Issue' &&
    item.content.repository.nameWithOwner === REPOSITORY &&
    item.content.state === 'OPEN' &&
    (item.fields.Status === undefined || item.fields.Status === 'Inbox') &&
    PRIORITIES.includes(item.fields.Priority) &&
    severity.length === 1 &&
    SEVERITIES.includes(severity[0]) &&
    SIZES.includes(item.fields.Size)
  );
}

// `first` is a first page that arrived nested in another query; fetchPage then
// runs only for the pages after it.
export async function paginate(fetchPage, first) {
  const nodes = [];
  let cursor = null;
  const seen = new Set();
  let connection = first ?? (await fetchPage(cursor));
  while (true) {
    if (!connection) throw new Error('Missing GraphQL connection');
    nodes.push(...connection.nodes.filter(Boolean));
    if (!connection.pageInfo.hasNextPage) return nodes;
    cursor = connection.pageInfo.endCursor;
    if (!cursor || seen.has(cursor))
      throw new Error('Pagination cursor did not advance');
    seen.add(cursor);
    connection = await fetchPage(cursor);
  }
}

// GitHub answers a lookup of an issue that was deleted or transferred out of
// the repository with a null `issue`, `node`, or `content` field and a
// NOT_FOUND error at that field's path. Any other error, including a missing
// repository or project, still fails.
const ISSUE_FIELDS = new Set(['issue', 'node', 'content']);
function missingIssueOnly(result) {
  return result.errors.every((error) => {
    const path = error?.path;
    if (
      error?.type !== 'NOT_FOUND' ||
      !Array.isArray(path) ||
      !ISSUE_FIELDS.has(path.at(-1))
    )
      return false;
    return path.reduce((value, key) => value?.[key], result.data) === null;
  });
}

// The GraphQL client of the tracker scripts: a missing issue reads as null.
export function trackerGraphql(query, variables, run = execFileSync) {
  return ghGraphql(query, variables, { run, allowErrors: missingIssueOnly });
}

export function missingIssue(number) {
  return `Issue #${number} no longer exists in the repository; skipping`;
}

// A single-issue run whose issue was deleted or transferred out of the
// repository after the run was queued warns and succeeds.
export class MissingIssueError extends Error {
  constructor(number) {
    super(missingIssue(number));
    this.name = 'MissingIssueError';
  }
}

export const warning = (message) => console.log(`::warning::${message}`);

export async function discover(
  api,
  required = { Status: ['Inbox', 'Ready'], Priority: PRIORITIES, Size: SIZES },
) {
  let projectId;
  const fields = await paginate(async (cursor) => {
    const data = await api(
      `query($cursor: String) { user(login: "samlevin") { projectV2(number: 2) {
        id fields(first: 100, after: $cursor) { nodes {
          ... on ProjectV2SingleSelectField { id name options { id name } }
        } ${PAGE} }
      } } }`,
      { cursor },
    );
    const project = data.user?.projectV2;
    if (!project) throw new Error('Prismatic delivery project is unavailable');
    projectId = project.id;
    return project.fields;
  });
  const selected = {};
  for (const [name, options] of Object.entries(required)) {
    const matches = fields.filter((field) => field.name === name);
    if (matches.length !== 1)
      throw new Error(`Expected one ${name} single-select field`);
    const field = matches[0];
    for (const option of options) {
      if (field.options.filter((value) => value.name === option).length !== 1)
        throw new Error(`Missing or ambiguous ${name} option ${option}`);
    }
    selected[name] = field;
  }
  return { projectId, fields: selected };
}

// Statuses that eligible() never moves. The sweep filter excludes them by
// name, so an empty Status, Inbox, and any status added later still reach
// eligible(), which checks every condition again.
export const SETTLED_STATUSES = ['Ready', 'In progress', 'In review', 'Done'];
export const SWEEP_FILTER = `is:issue is:open -status:${SETTLED_STATUSES.map(
  (status) => (status.includes(' ') ? `"${status}"` : status),
).join(',')}`;

// The open issue items that can qualify for Ready, each with the first page of
// its field values and labels.
export async function listItems(api, projectId) {
  return paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String, $filter: String!) { node(id: $id) { ... on ProjectV2 {
        items(first: 100, after: $cursor, query: $filter) { nodes { ${ITEM} } ${PAGE} }
      } } }`,
      { id: projectId, cursor, filter: SWEEP_FILTER },
    );
    if (!data.node)
      throw new Error('Prismatic delivery project is unavailable');
    return data.node.items;
  });
}

// The unarchived project items of one issue, in the same shape as listItems.
export async function issueItems(api, number) {
  const [owner, name] = REPOSITORY.split('/');
  return paginate(async (cursor) => {
    const data = await api(
      `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) { issue(number: $number) {
          projectItems(first: 20, after: $cursor, includeArchived: false) {
            nodes { ${ITEM} } ${PAGE}
          }
        } }
      }`,
      { owner, name, number, cursor },
    );
    if (data.repository && data.repository.issue === null)
      throw new MissingIssueError(number);
    return data.repository?.issue?.projectItems ?? EMPTY;
  });
}

// Turns an item node from listItems, issueItems, or readItem into an item
// with named field values and label names, reading any remaining pages.
export async function completeItem(api, node, context) {
  if (!node?.id || node.project?.id !== context.projectId) return null;
  const values = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2Item {
        fieldValues(first: 100, after: $cursor) { ${VALUES} }
      } } }`,
      { id: node.id, cursor },
    );
    return data.node?.fieldValues ?? EMPTY;
  }, node.fieldValues);
  const fields = {};
  for (const [name, field] of Object.entries(context.fields)) {
    const value = values.find((value) => value.field?.id === field.id);
    fields[name] = field.options.find(
      (option) => option.id === value?.optionId,
    )?.name;
  }
  const item = { id: node.id, type: node.type, project: node.project, fields };
  if (node.type !== 'ISSUE' || node.content?.__typename !== 'Issue')
    return { ...item, content: node.content, labels: [] };
  const { labels: first, ...content } = node.content;
  const labels = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
        labels(first: 100, after: $cursor) { nodes { name } ${PAGE} }
      } } }`,
      { id: content.id, cursor },
    );
    return data.node?.labels ?? EMPTY;
  }, first);
  return { ...item, content, labels: labels.map((label) => label.name) };
}

export async function readItem(api, id, context) {
  const data = await api(
    `query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${ITEM} } } }`,
    { id },
  );
  return completeItem(api, data.node, context);
}

export async function updateProjectStatus(api, context, itemId, status) {
  const field = context.fields.Status;
  const options = field.options.filter((option) => option.name === status);
  if (options.length !== 1)
    throw new Error(`Missing or ambiguous Status option ${status}`);
  await api(
    `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item,
        fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
    }`,
    {
      project: context.projectId,
      item: itemId,
      field: field.id,
      option: options[0].id,
    },
  );
}

export async function reconcile({
  api,
  dryRun = true,
  issueNumber,
  log = console.log,
  warn = warning,
}) {
  if (
    issueNumber !== undefined &&
    (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
  )
    throw new Error('--issue requires a positive safe integer');
  const context = await discover(api);
  // One issue reads only its own project items; a sweep lists the project.
  const items =
    issueNumber === undefined
      ? await listItems(api, context.projectId)
      : await issueItems(api, issueNumber);
  let candidates = 0;
  let updated = 0;
  for (const listed of items) {
    if (listed.type === 'ISSUE' && !listed.content) {
      warn(`Project item ${listed.id} has no readable issue; skipping`);
      continue;
    }
    if (
      listed.type !== 'ISSUE' ||
      listed.content?.repository?.nameWithOwner !== REPOSITORY ||
      (issueNumber !== undefined && listed.content.number !== issueNumber)
    )
      continue;
    const item = await completeItem(api, listed, context);
    if (
      !item ||
      !eligible(item) ||
      (issueNumber !== undefined && item.content.number !== issueNumber)
    )
      continue;
    // Re-read the item's project fields and issue metadata at the write boundary.
    const fresh = await readItem(api, listed.id, context);
    if (!fresh) {
      warn(`Issue #${listed.content.number} left the project; skipping`);
      continue;
    }
    if (fresh.content?.repository?.nameWithOwner !== REPOSITORY) {
      warn(missingIssue(listed.content.number));
      continue;
    }
    if (
      !eligible(fresh) ||
      (issueNumber !== undefined && fresh.content.number !== issueNumber)
    )
      continue;
    candidates++;
    log(
      `${dryRun ? 'DRY_RUN would move' : 'Moving'} issue #${fresh.content.number} ${fresh.fields.Status ?? 'empty Status'} -> Ready`,
    );
    if (dryRun) continue;
    await updateProjectStatus(api, context, fresh.id, 'Ready');
    updated++;
  }
  log(
    `Triage reconciliation: ${candidates} eligible, ${updated} updated; DRY_RUN=${dryRun}`,
  );
  return { candidates, updated };
}

export async function reconcileEpicLabels({
  api,
  dryRun = true,
  issueNumber,
  log = console.log,
}) {
  const forbidden = new Set([
    'bug',
    'enhancement',
    'documentation',
    'question',
    'good first issue',
    'help wanted',
    'duplicate',
    'invalid',
    'wontfix',
  ]);
  const LABELS = `labels(first: 50) { nodes { id name } ${PAGE} }`;
  let epics;
  if (issueNumber === undefined)
    epics = await paginate(async (cursor) => {
      const data = await api(
        `query($cursor: String) { repository(owner: "samlevin", name: "prismatic") {
        issues(first: 100, after: $cursor, states: [OPEN, CLOSED], labels: ["epic"]) {
          nodes { id number ${LABELS} } ${PAGE}
        }
      } }`,
        { cursor },
      );
      return data.repository?.issues;
    });
  else {
    const data = await api(
      `query($number: Int!) { repository(owner: "samlevin", name: "prismatic") {
      issue(number: $number) { id number ${LABELS} }
    } }`,
      { number: issueNumber },
    );
    if (data.repository && data.repository.issue === null)
      throw new MissingIssueError(issueNumber);
    epics = data.repository?.issue ? [data.repository.issue] : [];
  }
  for (const epic of epics) {
    if (issueNumber !== undefined && epic.number !== issueNumber) continue;
    const labels = await paginate(async (cursor) => {
      const data = await api(
        `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
        labels(first: 100, after: $cursor) { nodes { id name } ${PAGE} }
      } } }`,
        { id: epic.id, cursor },
      );
      return data.node?.labels;
    }, epic.labels);
    if (!labels.some((label) => label.name === 'epic')) continue;
    const remove = labels.filter(
      (label) => forbidden.has(label.name) || label.name.startsWith('type:'),
    );
    if (!remove.length) continue;
    log(
      `${dryRun ? 'DRY_RUN would remove' : 'Removing'} ${remove.length} conflicting category labels from epic #${epic.number}`,
    );
    if (!dryRun)
      await api(
        `mutation($id: ID!, $labels: [ID!]!) {
      removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId }
    }`,
        { id: epic.id, labels: remove.map((label) => label.id) },
      );
  }
}

// A sweep skips when fewer GraphQL points than this remain, leaving the rest
// of the hourly budget to people and agents that share the token's account.
export const SWEEP_FLOOR = 1000;

// The REST rate_limit endpoint reports the GraphQL budget without spending it.
export function graphqlBudget(run = execFileSync) {
  const graphql = JSON.parse(ghRest(['rate_limit'], { run }))?.resources
    ?.graphql;
  for (const key of ['limit', 'remaining', 'used', 'reset'])
    if (!Number.isSafeInteger(graphql?.[key]))
      throw new Error('GitHub returned no GraphQL rate limit');
  const { limit, remaining, used, reset } = graphql;
  return { limit, remaining, used, reset };
}

// Runs one tracker task between two readings of the GraphQL budget and
// returns the exit code. A sweep skips below SWEEP_FLOOR. A single-issue run
// that hits the rate limit warns and succeeds, because the next scheduled
// sweep repeats its work. A run whose issue no longer exists in the
// repository warns and succeeds. Every other failure fails the run.
export async function runTracker({
  sweep,
  task,
  budget = graphqlBudget,
  log = console.log,
  warn = warning,
  error = console.error,
}) {
  const read = () => {
    try {
      return budget();
    } catch (cause) {
      warn(`Could not read the GraphQL budget: ${failureMessage(cause)}`);
      return null;
    }
  };
  const before = read();
  if (before)
    log(
      `GraphQL budget before: ${before.remaining} of ${before.limit} points remain; the window resets at ${new Date(before.reset * 1000).toISOString()}.`,
    );
  if (sweep && before && before.remaining < SWEEP_FLOOR) {
    warn(
      `Skipped the sweep: ${before.remaining} GraphQL points remain, below the floor of ${SWEEP_FLOOR}. The next scheduled sweep reconciles.`,
    );
    return 0;
  }
  let status = 0;
  try {
    await task();
  } catch (cause) {
    if (cause instanceof MissingIssueError) warn(cause.message);
    else if (
      !sweep &&
      cause instanceof GitHubError &&
      cause.kind === 'rate-limit'
    )
      warn(
        `${failureMessage(cause)} The next scheduled sweep reconciles this issue.`,
      );
    else {
      error(failureMessage(cause));
      status = 1;
    }
  }
  const after = read();
  if (before && after)
    log(
      after.reset === before.reset
        ? `GraphQL budget after: ${after.remaining} points remain; ${after.used - before.used} were used during the run, counting every client of this account.`
        : `GraphQL budget after: ${after.remaining} points remain; the window reset during the run.`,
    );
  return status;
}

const CLI = defineCli(
  'Usage: issue-triage.mjs / issue-containers.mjs [--dry-run | --apply] [--issue <number>]',
  ['dry-run', 'apply', 'issue'],
);

export function configuration(env, args) {
  const { options, positionals } = parseCli(args, CLI);
  if (positionals.length)
    throw cliError(
      CLI,
      'Use --dry-run or --apply with optional --issue <positive number>',
    );
  if (options['dry-run'] && options.apply)
    throw cliError(CLI, 'Use --dry-run or --apply once');
  let issueNumber;
  if (options.issue !== undefined) {
    if (
      !/^[1-9]\d*$/.test(options.issue) ||
      !Number.isSafeInteger(Number(options.issue))
    )
      throw cliError(CLI, '--issue requires one positive safe integer');
    issueNumber = Number(options.issue);
  }
  if (env.GITHUB_ACTIONS === 'true' && !env.PRISMATIC_PROJECT_TOKEN)
    throw new Error(
      'PRISMATIC_PROJECT_TOKEN is required for Projects access; GITHUB_TOKEN cannot access Projects.',
    );
  const setting = env.DRY_RUN ?? 'true';
  if (!['true', 'false'].includes(setting))
    throw new Error('DRY_RUN must be true or false');
  return {
    dryRun:
      options['dry-run'] === true || (!options.apply && setting === 'true'),
    ...(issueNumber === undefined ? {} : { issueNumber }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const config = configuration(process.env, process.argv.slice(2));
    if (process.env.GITHUB_ACTIONS === 'true')
      process.env.GH_TOKEN = process.env.PRISMATIC_PROJECT_TOKEN;
    process.exitCode = await runTracker({
      sweep: config.issueNumber === undefined,
      task: async () => {
        await reconcileEpicLabels({ api: trackerGraphql, ...config });
        await reconcile({ api: trackerGraphql, ...config });
      },
    });
  } catch (error) {
    if (error instanceof CliHelp) console.log(error.message);
    else {
      console.error(failureMessage(error));
      process.exitCode = 1;
    }
  }
}
