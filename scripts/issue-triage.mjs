import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CliHelp, cliError, defineCli, parseCli } from './cli.mjs';
import { failureMessage, ghGraphql, ghRest } from './github-api.mjs';

export const REPOSITORY = 'samlevin/prismatic';
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'none'].map(
  (value) => `severity: ${value}`,
);
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SIZES = ['XS', 'S', 'M', 'L'];
const PAGE = 'pageInfo { hasNextPage endCursor }';
const EMPTY = { nodes: [], pageInfo: { hasNextPage: false } };
// Nested connections come inside their page query, so a sweep costs a few
// GraphQL points whatever the project size. A nested connection gets its own
// query only when it has another page.
const NESTED = 50;
const VALUE = `... on ProjectV2ItemFieldSingleSelectValue { optionId field {
  ... on ProjectV2SingleSelectField { id }
} }`;
const LABELS = `labels(first: ${NESTED}) { nodes { id name } ${PAGE} }`;
const ITEM = `id type project { id }
  fieldValues(first: ${NESTED}) { nodes { ${VALUE} } ${PAGE} }
  content { __typename ... on Issue {
    id number state repository { nameWithOwner } ${LABELS}
  } }`;
// A sweep is skipped when fewer GraphQL points than this remain in the
// token's hourly budget, which people and local agents share.
export const MIN_REMAINING = 1000;

export function eligible(item) {
  const severity = item.labels.filter((label) => label.startsWith('severity:'));
  return (
    item.type === 'ISSUE' &&
    item.content?.__typename === 'Issue' &&
    item.content.repository.nameWithOwner === REPOSITORY &&
    item.content.state === 'OPEN' &&
    item.fields.Status === 'Inbox' &&
    PRIORITIES.includes(item.fields.Priority) &&
    severity.length === 1 &&
    SEVERITIES.includes(severity[0]) &&
    SIZES.includes(item.fields.Size)
  );
}

// Collects every node of a connection, starting after `cursor` when one is
// given.
export async function paginate(fetchPage, cursor = null) {
  const nodes = [];
  const seen = new Set(cursor ? [cursor] : []);
  while (true) {
    const connection = await fetchPage(cursor);
    if (!connection) throw new Error('Missing GraphQL connection');
    nodes.push(...connection.nodes.filter(Boolean));
    if (!connection.pageInfo.hasNextPage) return nodes;
    cursor = connection.pageInfo.endCursor;
    if (!cursor || seen.has(cursor))
      throw new Error('Pagination cursor did not advance');
    seen.add(cursor);
  }
}

// Returns every node of a connection fetched inside another query, reading
// the pages after the first through `node(id)` only when there are more.
export async function nestedNodes(
  api,
  { id, type, field, selection, connection, args = '' },
) {
  if (!connection) throw new Error(`Missing GraphQL connection ${field}`);
  const nodes = connection.nodes.filter(Boolean);
  if (!connection.pageInfo.hasNextPage) return nodes;
  const rest = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ${type} {
        ${field}(first: 100, after: $cursor${args}) { nodes { ${selection} } ${PAGE} }
      } } }`,
      { id, cursor },
    );
    return data.node?.[field] ?? EMPTY;
  }, connection.pageInfo.endCursor);
  return [...nodes, ...rest];
}

export function checkIssueNumber(issueNumber) {
  if (
    issueNumber !== undefined &&
    (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
  )
    throw new Error('--issue requires a positive safe integer');
}

// GitHub answers a read of an issue that was deleted or transferred out of
// the repository with a null `issue`, `issueOrPullRequest`, `node`, or
// `content` field and a NOT_FOUND error at that field's path. This lets such
// a read return the null; any other error, including a missing repository or
// project, still throws.
const ISSUE_FIELDS = new Set([
  'issue',
  'issueOrPullRequest',
  'node',
  'content',
]);
export const MISSING_ISSUE = {
  allowErrors: (json) =>
    json.errors.every((error) => {
      const path = error?.path;
      if (
        error?.type !== 'NOT_FOUND' ||
        !Array.isArray(path) ||
        !ISSUE_FIELDS.has(path.at(-1))
      )
        return false;
      return path.reduce((value, key) => value?.[key], json.data) === null;
    }),
};

export function missingIssue(number) {
  return `Issue #${number} no longer exists in the repository; skipping`;
}

