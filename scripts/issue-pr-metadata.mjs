import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { failureMessage, ghGraphql } from './github-api.mjs';
import { paginate, REPOSITORY } from './issue-triage.mjs';

const PAGE = 'pageInfo { hasNextPage endCursor }';

// A referenced number that is not an issue or PR returns NOT_FOUND with null
// data; that response is expected and every other error still fails.
export function metadataGraphql(query, variables, run = execFileSync) {
  return ghGraphql(query, variables, {
    run,
    allowErrors: (result) =>
      query.includes('issueOrPullRequest(number:') &&
      result.errors.every(
        (error) =>
          error?.type === 'NOT_FOUND' &&
          error.path?.join('.') === 'repository.issueOrPullRequest',
      ) &&
      result.data?.repository?.issueOrPullRequest === null,
  });
}

export function referenceText(body) {
  return (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/(`+)[\s\S]*?\1(?!`)/g, '')
    .replace(/^(?: {4}|\t).*$/gm, '')
    .replace(/^.*\bparent\s+(?:issue|epic)\b.*$/gim, '');
}

export function linkedIssues(body, repository = REPOSITORY) {
  const text = referenceText(body);
  const numbers = new Set();
  const references =
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\b|([\w.-]+\/[\w.-]+)#([1-9]\d*)\b|(?<![\w/#])#([1-9]\d*)\b/g;
  for (const match of text.matchAll(references)) {
    const target = match[1] ?? match[3] ?? repository;
    const number = Number(match[2] ?? match[4] ?? match[5]);
    if (
      target.toLowerCase() === repository.toLowerCase() &&
      Number.isSafeInteger(number)
    )
      numbers.add(number);
  }
  return [...numbers];
}

export async function readMetadata(api, id) {
  const labels = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) {
        ... on Issue { labels(first: 100, after: $cursor) { nodes { id } ${PAGE} } }
        ... on PullRequest { labels(first: 100, after: $cursor) { nodes { id } ${PAGE} } }
      } }`,
      { id, cursor },
    );
    return data.node?.labels;
  });
  const assignees = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) {
        ... on Issue { assignees(first: 100, after: $cursor) { nodes { id } ${PAGE} } }
        ... on PullRequest { assignees(first: 100, after: $cursor) { nodes { id } ${PAGE} } }
      } }`,
      { id, cursor },
    );
    return data.node?.assignees;
  });
  return {
    labels: labels.map((label) => label.id),
    assignees: assignees.map((assignee) => assignee.id),
  };
}

// Release Please opens one rolling release PR from this branch of the
// repository itself; its body links every changelog entry.
export const RELEASE_BRANCH = 'release-please--branches--main';

export function isReleasePullRequest(pr) {
  return pr.headRefName === RELEASE_BRANCH && pr.isCrossRepository === false;
}

// Components whose version differs between two parsed manifests, in
// release-please-config.json order.
export function releasedComponents(config, base, head) {
  return Object.entries(config?.packages ?? {})
    .filter(
      ([path, settings]) =>
        settings?.component &&
        head?.[path] !== undefined &&
        head[path] !== base?.[path],
    )
    .map(([, settings]) => settings.component);
}

// The release PR gets one `package:` label per package whose version it
// changes. The component mapping comes from the base commit; the manifest is
// compared between the base and head commits.
export async function releaseLabels(api, pr, log) {
  const [owner, name] = REPOSITORY.split('/');
  const data = await api(
    `query($owner: String!, $name: String!, $config: String!, $base: String!, $head: String!) {
      repository(owner: $owner, name: $name) {
        config: object(expression: $config) { ... on Blob { text } }
        base: object(expression: $base) { ... on Blob { text } }
        head: object(expression: $head) { ... on Blob { text } }
      }
    }`,
    {
      owner,
      name,
      config: `${pr.baseRefOid}:release-please-config.json`,
      base: `${pr.baseRefOid}:.release-please-manifest.json`,
      head: `${pr.headRefOid}:.release-please-manifest.json`,
    },
  );
  const parse = (blob) => (blob?.text ? JSON.parse(blob.text) : {});
  const components = releasedComponents(
    parse(data.repository?.config),
    parse(data.repository?.base),
    parse(data.repository?.head),
  );
  log(
    `Release PR releases ${components.length ? components.join(', ') : 'no packages'}; issue labels are not copied.`,
  );
  const labels = [];
  for (const component of components) {
    const result = await api(
      `query($owner: String!, $name: String!, $label: String!) {
        repository(owner: $owner, name: $name) { label(name: $label) { id } }
      }`,
      { owner, name, label: `package: ${component}` },
    );
    const id = result.repository?.label?.id;
    if (id) labels.push(id);
    else log(`Label "package: ${component}" does not exist; skipping it.`);
  }
  return labels;
}

