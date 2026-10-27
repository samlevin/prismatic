import { CliHelp } from './cli.cjs';
import { pathToFileURL } from 'node:url';
import { failureMessage } from './github-api.mjs';
import {
  configuration,
  discover,
  MissingIssueError,
  missingIssue,
  paginate,
  REPOSITORY,
  runTracker,
  trackerGraphql,
  warning,
} from './issue-triage.mjs';

const MARKER = 'automation: container-closed';
const PAGE = 'pageInfo { hasNextPage endCursor }';
const ISSUE = `id number state repository { nameWithOwner }
  parent { id repository { nameWithOwner } } subIssuesSummary { total completed }`;
const ITEMS = `nodes { id project { id } fieldValueByName(name: "Status") {
  ... on ProjectV2ItemFieldSingleSelectValue { name }
} } ${PAGE}`;

const LABELS = `nodes { name } ${PAGE}`;
const CHILDREN = `nodes { ${ISSUE} } ${PAGE}`;

// Reads every page of one connection on an issue, such as `labels` with LABELS.
// Archived project items never take a Status write, so they are not read.
async function connection(api, id, field, selection) {
  const archived = field === 'projectItems' ? ', includeArchived: false' : '';
  return paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
      ${field}(first: 100, after: $cursor${archived}) { ${selection} }
    } } }`,
      { id, cursor },
    );
    return data.node?.[field];
  });
}

// Every issue in the repository, without nested connections, so one page of
// 100 issues costs one point. Parent links give the hierarchy.
async function everyIssue(api) {
  const issues = await paginate(async (cursor) => {
    const data = await api(
      `query($cursor: String) { repository(owner: "samlevin", name: "prismatic") {
      issues(first: 100, after: $cursor, states: [OPEN, CLOSED]) { nodes { ${ISSUE} } ${PAGE} }
    } }`,
      { cursor },
    );
    return data.repository?.issues;
  });
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const edges = new Map(
    issues
      .filter((issue) => issue.subIssuesSummary.total > 0)
      .map((issue) => [issue.id, []]),
  );
  for (const issue of issues)
    if (edges.has(issue.parent?.id)) edges.get(issue.parent.id).push(issue.id);
  return { byId, edges, selected: new Set(byId.keys()) };
}

// One issue, its sub-issue subtree, and its in-repository ancestors. Calls
// grow with that hierarchy, never with the repository.
async function issueHierarchy(api, number) {
  const data = await api(
    `query($number: Int!) { repository(owner: "samlevin", name: "prismatic") {
    issue(number: $number) { ${ISSUE} }
  } }`,
    { number },
  );
  const root = data.repository?.issue;
  if (!root) {
    if (data.repository) throw new MissingIssueError(number);
    throw new Error('Requested issue is unavailable');
  }
  const byId = new Map([[root.id, root]]);
  const edges = new Map();
  const selected = new Set();
  const pending = [root];
  while (pending.length) {
    const issue = pending.pop();
    if (selected.has(issue.id)) continue;
    selected.add(issue.id);
    if (!issue.subIssuesSummary.total) continue;
    edges.set(issue.id, []);
    for (const child of await connection(
      api,
      issue.id,
      'subIssues',
      CHILDREN,
    )) {
      if (child.repository.nameWithOwner !== REPOSITORY) continue;
      if (!byId.has(child.id)) byId.set(child.id, child);
      edges.get(issue.id).push(child.id);
      pending.push(byId.get(child.id));
    }
  }
  const seen = new Set([root.id]);
  let child = root;
  while (child.parent && child.parent.repository.nameWithOwner === REPOSITORY) {
    const id = child.parent.id;
    if (seen.has(id)) throw new Error('Issue hierarchy cycle');
    seen.add(id);
    let parent = byId.get(id);
    if (!parent) {
      const read = await api(
        `query($id: ID!) { node(id: $id) { ... on Issue { ${ISSUE} } } }`,
        { id },
      );
      parent = read.node;
      if (!parent?.id) break;
      byId.set(id, parent);
    }
    selected.add(id);
    if (!edges.has(id)) edges.set(id, []);
    if (!edges.get(id).includes(child.id)) edges.get(id).push(child.id);
    child = parent;
  }
  return { byId, edges, selected };
}

// The marker label and, for a sweep, every issue carrying it with its project
// items, so a sweep checks marked containers without one read per container.
async function marker(api, sweep) {
  if (!sweep) {
    const data = await api(
      `query { repository(owner: "samlevin", name: "prismatic") {
      label(name: "${MARKER}") { id }
    } }`,
      {},
    );
    const id = data.repository?.label?.id;
    if (!id) throw new Error(`Missing managed label ${MARKER}`);
    return { id };
  }
  let id;
  const issues = await paginate(async (cursor) => {
    const data = await api(
      `query($cursor: String) { repository(owner: "samlevin", name: "prismatic") {
      label(name: "${MARKER}") { id
        issues(first: 100, after: $cursor, states: [OPEN, CLOSED]) { nodes { id projectItems(first: 100, includeArchived: false) { ${ITEMS} } } ${PAGE} }
      }
    } }`,
      { cursor },
    );
    const label = data.repository?.label;
    if (!label?.id) throw new Error(`Missing managed label ${MARKER}`);
    id = label.id;
    return label.issues;
  });
  return {
    id,
    marked: new Map(
      issues.map((issue) => [
        issue.id,
        issue.projectItems.pageInfo.hasNextPage
          ? undefined
          : issue.projectItems.nodes.filter(Boolean),
      ]),
    ),
  };
}

// A fresh read of one container: state, completion, marker, and project items.
// Null when the issue was deleted.
async function snapshot(api, id) {
  const data = await api(
    `query($id: ID!) { node(id: $id) { ... on Issue { ${ISSUE}
    labels(first: 100) { ${LABELS} } projectItems(first: 100, includeArchived: false) { ${ITEMS} }
  } } }`,
    { id },
  );
  const issue = data.node;
  if (!issue?.id) return null;
  const labels = issue.labels.pageInfo.hasNextPage
    ? await connection(api, id, 'labels', LABELS)
    : issue.labels.nodes.filter(Boolean);
  const items = issue.projectItems.pageInfo.hasNextPage
    ? await connection(api, id, 'projectItems', ITEMS)
    : issue.projectItems.nodes.filter(Boolean);
  return {
    id: issue.id,
    number: issue.number,
    state: issue.state,
    repository: issue.repository,
    subIssuesSummary: issue.subIssuesSummary,
    marked: labels.some((label) => label.name === MARKER),
    items,
  };
}

export async function reconcileContainers({
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
  const sweep = issueNumber === undefined;
  const { byId, edges, selected } = sweep
    ? await everyIssue(api)
    : await issueHierarchy(api, issueNumber);
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Issue hierarchy cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of edges.get(id) ?? [])
      if (selected.has(child)) visit(child);
    visiting.delete(id);
    visited.add(id);
    if (edges.has(id)) ordered.push(id);
  }
  selected.forEach(visit);
  const label = await marker(api, sweep);
  let context;
  // The project item a status write would change, or undefined when none would.
  async function statusItem(record, status, onlyIfChanged) {
    context ??= await discover(api);
    const item = record.items.find(
      (item) => item.project?.id === context.projectId,
    );
    if (!item || (onlyIfChanged && item.fieldValueByName?.name === status))
      return undefined;
    return item;
  }
  async function setStatus(record, status, { onlyIfChanged = false } = {}) {
    const item = await statusItem(record, status, onlyIfChanged);
    if (!item) return;
    const field = context.fields.Status;
    const option = field.options.find((option) => option.name === status);
    if (!option) throw new Error(`Missing project status ${status}`);
    await api(
      `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item,
        fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
    }`,
      {
        project: context.projectId,
        item: item.id,
        field: field.id,
        option: option.id,
      },
    );
  }
  // A container deleted or transferred out of the repository during the run
  // is skipped with a warning.
  async function read(id) {
    const issue = await snapshot(api, id);
    if (issue?.repository.nameWithOwner === REPOSITORY) return issue;
    warn(missingIssue(byId.get(id).number));
    return null;
  }
  const changed = new Set();
  let updated = 0;
  for (const id of ordered) {
    // A sweep decides from its listing until a child's state changes in this
    // run; a single-issue run reads each container in its hierarchy.
    const stale = (edges.get(id) ?? []).some((child) => changed.has(child));
    // A decision from the listing is confirmed by a fresh read before its
    // first write, so a container deleted since the listing is skipped.
    const listed = sweep && !stale;
    let current = listed
      ? {
          ...byId.get(id),
          marked: label.marked.has(id),
          items: label.marked.get(id),
        }
      : await read(id);
    if (
      !current ||
      current.repository.nameWithOwner !== REPOSITORY ||
      !current.subIssuesSummary.total
    )
      continue;
    const complete =
      current.subIssuesSummary.total === current.subIssuesSummary.completed;
    const close = complete && current.state === 'OPEN';
    const reopen = !complete && current.state === 'CLOSED' && current.marked;
    if (close || reopen) {
      log(
        `${dryRun ? 'DRY_RUN would' : 'Will'} ${close ? 'close' : 'reopen'} container #${current.number}`,
      );
      if (dryRun) continue;
      // Mark before closing so a partial run can recover without losing automation ownership.
      if (close && !current.marked) {
        if (listed && !(await read(id))) continue;
        await api(
          `mutation($id: ID!, $label: ID!) {
        addLabelsToLabelable(input: { labelableId: $id, labelIds: [$label] }) { clientMutationId }
      }`,
          { id, label: label.id },
        );
      }
      const fresh = await read(id);
      if (!fresh) continue;
      const stillComplete =
        fresh.subIssuesSummary.total > 0 &&
        fresh.subIssuesSummary.total === fresh.subIssuesSummary.completed;
      if (
        (close && (fresh.state !== 'OPEN' || !stillComplete)) ||
        (reopen && (fresh.state !== 'CLOSED' || stillComplete || !fresh.marked))
      )
        continue;
      await api(
        close
          ? `mutation($id: ID!) { closeIssue(input: { issueId: $id, stateReason: COMPLETED }) { issue { id } } }`
          : `mutation($id: ID!) { reopenIssue(input: { issueId: $id }) { issue { id } } }`,
        { id },
      );
      changed.add(id);
      await setStatus(fresh, close ? 'Done' : 'Ready');
      updated++;
      // A closed container keeps its marker; a reopened one loses it below
      // unless it is closed or complete again by then.
      if (close) continue;
    } else if (current.marked && !dryRun) {
      // Repair status if a prior state mutation succeeded but its project update failed.
      if (
        !current.items ||
        (listed &&
          (await statusItem(
            current,
            current.state === 'CLOSED' ? 'Done' : 'Ready',
            true,
          )))
      )
        current = await read(id);
      if (!current) continue;
      if (current.marked)
        await setStatus(
          current,
          current.state === 'CLOSED' ? 'Done' : 'Ready',
          {
            onlyIfChanged: true,
          },
        );
      if (current.state !== 'OPEN' || !current.marked) continue;
    } else continue;
    // Runs for sibling issues reconcile the same container concurrently. A
    // container that is closed or complete again may belong to another run
    // that marked it and is about to close it, so it keeps the marker.
    const after = await read(id);
    if (
      after?.state === 'OPEN' &&
      after.marked &&
      after.subIssuesSummary.total !== after.subIssuesSummary.completed
    )
      await api(
        `mutation($id: ID!, $label: ID!) {
        removeLabelsFromLabelable(input: { labelableId: $id, labelIds: [$label] }) { clientMutationId }
      }`,
        { id, label: label.id },
      );
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
    process.exitCode = await runTracker({
      sweep: config.issueNumber === undefined,
      task: () => reconcileContainers({ api: trackerGraphql, ...config }),
    });
  } catch (error) {
    if (error instanceof CliHelp) console.log(error.message);
    else {
      console.error(failureMessage(error));
      process.exitCode = 1;
    }
  }
}
