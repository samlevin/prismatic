import { pathToFileURL } from 'node:url';
import { failureMessage, ghGraphql } from './github-api.mjs';
import {
  checkIssueNumber,
  configuration,
  discover,
  MISSING_ISSUE,
  nestedNodes,
  paginate,
  REPOSITORY,
  warning,
  withinBudget,
} from './issue-triage.mjs';

const MARKER = 'automation: container-closed';
const PAGE = 'pageInfo { hasNextPage endCursor }';
const CHILD = 'id repository { nameWithOwner } subIssuesSummary { total }';
const STATUS = `fieldValueByName(name: "Status") {
  ... on ProjectV2ItemFieldSingleSelectValue { name }
}`;
const PROJECT_ITEM = `id project { id } ${STATUS}`;
const PROJECT_ITEMS = `projectItems(first: 20) { nodes { ${PROJECT_ITEM} } ${PAGE} }`;
// Sub-issues come inside the issue query, so listing every issue costs one
// GraphQL point per 100 issues.
const ISSUE = `id number state repository { nameWithOwner }
  parent { id repository { nameWithOwner } }
  subIssuesSummary { total completed }
  subIssues(first: 50) { nodes { ${CHILD} } ${PAGE} }`;
// Everything a container decision needs about one issue.
const FULL = `${ISSUE} labels(first: 50) { nodes { name } ${PAGE} } ${PROJECT_ITEMS}`;

function connection(api, id, field, selection, value) {
  return nestedNodes(api, {
    id,
    type: 'Issue',
    field,
    selection,
    connection: value,
  });
}

// Adds the sub-issue list to an issue read with ISSUE.
async function withChildren(api, issue) {
  const { subIssues, ...rest } = issue;
  return {
    ...rest,
    children: await connection(api, issue.id, 'subIssues', CHILD, subIssues),
  };
}

// Adds the sub-issues, the marker label, and the project items to an issue
// read with FULL.
async function withDetails(api, issue) {
  if (!issue) return null;
  const { labels, projectItems, ...rest } = await withChildren(api, issue);
  const labelNodes = await connection(api, issue.id, 'labels', 'name', labels);
  return {
    ...rest,
    marked: labelNodes.some((label) => label.name === MARKER),
    projectItems: await connection(
      api,
      issue.id,
      'projectItems',
      PROJECT_ITEM,
      projectItems,
    ),
  };
}

async function snapshot(api, id) {
  const data = await api(
    `query($id: ID!) { node(id: $id) { ... on Issue { ${FULL} } } }`,
    { id },
  );
  return withDetails(api, data.node);
}

// Every issue in the repository, plus the marker label's id. Marked issues
// carry their project items, so a status repair needs no extra read.
async function everyIssue(api) {
  let label;
  const markedIssues = await paginate(async (cursor) => {
    const data = await api(
      `query($cursor: String) { repository(owner: "samlevin", name: "prismatic") {
        label(name: "${MARKER}") { id
          issues(first: 100, after: $cursor, states: [OPEN, CLOSED]) {
            nodes { id ${PROJECT_ITEMS} } ${PAGE}
          }
        }
      } }`,
      { cursor },
    );
    label = data.repository?.label;
    if (!label) throw new Error(`Missing managed label ${MARKER}`);
    return label.issues;
  });
  const listed = await paginate(async (cursor) => {
    const data = await api(
      `query($cursor: String) { repository(owner: "samlevin", name: "prismatic") {
        issues(first: 100, after: $cursor, states: [OPEN, CLOSED]) {
          nodes { ${ISSUE} } ${PAGE}
        }
      } }`,
      { cursor },
    );
    return data.repository?.issues;
  });
  const issues = new Map();
  for (const issue of listed)
    issues.set(issue.id, {
      ...(await withChildren(api, issue)),
      marked: false,
    });
  for (const marked of markedIssues) {
    const issue = issues.get(marked.id);
    if (!issue) continue;
    issue.marked = true;
    issue.projectItems = await connection(
      api,
      marked.id,
      'projectItems',
      PROJECT_ITEM,
      marked.projectItems,
    );
  }
  return { label: label.id, issues };
}