// The GraphQL client of the tracker scripts: a missing issue reads as null on
// every call, and any other error still fails.
export function trackerGraphql(query, variables, options) {
  return ghGraphql(query, variables, {
    ...options,
    allowErrors: (json) =>
      MISSING_ISSUE.allowErrors(json) || Boolean(options?.allowErrors?.(json)),
  });
}

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

// Turns a project item read with ITEM into the shape readItem returns: the
// discovered fields by name and the issue's label names.
async function itemFields(api, item, context) {
  if (!item?.id || item.project?.id !== context.projectId) return null;
  const values = await nestedNodes(api, {
    id: item.id,
    type: 'ProjectV2Item',
    field: 'fieldValues',
    selection: VALUE,
    connection: item.fieldValues,
  });
  const fields = {};
  for (const [name, field] of Object.entries(context.fields)) {
    const value = values.find((value) => value.field?.id === field.id);
    fields[name] = field.options.find(
      (option) => option.id === value?.optionId,
    )?.name;
  }
  let labels = [];
  if (item.type === 'ISSUE' && item.content?.__typename === 'Issue')
    labels = (
      await nestedNodes(api, {
        id: item.content.id,
        type: 'Issue',
        field: 'labels',
        selection: 'id name',
        connection: item.content.labels,
      })
    ).map((label) => label.name);
  const read = { ...item, fields, labels };
  delete read.fieldValues;
  return read;
}

// GitHub filters a sweep's listing to the items a pass can act on: closed
// issues outside Done, and open issues in Inbox or Done. Each pass still
// checks every condition itself.
export const SWEEP_FILTERS = [
  'is:issue is:closed -status:Done',
  'is:issue is:open status:Inbox,Done',
];

// Lists the project items that match each filter, with their field values
// and labels, 100 items a query.
export async function listItems(
  api,
  context,
  { filters = SWEEP_FILTERS, warn = warning } = {},
) {
  const result = [];
  for (const filter of filters) {
    const items = await paginate(async (cursor) => {
      const data = await api(
        `query($id: ID!, $cursor: String, $filter: String!) { node(id: $id) { ... on ProjectV2 {
          items(first: 100, after: $cursor, query: $filter) { nodes { ${ITEM} } ${PAGE} }
        } } }`,
        { id: context.projectId, cursor, filter },
      );
      return data.node?.items;
    });
    for (const item of items) {
      if (item.type === 'ISSUE' && !item.content) {
        warn(`Project item ${item.id} has no readable issue; skipping`);
        continue;
      }
      const read = await itemFields(api, item, context);
      if (read && !result.some((listed) => listed.id === read.id))
        result.push(read);
    }
  }
  return result;
}

// Reads one issue with its labels and its item on the project, or returns
// null when the issue does not exist. `item` is null when the issue is not on
// the project.
export async function readIssue(api, number, context) {
  const data = await api(
    `query($number: Int!) { repository(owner: "samlevin", name: "prismatic") {
      issue(number: $number) { id number state repository { nameWithOwner }
        ${LABELS} projectItems(first: 20, includeArchived: false) { nodes { ${ITEM} } ${PAGE} }
      }
    } }`,
    { number },
    MISSING_ISSUE,
  );
  const issue = data.repository?.issue;
  if (!issue) return null;
  const labels = await nestedNodes(api, {
    id: issue.id,
    type: 'Issue',
    field: 'labels',
    selection: 'id name',
    connection: issue.labels,
  });
  const items = await nestedNodes(api, {
    id: issue.id,
    type: 'Issue',
    field: 'projectItems',
    selection: ITEM,
    connection: issue.projectItems,
    args: ', includeArchived: false',
  });
  const listed = items.find((item) => item.project?.id === context.projectId);
  return {
    issue: { id: issue.id, number: issue.number, labels },
    item: listed ? await itemFields(api, listed, context) : null,
  };
}

async function itemsInScope(api, context, issueNumber, warn) {
  if (issueNumber === undefined) return listItems(api, context, { warn });
  const found = await readIssue(api, issueNumber, context);
  return found?.item ? [found.item] : [];
}