export async function copyMetadata({
  api,
  number,
  dryRun = true,
  log = console.log,
}) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('A positive pull request number is required');
  const [owner, name] = REPOSITORY.split('/');
  const variables = { owner, name, number };
  const data = await api(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        id body state milestone { id }
        headRefName headRefOid baseRefOid isCrossRepository
      } }
    }`,
    variables,
  );
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error('Pull request not found');
  if (pr.state !== 'OPEN') return;
  const release = isReleasePullRequest(pr);
  const numbers = linkedIssues(pr.body);
  if (!numbers.length && !release) return;
  const issues = [];
  for (const issueNumber of numbers) {
    const result = await api(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
          __typename ... on Issue { id milestone { id } }
        } }
      }`,
      { owner, name, number: issueNumber },
    );
    const linked = result.repository?.issueOrPullRequest;
    const issue = linked?.__typename === 'Issue' ? linked : null;
    // References to PRs or missing issues do not supply metadata.
    if (issue)
      issues.push({ ...issue, ...(await readMetadata(api, issue.id)) });
  }
  if (!issues.length && !release) return;
  const current = await readMetadata(api, pr.id);
  // The release PR body links every changelog entry, so its labels come from
  // the packages it releases instead of the issues it references.
  const sourceLabels = release
    ? await releaseLabels(api, pr, log)
    : issues.flatMap((issue) => issue.labels);
  const labels = [...new Set(sourceLabels)].filter(
    (id) => !current.labels.includes(id),
  );
  // The PR inherits whoever owns the issues it closes; nobody is assigned
  // to an issue by this script, and assignees already on the PR stay.
  const assignees = [
    ...new Set(issues.flatMap((issue) => issue.assignees)),
  ].filter((id) => !current.assignees.includes(id));
  const milestones = [
    ...new Set(issues.map((issue) => issue.milestone?.id).filter(Boolean)),
  ];
  if (milestones.length > 1)
    log(
      'Linked issues have conflicting milestones; leaving the PR milestone unchanged.',
    );
  const milestone =
    !pr.milestone && milestones.length === 1 ? milestones[0] : null;
  log(
    `PR #${number}: ${labels.length} labels, ${assignees.length} assignees, ${milestone ? 1 : 0} milestone to copy${dryRun ? ' (dry run)' : ''}.`,
  );
  if (dryRun) return;
  // A description edit during discovery must not apply stale issue metadata,
  // and a release PR push must not apply stale package labels.
  const fresh = await api(
    `query($id: ID!) { node(id: $id) { ... on PullRequest { body state milestone { id } headRefOid } } }`,
    { id: pr.id },
  );
  if (
    fresh.node?.body !== pr.body ||
    fresh.node.state !== 'OPEN' ||
    (release && fresh.node.headRefOid !== pr.headRefOid)
  )
    throw new Error(
      'Pull request changed during discovery; rerun reconciliation',
    );
  if (labels.length)
    await api(
      `mutation($id: ID!, $labels: [ID!]!) { addLabelsToLabelable(input: {labelableId: $id, labelIds: $labels}) { clientMutationId } }`,
      { id: pr.id, labels },
    );
  if (assignees.length)
    await api(
      `mutation($id: ID!, $assignees: [ID!]!) { addAssigneesToAssignable(input: {assignableId: $id, assigneeIds: $assignees}) { clientMutationId } }`,
      { id: pr.id, assignees },
    );
  if (milestone && !fresh.node.milestone)
    await api(
      `mutation($id: ID!, $milestone: ID!) { updatePullRequest(input: {pullRequestId: $id, milestoneId: $milestone}) { clientMutationId } }`,
      { id: pr.id, milestone },
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.env.GITHUB_ACTIONS === 'true') {
      if (!process.env.PRISMATIC_PROJECT_TOKEN)
        throw new Error('PRISMATIC_PROJECT_TOKEN is required.');
      if (process.env.GITHUB_REPOSITORY !== REPOSITORY)
        throw new Error('Unexpected repository');
      process.env.GH_TOKEN = process.env.PRISMATIC_PROJECT_TOKEN;
    }
    const mode = process.env.DRY_RUN ?? 'true';
    if (!['true', 'false'].includes(mode))
      throw new Error('DRY_RUN must be true or false');
    await copyMetadata({
      api: metadataGraphql,
      number: Number(process.env.PR_NUMBER),
      dryRun: mode === 'true',
    });
  } catch (error) {
    console.error(failureMessage(error));
    process.exitCode = 1;
  }
}
