import { pathToFileURL } from 'node:url';
import { CliHelp } from './cli.mjs';
import { failureMessage, ghGraphql } from './github-api.mjs';
import {
  checkIssueNumber,
  configuration,
  discover,
  forIssue,
  MISSING_ISSUE,
  nestedNodes,
  paginate,
  REPOSITORY,
  skipGone,
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
    MISSING_ISSUE,
  );
  return withDetails(api, data.node);
}

// Every issue in the repository, plus the marker label's id. Marked issues
// carry their project items, so a status repair needs no extra read.
async function everyIssue(api, warn) {
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
    await skipGone(async () => {
      issues.set(issue.id, {
        ...(await withChildren(forIssue(api, `Issue #${issue.number}`), issue)),
        marked: false,
      });
    }, warn);
  for (const marked of markedIssues) {
    const issue = issues.get(marked.id);
    if (!issue) continue;
    await skipGone(async () => {
      issue.projectItems = await connection(
        forIssue(api, `Issue #${issue.number}`),
        marked.id,
        'projectItems',
        PROJECT_ITEM,
        marked.projectItems,
      );
      issue.marked = true;
    }, warn);
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

// The Status a marked container should have for its state.
function markedStatus(issue) {
  return issue.state === 'CLOSED' ? 'Done' : 'Ready';
}

function isComplete(issue) {
  return (
    issue.subIssuesSummary.total > 0 &&
    issue.subIssuesSummary.total === issue.subIssuesSummary.completed
  );
}

// Whether a marked container may need a write: an open one loses its marker,
// and a project item with the wrong Status needs a repair. Judged from the
// read alone, so a container that needs nothing costs no field discovery.
function needsRepair(issue) {
  return (
    issue.state === 'OPEN' ||
    issue.projectItems.some(
      (item) => item.fieldValueByName?.name !== markedStatus(issue),
    )
  );
}

// Sets the Status of an issue read with FULL. An item that already has the
// Status is left alone.
async function repairStatus(api, issue, status, context) {
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
  let loaded;
  if (issueNumber === undefined) loaded = await everyIssue(api, warn);
  else if (
    !(await skipGone(async () => {
      loaded = await issueChain(
        forIssue(api, `Issue #${issueNumber}`),
        issueNumber,
      );
    }, warn))
  )
    return { updated: 0 };
  if (!loaded) {
    warn(
      `Issue #${issueNumber} was not found; it may have been deleted or transferred. No container to reconcile.`,
    );
    return { updated: 0 };
  }
  const { label, issues } = loaded;
  const ordered = childrenFirst(issues);
  // Discovered only when a write needs the project fields.
  let context;
  const project = async () =>
    (context ??= await discover(api, { Status: ['Ready', 'Done'] }));
  const gone = (number) =>
    warn(
      `Container #${number} was not found; it may have been deleted or transferred. Skipping it.`,
    );
  const changed = new Set();
  let updated = 0;
  for (const id of ordered) {
    const listed = issues.get(id);
    const issueApi = forIssue(api, `Container #${listed.number}`);
    const mark = (mutation) =>
      issueApi(
        `mutation($id: ID!, $label: ID!) {
        ${mutation}(input: { labelableId: $id, labelIds: [$label] }) { clientMutationId }
      }`,
        { id, label },
      );
    // Another run may be about to close a complete container or may have
    // closed it again, and that run owns the marker, so only a fresh read of
    // an open, marked, incomplete container lets the marker go.
    const unmarkIfDue = async (latest) => {
      if (latest?.state === 'OPEN' && latest.marked && !isComplete(latest))
        await mark('removeLabelsFromLabelable');
    };
    await skipGone(async () => {
      // A sub-issue changed state in this run, so the summary read earlier is stale.
      const current = listed.children.some((child) => changed.has(child.id))
        ? await snapshot(issueApi, id)
        : listed;
      if (!current) return gone(listed.number);
      if (
        current.repository.nameWithOwner !== REPOSITORY ||
        !current.subIssuesSummary.total
      )
        return;
      const complete = isComplete(current);
      const marked = current.marked;
      const close = complete && current.state === 'OPEN';
      const reopen = !complete && current.state === 'CLOSED' && marked;
      if (close || reopen) {
        log(
          `${dryRun ? 'DRY_RUN would' : 'Will'} ${close ? 'close' : 'reopen'} container #${current.number}`,
        );
        if (dryRun) return;
        if (close && !marked) {
          // A sweep's listing can be old by now, so check the container still
          // exists before marking it.
          if (current === listed && issueNumber === undefined) {
            const before = await snapshot(issueApi, id);
            if (!before) return gone(listed.number);
            if (before.state !== 'OPEN' || !isComplete(before)) return;
          }
          // Mark before closing so a partial run can recover without losing automation ownership.
          await mark('addLabelsToLabelable');
        }
        const fresh = await snapshot(issueApi, id);
        if (!fresh) return gone(current.number);
        const stillComplete = isComplete(fresh);
        if (
          (close && (fresh.state !== 'OPEN' || !stillComplete)) ||
          (reopen &&
            (fresh.state !== 'CLOSED' || stillComplete || !fresh.marked))
        )
          return;
        await issueApi(
          close
            ? `mutation($id: ID!) { closeIssue(input: { issueId: $id, stateReason: COMPLETED }) { issue { id } } }`
            : `mutation($id: ID!) { reopenIssue(input: { issueId: $id }) { issue { id } } }`,
          { id },
        );
        changed.add(id);
        updated++;
        await skipGone(
          async () =>
            repairStatus(
              forIssue(api, `Container #${listed.number} project item`),
              fresh,
              close ? 'Done' : 'Ready',
              await project(),
            ),
          warn,
        );
        if (reopen) await unmarkIfDue(await snapshot(issueApi, id));
        return;
      }
      if (!marked || dryRun || !needsRepair(current)) return;
      // Repair status if a prior state mutation succeeded but its project
      // update failed. Another run may have changed the container since it was
      // listed, so act on a fresh read.
      const fresh = await snapshot(issueApi, id);
      if (!fresh?.marked) return;
      await repairStatus(issueApi, fresh, markedStatus(fresh), await project());
      await unmarkIfDue(fresh);
    }, warn);
  }
  log(`Container reconciliation: ${updated} state changes; DRY_RUN=${dryRun}`);
  return { updated };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const config = configuration(
      process.env,
      process.argv.slice(2),
      'issue-containers.mjs',
    );
    if (process.env.GITHUB_ACTIONS === 'true')
      process.env.GH_TOKEN = process.env.PRISMATIC_PROJECT_TOKEN;
    const options = { api: ghGraphql, ...config };
    await withinBudget(() => reconcileContainers(options), {
      ...options,
      name: 'Container',
    });
  } catch (error) {
    if (error instanceof CliHelp) console.log(error.message);
    else {
      console.error(failureMessage(error));
      process.exitCode = 1;
    }
  }
}