export async function readItem(api, id, context) {
  const data = await api(
    `query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${ITEM} } } }`,
    { id },
    MISSING_ISSUE,
  );
  return itemFields(api, data.node, context);
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

// Moves triaged issues from Inbox to Ready. `context` and `items` let run()
// share one discovery and one listing across passes. With `issueNumber`, only
// that issue's project item is read.
export async function reconcile({
  api,
  dryRun = true,
  issueNumber,
  log = console.log,
  warn = warning,
  context,
  items,
}) {
  checkIssueNumber(issueNumber);
  context ??= await discover(api);
  items ??= await itemsInScope(api, context, issueNumber, warn);
  let candidates = 0;
  let updated = 0;
  for (const item of items) {
    if (
      !eligible(item) ||
      (issueNumber !== undefined && item.content.number !== issueNumber)
    )
      continue;
    // Re-read both issue and project metadata at the write boundary.
    const fresh = await readItem(api, item.id, context);
    if (!fresh) {
      warn(`Issue #${item.content.number} left the project; skipping`);
      continue;
    }
    if (fresh.content?.repository?.nameWithOwner !== REPOSITORY) {
      warn(missingIssue(item.content.number));
      continue;
    }
    if (
      !eligible(fresh) ||
      (issueNumber !== undefined && fresh.content.number !== issueNumber)
    )
      continue;
    candidates++;
    log(
      `${dryRun ? 'DRY_RUN would move' : 'Moving'} issue #${fresh.content.number} Inbox -> Ready`,
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

// The Status an issue must have for its state: Done when closed, Ready when
// reopened out of Done, otherwise none.
function doneTarget(state, status) {
  if (state === 'CLOSED' && status !== 'Done') return 'Done';
  if (state === 'OPEN' && status === 'Done') return 'Ready';
  return undefined;
}

// Keeps Done equal to closed: moves every closed issue on the board to Done,
// whatever its Status, and every reopened issue still in Done back to Ready.
// The project's built-in "Item closed" workflow is off, and the API cannot
// turn it on. The listing carries each item's Status, so only issues that need
// a move cost a per-item read.
export async function reconcileDone({
  api,
  dryRun = true,
  issueNumber,
  log = console.log,
  warn = warning,
  context,
  items,
}) {
  checkIssueNumber(issueNumber);
  context ??= await discover(api, { Status: ['Ready', 'Done'] });
  items ??= await itemsInScope(api, context, issueNumber, warn);
  let candidates = 0;
  let updated = 0;
  for (const item of items) {
    if (
      item.type !== 'ISSUE' ||
      item.content?.__typename !== 'Issue' ||
      item.content.repository.nameWithOwner !== REPOSITORY ||
      !doneTarget(item.content.state, item.fields.Status) ||
      (issueNumber !== undefined && item.content.number !== issueNumber)
    )
      continue;
    // Re-read the issue state and Status at the write boundary.
    const fresh = await readItem(api, item.id, context);
    if (!fresh) {
      warn(`Issue #${item.content.number} left the project; skipping`);
      continue;
    }
    if (fresh.content?.repository?.nameWithOwner !== REPOSITORY) {
      warn(missingIssue(item.content.number));
      continue;
    }
    const target = doneTarget(fresh.content?.state, fresh.fields.Status);
    if (!target) continue;
    candidates++;
    log(
      `${dryRun ? 'DRY_RUN would move' : 'Moving'} ${target === 'Done' ? 'closed' : 'reopened'} issue #${fresh.content.number} ${fresh.fields.Status ?? 'without Status'} -> ${target}`,
    );
    if (dryRun) continue;
    await updateProjectStatus(api, context, fresh.id, target);
    updated++;
  }
  log(
    `Done reconciliation: ${candidates} eligible, ${updated} updated; DRY_RUN=${dryRun}`,
  );
  return { candidates, updated };
}

async function issueLabels(api, number) {
  const data = await api(
    `query($number: Int!) { repository(owner: "samlevin", name: "prismatic") {
      issue(number: $number) { id number ${LABELS} }
    } }`,
    { number },
    MISSING_ISSUE,
  );
  const issue = data.repository?.issue;
  return issue ? [issue] : [];
}

// Removes category labels that conflict with the epic label. `epics` lets
// run() pass an issue it already read.
export async function reconcileEpicLabels({
  api,
  dryRun = true,
  issueNumber,
  log = console.log,
  epics,
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
  epics ??=
    issueNumber === undefined
      ? await paginate(async (cursor) => {
          const data = await api(
            `query($cursor: String) { repository(owner: "samlevin", name: "prismatic") {
              issues(first: 100, after: $cursor, states: [OPEN, CLOSED], labels: ["epic"]) {
                nodes { id number ${LABELS} } ${PAGE}
              }
            } }`,
            { cursor },
          );
          return data.repository?.issues;
        })
      : await issueLabels(api, issueNumber);
  for (const epic of epics) {
    if (issueNumber !== undefined && epic.number !== issueNumber) continue;
    const labels = Array.isArray(epic.labels)
      ? epic.labels
      : await nestedNodes(api, {
          id: epic.id,
          type: 'Issue',
          field: 'labels',
          selection: 'id name',
          connection: epic.labels,
        });
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

// Every pass the command line runs, in order. They share one field discovery
// and one read: the whole project for a sweep, or the one issue and its item
// with `issueNumber`.
export async function run({
  api,
  dryRun = true,
  issueNumber,
  log = console.log,
  warn = warning,
}) {
  checkIssueNumber(issueNumber);
  const context = await discover(api, {
    Status: ['Inbox', 'Ready', 'Done'],
    Priority: PRIORITIES,
    Size: SIZES,
  });
  const options = { api, dryRun, issueNumber, log, warn, context };
  if (issueNumber === undefined) {
    const items = await listItems(api, context, { warn });
    await reconcileEpicLabels(options);
    await reconcile({ ...options, items });
    await reconcileDone({ ...options, items });
    return;
  }
  const found = await readIssue(api, issueNumber, context);
  if (!found)
    warn(
      `Issue #${issueNumber} was not found; it may have been deleted or transferred. Nothing to triage.`,
    );
  const items = found?.item ? [found.item] : [];
  await reconcileEpicLabels({ ...options, epics: found ? [found.issue] : [] });
  await reconcile({ ...options, items });
  await reconcileDone({ ...options, items });
}

// A GitHub Actions warning annotation, which shows on the run summary.
export function warning(message) {
  console.log(`::warning::${message}`);
}

// The REST rate_limit endpoint reports the GraphQL budget without spending
// any of it.
export function graphqlBudget(run = execFileSync) {
  let graphql;
  try {
    graphql = JSON.parse(ghRest(['rate_limit'], { run }))?.resources?.graphql;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  for (const key of ['limit', 'remaining', 'used', 'reset'])
    if (!Number.isSafeInteger(graphql?.[key]))
      throw new Error('GitHub returned no GraphQL rate limit');
  const { limit, remaining, used, reset } = graphql;
  return {
    limit,
    remaining,
    used,
    resetAt: new Date(reset * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

// Runs `work` between two readings of the GraphQL budget and logs the points
// it used. A sweep (no issue number) skips with a warning when fewer than
// MIN_REMAINING points remain, and fails on any error. A run for one issue
// warns and returns when it hits the rate limit, because the next sweep
// applies the same change; its other errors still throw. A budget that cannot
// be read is a warning, never a failure.
export async function withinBudget(
  work,
  {
    budget = graphqlBudget,
    issueNumber,
    name,
    log = console.log,
    warn = warning,
  },
) {
  const read = () => {
    try {
      return budget();
    } catch (error) {
      warn(
        `${name} could not read the GraphQL budget: ${failureMessage(error)}`,
      );
      return null;
    }
  };
  const sweep = issueNumber === undefined;
  const subject = sweep ? `${name} sweep` : `${name} issue #${issueNumber}`;
  const before = read();
  if (sweep && before && before.remaining < MIN_REMAINING) {
    warn(
      `${name} sweep skipped: ${before.remaining} GraphQL points remain, under ${MIN_REMAINING}. The budget resets at ${before.resetAt}.`,
    );
    return 'skipped';
  }
  let result = 'done';
  try {
    await work();
  } catch (error) {
    if (sweep || error?.kind !== 'rate_limit') throw error;
    warn(
      `${name} skipped issue #${issueNumber}: ${failureMessage(error)} The next scheduled sweep reconciles it.`,
    );
    result = 'rate-limited';
  }
  const after = read();
  if (before && after)
    log(
      after.resetAt === before.resetAt
        ? `${subject} GraphQL points: ${before.remaining} remaining before, ${after.remaining} after, ${after.used - before.used} used, counting other clients of the token`
        : `${subject} GraphQL points: ${before.remaining} remaining before, ${after.remaining} after the budget reset at ${before.resetAt}`,
    );
  return result;
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
    const options = { api: trackerGraphql, ...config };
    await withinBudget(() => run(options), { ...options, name: 'Triage' });
  } catch (error) {
    if (error instanceof CliHelp) console.log(error.message);
    else {
      console.error(failureMessage(error));
      process.exitCode = 1;
    }
  }
}
