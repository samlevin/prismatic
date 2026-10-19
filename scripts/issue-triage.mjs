import { pathToFileURL } from 'node:url';
import { failureMessage, ghGraphql } from './github-api.mjs';

export const REPOSITORY = 'samlevin/prismatic';
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'none'].map(
  (value) => `severity: ${value}`,
);
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SIZES = ['XS', 'S', 'M', 'L'];
const PAGE = 'pageInfo { hasNextPage endCursor }';
const CONTENT = `id type project { id } content {
  __typename ... on Issue { id number state repository { nameWithOwner } }
}`;
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
  { id, type, field, selection, connection },
) {
  if (!connection) throw new Error(`Missing GraphQL connection ${field}`);
  const nodes = connection.nodes.filter(Boolean);
  if (!connection.pageInfo.hasNextPage) return nodes;
  const rest = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ${type} {
        ${field}(first: 100, after: $cursor) { nodes { ${selection} } ${PAGE} }
      } } }`,
      { id, cursor },
    );
    return data.node?.[field];
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

// Lets a query for one issue by number succeed when GitHub answers NOT_FOUND
// for it, as it does for a deleted or transferred issue, so the issue reads
// as null. Any other error still throws.
export const MISSING_ISSUE = {
  allowErrors: (json) =>
    json.errors.every(
      (error) =>
        error?.type === 'NOT_FOUND' &&
        Array.isArray(error.path) &&
        error.path.join('.') === 'repository.issue',
    ),
};

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

// Lists every project item with its field values and labels, 100 items a
// query.
export async function listItems(api, context) {
  const items = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 {
        items(first: 100, after: $cursor) { nodes { ${ITEM} } ${PAGE} }
      } } }`,
      { id: context.projectId, cursor },
    );
    return data.node?.items;
  });
  const result = [];
  for (const item of items) {
    const read = await itemFields(api, item, context);
    if (read) result.push(read);
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
        ${LABELS} projectItems(first: 20) { nodes { ${ITEM} } ${PAGE} }
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
  });
  const listed = items.find((item) => item.project?.id === context.projectId);
  return {
    issue: { id: issue.id, number: issue.number, labels },
    item: listed ? await itemFields(api, listed, context) : null,
  };
}

async function itemsInScope(api, context, issueNumber) {
  if (issueNumber === undefined) return listItems(api, context);
  const found = await readIssue(api, issueNumber, context);
  return found?.item ? [found.item] : [];
}

export async function readItem(api, id, context) {
  let item;
  const values = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2Item {
        ${CONTENT} fieldValues(first: 100, after: $cursor) { nodes {
          ${VALUE}
        } ${PAGE} }
      } } }`,
      { id, cursor },
    );
    item = data.node;
    return item?.fieldValues ?? { nodes: [], pageInfo: { hasNextPage: false } };
  });
  if (!item?.id || item.project?.id !== context.projectId) return null;
  item.fields = {};
  for (const [name, field] of Object.entries(context.fields)) {
    const value = values.find((value) => value.field?.id === field.id);
    item.fields[name] = field.options.find(
      (option) => option.id === value?.optionId,
    )?.name;
  }
  item.labels = [];
  if (item.type !== 'ISSUE' || item.content?.__typename !== 'Issue')
    return item;
  let issue;
  item.labels = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
        id number state __typename repository { nameWithOwner }
        labels(first: 100, after: $cursor) { nodes { name } ${PAGE} }
      } } }`,
      { id: item.content.id, cursor },
    );
    issue = data.node;
    return issue?.labels ?? { nodes: [], pageInfo: { hasNextPage: false } };
  });
  item.labels = item.labels.map((label) => label.name);
  item.content = issue;
  return item;
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
  context,
  items,
}) {
  checkIssueNumber(issueNumber);
  context ??= await discover(api);
  items ??= await itemsInScope(api, context, issueNumber);
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
    if (
      !fresh ||
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
  context,
  items,
}) {
  checkIssueNumber(issueNumber);
  context ??= await discover(api, { Status: ['Ready', 'Done'] });
  items ??= await itemsInScope(api, context, issueNumber);
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
    const target =
      fresh && doneTarget(fresh.content?.state, fresh.fields.Status);
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
  const options = { api, dryRun, issueNumber, log, context };
  if (issueNumber === undefined) {
    const items = await listItems(api, context);
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

export async function rateLimit(api) {
  const data = await api(
    'query { rateLimit { limit remaining used resetAt } }',
    {},
  );
  if (!data?.rateLimit)
    throw new Error('GitHub returned no GraphQL rate limit');
  return data.rateLimit;
}

// A GitHub Actions warning annotation, which shows on the run summary.
export function warning(message) {
  console.log(`::warning::${message}`);
}

// Runs `work` within the GraphQL budget. A sweep (no issue number) reads the
// rate limit first, skips with a warning when fewer than MIN_REMAINING points
// remain, and logs the points before and after; any error fails it. A run for
// one issue skips the rate-limit reads, and when it hits the rate limit it
// warns and returns, because the next sweep applies the same change. Its other
// errors still throw.
export async function withinBudget(
  work,
  { api, issueNumber, name, log = console.log, warn = warning },
) {
  if (issueNumber !== undefined) {
    try {
      await work();
      return 'done';
    } catch (error) {
      if (error?.kind !== 'rate_limit') throw error;
      warn(
        `${name} skipped issue #${issueNumber}: ${failureMessage(error)} The next scheduled sweep reconciles it.`,
      );
      return 'rate-limited';
    }
  }
  const before = await rateLimit(api);
  if (before.remaining < MIN_REMAINING) {
    warn(
      `${name} sweep skipped: ${before.remaining} GraphQL points remain, under ${MIN_REMAINING}. The budget resets at ${before.resetAt}.`,
    );
    return 'skipped';
  }
  await work();
  const after = await rateLimit(api);
  log(
    after.resetAt === before.resetAt
      ? `${name} sweep GraphQL points: ${before.remaining} remaining before, ${after.remaining} after, ${before.remaining - after.remaining} used, counting other clients of the token`
      : `${name} sweep GraphQL points: ${before.remaining} remaining before, ${after.remaining} after the budget reset at ${before.resetAt}`,
  );
  return 'done';
}

export function configuration(env, args) {
  if (env.GITHUB_ACTIONS === 'true' && !env.PRISMATIC_PROJECT_TOKEN)
    throw new Error(
      'PRISMATIC_PROJECT_TOKEN is required for Projects access; GITHUB_TOKEN cannot access Projects.',
    );
  let mode;
  let issueNumber;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run' || arg === '--apply') {
      if (mode) throw new Error('Use --dry-run or --apply once');
      mode = arg;
    } else if (arg === '--issue') {
      const number = args[++index];
      if (
        issueNumber !== undefined ||
        !/^[1-9]\d*$/.test(number ?? '') ||
        !Number.isSafeInteger(Number(number))
      )
        throw new Error('--issue requires one positive safe integer');
      issueNumber = Number(number);
    } else {
      throw new Error(
        'Use --dry-run or --apply with optional --issue <positive number>',
      );
    }
  }
  const setting = env.DRY_RUN ?? 'true';
  if (!['true', 'false'].includes(setting))
    throw new Error('DRY_RUN must be true or false');
  return {
    dryRun: mode === '--dry-run' || (mode !== '--apply' && setting === 'true'),
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
    const options = { api: ghGraphql, ...config };
    await withinBudget(() => run(options), { ...options, name: 'Triage' });
  } catch (error) {
    console.error(failureMessage(error));
    process.exitCode = 1;
  }
}
