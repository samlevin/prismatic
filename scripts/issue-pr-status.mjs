import { pathToFileURL } from 'node:url';
import {
  linkedIssues,
  metadataGraphql,
  referenceText,
} from './issue-pr-metadata.mjs';
import {
  discover,
  paginate,
  readItem,
  REPOSITORY,
  updateProjectStatus,
} from './issue-triage.mjs';

export function closingIssues(body, repository = REPOSITORY) {
  const references = referenceText(body).matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*\b|[\w.-]+\/[\w.-]+#[1-9]\d*\b|#[1-9]\d*\b)/gi,
  );
  return [
    ...new Set(
      [...references].flatMap((match) => linkedIssues(match[1], repository)),
    ),
  ];
}

// Only collaborators can move unclaimed Ready work, so a drive-by pull
// request cannot make an open issue look taken.
const TRUSTED_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function sourceStatuses(authorAssociation) {
  return TRUSTED_AUTHORS.has(authorAssociation)
    ? ['Ready', 'In progress']
    : ['In progress'];
}

function skipReason(item, authorAssociation) {
  if (
    item?.type !== 'ISSUE' ||
    item.content?.__typename !== 'Issue' ||
    item.content.repository?.nameWithOwner !== REPOSITORY
  )
    return 'not a Prismatic issue';
  if (item.content.state !== 'OPEN') return 'closed';
  const status = item.fields.Status;
  if (sourceStatuses(authorAssociation).includes(status)) return null;
  if (status === 'Ready')
    return `Ready, and ${authorAssociation} authors move only In progress issues`;
  return `status is ${status ?? 'unset'}`;
}

export async function moveIssuesToReview({
  api,
  number,
  dryRun = true,
  log = console.log,
}) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('A positive pull request number is required');
  const [owner, name] = REPOSITORY.split('/');
  const readPr = async () =>
    (
      await api(
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { body state isDraft authorAssociation }
    } }`,
        { owner, name, number },
      )
    ).repository?.pullRequest;
  const pr = await readPr();
  if (!pr) throw new Error('Pull request not found');
  if (pr.state !== 'OPEN' || pr.isDraft) {
    log(`Pull request #${number} is ${pr.isDraft ? 'a draft' : 'not open'}.`);
    return;
  }
  const numbers = closingIssues(pr.body);
  if (!numbers.length) {
    log(`Pull request #${number} closes no issues.`);
    return;
  }
  const statuses = { Status: ['Ready', 'In progress', 'In review'] };
  const context = await discover(api, statuses);
  for (const issueNumber of numbers) {
    const items = await paginate(async (cursor) => {
      const data = await api(
        `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
            ... on Issue { projectItems(first: 100, after: $cursor, includeArchived: false) {
              nodes { id project { id } } pageInfo { hasNextPage endCursor }
            } }
          } }
        }`,
        { owner, name, number: issueNumber, cursor },
      );
      return (
        data.repository?.issueOrPullRequest?.projectItems ?? {
          nodes: [],
          pageInfo: { hasNextPage: false },
        }
      );
    });
    const item = items.find((item) => item.project?.id === context.projectId);
    if (!item) {
      log(`Issue #${issueNumber}: skipped, not in Prismatic delivery.`);
      continue;
    }
    const current = await readItem(api, item.id, context);
    const reason = skipReason(current, pr.authorAssociation);
    if (reason) {
      log(`Issue #${issueNumber}: skipped, ${reason}.`);
      continue;
    }
    const from = current.fields.Status;
    if (dryRun) {
      log(`Issue #${issueNumber}: ${from} -> In review (dry run).`);
      continue;
    }
    const freshPr = await readPr();
    if (
      !freshPr ||
      freshPr.body !== pr.body ||
      freshPr.authorAssociation !== pr.authorAssociation ||
      freshPr.state !== 'OPEN' ||
      freshPr.isDraft
    )
      throw new Error(
        'Pull request changed during discovery; rerun reconciliation',
      );
    const freshContext = await discover(api, statuses);
    const fresh = await readItem(api, item.id, freshContext);
    const freshReason =
      fresh?.content?.number === issueNumber
        ? skipReason(fresh, pr.authorAssociation)
        : 'project item changed';
    if (freshReason) {
      log(`Issue #${issueNumber}: skipped after re-read, ${freshReason}.`);
      continue;
    }
    await updateProjectStatus(api, freshContext, fresh.id, 'In review');
    log(`Issue #${issueNumber}: ${fresh.fields.Status} -> In review.`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.env.GITHUB_ACTIONS === 'true') {
      if (!process.env.PRISMATIC_PROJECT_TOKEN)
        throw new Error('PRISMATIC_PROJECT_TOKEN is required for Projects access.');
      if (process.env.GITHUB_REPOSITORY !== REPOSITORY)
        throw new Error('Unexpected repository');
      process.env.GH_TOKEN = process.env.PRISMATIC_PROJECT_TOKEN;
      if (
        !['opened', 'edited', 'reopened', 'ready_for_review'].includes(
          process.env.PR_ACTION,
        )
      )
        throw new Error('Unexpected pull request action');
    }
    const mode = process.env.DRY_RUN ?? 'true';
    if (!['true', 'false'].includes(mode))
      throw new Error('DRY_RUN must be true or false');
    await moveIssuesToReview({
      api: metadataGraphql,
      number: Number(process.env.PR_NUMBER),
      dryRun: mode === 'true',
    });
  } catch (error) {
    console.error(
      error.code || error.status
        ? 'GitHub API request failed; check authentication and Projects permissions.'
        : error.message,
    );
    process.exitCode = 1;
  }
}
