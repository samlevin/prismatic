import { pathToFileURL } from 'node:url';
import {
  configuration,
  discover,
  ghGraphql,
  paginate,
  REPOSITORY,
} from './issue-triage.mjs';

const MARKER = 'automation: container-closed';
const PAGE = 'pageInfo { hasNextPage endCursor }';

async function containers(api) {
  return paginate(async (cursor) => {
    const data = await api(
      `query($cursor: String) { repository(owner: "samlevin", name: "prismatic") {
      issues(first: 100, after: $cursor, states: [OPEN, CLOSED]) { nodes {
        id number state parent { id repository { nameWithOwner } }
        subIssuesSummary { total completed }
      } ${PAGE} }
    } }`,
      { cursor },
    );
    return data.repository?.issues;
  });
}

async function children(api, id) {
  return paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
      subIssues(first: 100, after: $cursor) { nodes { id } ${PAGE} }
    } } }`,
      { id, cursor },
    );
    return data.node?.subIssues;
  });
}

async function snapshot(api, id) {
  let issue;
  const labels = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
      id number state repository { nameWithOwner } subIssuesSummary { total completed }
      labels(first: 100, after: $cursor) { nodes { id name } ${PAGE} }
    } } }`,
      { id, cursor },
    );
    issue = data.node;
    if (!issue) throw new Error('Container became inaccessible');
    return issue.labels;
  });
  return { ...issue, labels: { nodes: labels } };
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

export async function reconcileContainers({
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
  const all = await containers(api);
  const byId = new Map(all.map((issue) => [issue.id, issue]));
  const edges = new Map();
  for (const issue of all.filter((issue) => issue.subIssuesSummary.total > 0))
    edges.set(issue.id, await children(api, issue.id));
  const selected = new Set();
  function subtree(id) {
    if (selected.has(id)) return;
    selected.add(id);
    for (const child of edges.get(id) ?? [])
      if (byId.has(child.id)) subtree(child.id);
  }
  if (issueNumber !== undefined) {
    const issue = all.find((issue) => issue.number === issueNumber);
    if (!issue) throw new Error('Requested issue is unavailable');
    subtree(issue.id);
    let parent = issue.parent;
    const seen = new Set([issue.id]);
    while (parent && parent.repository.nameWithOwner === REPOSITORY) {
      if (seen.has(parent.id)) throw new Error('Issue hierarchy cycle');
      seen.add(parent.id);
      selected.add(parent.id);
      parent = byId.get(parent.id)?.parent;
    }
  } else all.forEach((issue) => selected.add(issue.id));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Issue hierarchy cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of edges.get(id) ?? [])
      if (selected.has(child.id)) visit(child.id);
    visiting.delete(id);
    visited.add(id);
    if (edges.has(id)) ordered.push(id);
  }
  selected.forEach(visit);
  const context = await discover(api);
  const labelData = await api(
    `query { repository(owner: "samlevin", name: "prismatic") {
    label(name: "${MARKER}") { id }
  } }`,
    {},
  );
  const label = labelData.repository?.label?.id;
  if (!label) throw new Error(`Missing managed label ${MARKER}`);
  let updated = 0;
  for (const id of ordered) {
    const current = await snapshot(api, id);
    if (
      !current ||
      current.repository.nameWithOwner !== REPOSITORY ||
      !current.subIssuesSummary.total
    )
      continue;
    const complete =
      current.subIssuesSummary.total === current.subIssuesSummary.completed;
    const marked = current.labels.nodes.some((label) => label.name === MARKER);
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
          (fresh?.state !== 'CLOSED' ||
            stillComplete ||
            !fresh?.labels.nodes.some((label) => label.name === MARKER)))
      )
        continue;
      await api(
        close
          ? `mutation($id: ID!) { closeIssue(input: { issueId: $id, stateReason: COMPLETED }) { issue { id } } }`
          : `mutation($id: ID!) { reopenIssue(input: { issueId: $id }) { issue { id } } }`,
        { id },
      );
      await projectStatus(api, id, close ? 'Done' : 'Ready', context);
      updated++;
    } else if (marked && !dryRun) {
      // Repair status if a prior state mutation succeeded but its project update failed.
      await projectStatus(
        api,
        id,
        current.state === 'CLOSED' ? 'Done' : 'Ready',
        context,
      );
    }
    const after = dryRun ? current : await snapshot(api, id);
    if (
      !dryRun &&
      after?.state === 'OPEN' &&
      after.labels.nodes.some((label) => label.name === MARKER)
    )
      await api(
        `mutation($id: ID!, $label: ID!) {
        removeLabelsFromLabelable(input: { labelableId: $id, labelIds: [$label] }) { clientMutationId }
      }`,
        { id, label },
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
    await reconcileContainers({ api: ghGraphql, ...config });
  } catch (error) {
    console.error(
      error.code || error.status
        ? 'GitHub API request failed; check issue and Projects permissions.'
        : error.message,
    );
    process.exitCode = 1;
  }
}