// One issue, the sub-issues under it that are containers, and its chain of
// parents in this repository: the issues whose state its change can affect.
// The reads grow with that chain, not with the repository. Returns null when
// GitHub cannot find the issue.
async function issueChain(api, number) {
  const data = await api(
    `query($number: Int!) { repository(owner: "samlevin", name: "prismatic") {
      label(name: "${MARKER}") { id }
      issue(number: $number) { ${FULL} }
    } }`,
    { number },
    MISSING_ISSUE,
  );
  const label = data.repository?.label?.id;
  if (!label) throw new Error(`Missing managed label ${MARKER}`);
  const root = await withDetails(api, data.repository.issue);
  if (!root) return null;
  const issues = new Map([[root.id, root]]);
  const queue = [root];
  while (queue.length) {
    for (const child of queue.shift().children) {
      if (
        child.repository.nameWithOwner !== REPOSITORY ||
        !child.subIssuesSummary.total ||
        issues.has(child.id)
      )
        continue;
      const container = await snapshot(api, child.id);
      if (!container) continue;
      issues.set(container.id, container);
      queue.push(container);
    }
  }
  const seen = new Set([root.id]);
  let parent = root.parent;
  while (parent && parent.repository.nameWithOwner === REPOSITORY) {
    if (seen.has(parent.id)) throw new Error('Issue hierarchy cycle');
    seen.add(parent.id);
    let issue = issues.get(parent.id);
    if (!issue) {
      issue = await snapshot(api, parent.id);
      if (!issue) break;
      issues.set(issue.id, issue);
    }
    parent = issue.parent;
  }
  return { label, issues };
}

// Containers in the loaded set, each after its loaded sub-issues.
function childrenFirst(issues) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Issue hierarchy cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of issues.get(id).children)
      if (issues.has(child.id)) visit(child.id);
    visiting.delete(id);
    visited.add(id);
    if (issues.get(id).subIssuesSummary.total > 0) ordered.push(id);
  }
  for (const id of issues.keys()) visit(id);
  return ordered;
}

async function setStatus(api, context, item, status) {
  const option = context.fields.Status.options.find(
    (option) => option.name === status,
  );
  if (!option) throw new Error(`Missing project status ${status}`);
  await api(
    `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
    updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item,
      fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
  }`,
    {
      project: context.projectId,
      item,
      field: context.fields.Status.id,
      option: option.id,
    },
  );
}

