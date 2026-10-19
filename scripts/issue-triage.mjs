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

export async function paginate(fetchPage) {
  const nodes = [];
  let cursor = null;
  const seen = new Set();
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

export async function listItems(api, projectId) {
  return paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 {
        items(first: 100, after: $cursor) { nodes { ${CONTENT} } ${PAGE} }
      } } }`,
      { id: projectId, cursor },
    );
    return data.node?.items;
  });
}

export async function readItem(api, id, context) {
  let item;
  const values = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2Item {
        ${CONTENT} fieldValues(first: 100, after: $cursor) { nodes {
          ... on ProjectV2ItemFieldSingleSelectValue { optionId field {
            ... on ProjectV2SingleSelectField { id }
          } }
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

export async function reconcile({
  api,
  dryRun = true,
  issueNumber,
  log = console.log,
}) {
  if (
    issueNumber !== undefined &&
    (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
  )
    throw new Error('--issue requires a positive safe integer');
  const context = await discover(api);
  const items = await listItems(api, context.projectId);
  let candidates = 0;
  let updated = 0;
  for (const listed of items) {
    if (
      listed.type !== 'ISSUE' ||
      listed.content?.repository.nameWithOwner !== REPOSITORY ||
      (issueNumber !== undefined && listed.content.number !== issueNumber)
    )
      continue;
    const item = await readItem(api, listed.id, context);
    if (
      !item ||
      !eligible(item) ||
      (issueNumber !== undefined && item.content.number !== issueNumber)
    )
      continue;
    // Resolve current options and re-read both issue and project metadata at the write boundary.
    const freshContext = await discover(api);
    const fresh = await readItem(api, listed.id, freshContext);
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
    await updateProjectStatus(api, freshContext, fresh.id, 'Ready');
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
}) {
  if (
    issueNumber !== undefined &&
    (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
  )
    throw new Error('--issue requires a positive safe integer');
  const context = await discover(api, { Status: ['Ready', 'Done'] });
  const items = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 {
        items(first: 100, after: $cursor) { nodes { ${CONTENT}
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        } ${PAGE} }
      } } }`,
      { id: context.projectId, cursor },
    );
    return data.node?.items;
  });
  let candidates = 0;
  let updated = 0;
  for (const listed of items) {
    if (
      listed.type !== 'ISSUE' ||
      listed.content?.__typename !== 'Issue' ||
      listed.content.repository.nameWithOwner !== REPOSITORY ||
      !doneTarget(listed.content.state, listed.fieldValueByName?.name) ||
      (issueNumber !== undefined && listed.content.number !== issueNumber)
    )
      continue;
    // Re-read the issue state and Status at the write boundary.
    const fresh = await readItem(api, listed.id, context);
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
  const epics = await paginate(async (cursor) => {
    const data = await api(
      `query($cursor: String) { repository(owner: "samlevin", name: "prismatic") {
      issues(first: 100, after: $cursor, states: [OPEN, CLOSED], labels: ["epic"]) {
        nodes { id number } ${PAGE}
      }
    } }`,
      { cursor },
    );
    return data.repository?.issues;
  });
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

// Every pass the command line runs, in order.
export async function run(options) {
  await reconcileEpicLabels(options);
  await reconcile(options);
  await reconcileDone(options);
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
    await run({ api: ghGraphql, ...config });
  } catch (error) {
    console.error(failureMessage(error));
    process.exitCode = 1;
  }
}