async function projectStatus(api, id, status, context) {
  const items = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
      projectItems(first: 100, after: $cursor) { nodes { id project { id } } ${PAGE} }
    } } }`,
      { id, cursor },
    );
    return data.node?.projectItems;
  });
  const item = items.find((item) => item.project.id === context.projectId);
  if (item) await setStatus(api, context, item.id, status);
}

// Sets the Status of a marked container whose project update may have failed
// after its state change. An item that already has the Status is left alone.
// The Status a marked container should have for its state.
function markedStatus(issue) {
  return issue.state === 'CLOSED' ? 'Done' : 'Ready';
}

// Whether a marked container needs a write: an open one loses its marker, and
// a project item with the wrong Status (or unknown items) needs a repair.
function needsRepair(issue, context) {
  if (issue.state === 'OPEN' || !issue.projectItems) return true;
  const item = issue.projectItems.find(
    (item) => item.project?.id === context.projectId,
  );
  return Boolean(item) && item.fieldValueByName?.name !== markedStatus(issue);
}

async function repairStatus(api, issue, status, context) {
  if (!issue.projectItems) return projectStatus(api, issue.id, status, context);
  const item = issue.projectItems.find(
    (item) => item.project?.id === context.projectId,
  );
  if (item && item.fieldValueByName?.name !== status)
    await setStatus(api, context, item.id, status);
}

export async function reconcileContainers({
  api,
  dryRun = true,
  issueNumber,
  log = console.log,
  warn = warning,
}) {
  checkIssueNumber(issueNumber);
  const loaded =
    issueNumber === undefined
      ? await everyIssue(api)
      : await issueChain(api, issueNumber);
  if (!loaded) {
    warn(
      `Issue #${issueNumber} was not found; it may have been deleted or transferred. No container to reconcile.`,
    );
    return { updated: 0 };
  }
  const { label, issues } = loaded;
  const ordered = childrenFirst(issues);
  const context = await discover(api, { Status: ['Ready', 'Done'] });
  const removeMarker = (id) =>
    api(
      `mutation($id: ID!, $label: ID!) {
        removeLabelsFromLabelable(input: { labelableId: $id, labelIds: [$label] }) { clientMutationId }
      }`,
      { id, label },
    );
  const changed = new Set();
  let updated = 0;
  for (const id of ordered) {
    const listed = issues.get(id);
    // A sub-issue changed state in this run, so the summary read earlier is stale.
    const current = listed.children.some((child) => changed.has(child.id))
      ? await snapshot(api, id)
      : listed;
    if (
      !current ||
      current.repository.nameWithOwner !== REPOSITORY ||
      !current.subIssuesSummary.total
    )
      continue;
    const complete =
      current.subIssuesSummary.total === current.subIssuesSummary.completed;
    const marked = current.marked;
    const close = complete && current.state === 'OPEN';
    const reopen = !complete && current.state === 'CLOSED' && marked;
    if (close || reopen) {
      log(
        `${dryRun ? 'DRY_RUN would' : 'Will'} ${close ? 'close' : 'reopen'} container #${current.number}`,
      );
      if (dryRun) continue;
      // Mark before closing so a partial run can recover without losing automation ownership.
      if (close && !marked)
        await api(
          `mutation($id: ID!, $label: ID!) {
        addLabelsToLabelable(input: { labelableId: $id, labelIds: [$label] }) { clientMutationId }
      }`,
          { id, label },
        );
      const fresh = await snapshot(api, id);
      const stillComplete =
        fresh?.subIssuesSummary.total > 0 &&
        fresh.subIssuesSummary.total === fresh.subIssuesSummary.completed;
      if (
        (close && (fresh?.state !== 'OPEN' || !stillComplete)) ||
        (reopen &&
          (fresh?.state !== 'CLOSED' || stillComplete || !fresh?.marked))
      )
        continue;
      await api(
        close
          ? `mutation($id: ID!) { closeIssue(input: { issueId: $id, stateReason: COMPLETED }) { issue { id } } }`
          : `mutation($id: ID!) { reopenIssue(input: { issueId: $id }) { issue { id } } }`,
        { id },
      );
      await projectStatus(api, id, close ? 'Done' : 'Ready', context);
      changed.add(id);
      updated++;
      // A reopened container is open and still marked.
      if (reopen) await removeMarker(id);
      continue;
    }
    if (!marked || dryRun || !needsRepair(current, context)) continue;
    // Repair status if a prior state mutation succeeded but its project
    // update failed. Another run may have changed the container since it was
    // listed, so act on a fresh read.
    const fresh = await snapshot(api, id);
    if (!fresh?.marked) continue;
    await repairStatus(api, fresh, markedStatus(fresh), context);
    if (fresh.state === 'OPEN') await removeMarker(id);
  }
  log(`Container reconciliation: ${updated} state changes; DRY_RUN=${dryRun}`);
  return { updated };
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
    await withinBudget(() => reconcileContainers(options), {
      ...options,
      name: 'Container',
    });
  } catch (error) {
    console.error(failureMessage(error));
    process.exitCode = 1;
  }
}
