// Adds issues in this repository to the Prismatic delivery project. The
// project's built-in auto-add cannot be enabled through the API, so
// tracker-project-membership.yml runs this for one issue when it opens, and
// with --sweep on a schedule for every open issue missing from the project,
// in case GitHub dropped an `opened` run. An issue whose item has no Status
// gets Inbox, so issue-triage.mjs picks it up, and an existing Status never
// changes. Pull requests never go on the board, so the board counts only
// issues. The filing skills run it for each issue they create with --json,
// which prints the item's REST ID and Status as one JSON line on stdout.
import { pathToFileURL } from 'node:url';
import { failureMessage, ghGraphql } from './github-api.mjs';
import {
  discover,
  paginate,
  readItem,
  REPOSITORY,
  updateProjectStatus,
} from './issue-triage.mjs';

export const PROJECT = { owner: 'samlevin', number: 2 };
export const INITIAL_STATUS = 'Inbox';

export async function addToProject({
  api,
  number,
  dryRun = true,
  log = console.log,
}) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('A positive issue number is required');
  const [owner, name] = REPOSITORY.split('/');
  const data = await api(
    `query($owner: String!, $name: String!, $number: Int!, $login: String!, $project: Int!) {
      repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
        __typename ... on PullRequest { id }
        ... on Issue { id projectItems(first: 100) { nodes { id project { id } } } }
      } }
      user(login: $login) { projectV2(number: $project) { id closed } }
    }`,
    { owner, name, number, login: PROJECT.owner, project: PROJECT.number },
  );
  const content = data.repository?.issueOrPullRequest;
  if (!content?.id) throw new Error(`#${number} not found in ${REPOSITORY}`);
  if (content.__typename !== 'Issue') {
    log(`Skipped pull request #${number}; only issues go on the board.`);
    return null;
  }
  const project = data.user?.projectV2;
  if (!project?.id || project.closed)
    throw new Error('Prismatic delivery project is unavailable');
  // Resolve the Status field and its Inbox option by name before any write, so
  // a renamed field or option fails the run before it adds anything.
  const context = await discover(api, { Status: [INITIAL_STATUS] });
  if (context.projectId !== project.id)
    throw new Error('Prismatic delivery project changed during the run');
  if (dryRun) {
    const existing = content.projectItems?.nodes?.find(
      (node) => node?.project?.id === project.id,
    );
    if (!existing) {
      log(
        `DRY_RUN would add issue #${number} to Prismatic delivery and set its Status to ${INITIAL_STATUS}.`,
      );
      return null;
    }
    const status = (await readItem(api, existing.id, context))?.fields.Status;
    log(
      status
        ? `DRY_RUN would keep issue #${number} as item ${existing.id} with Status ${status}.`
        : `DRY_RUN would keep issue #${number} as item ${existing.id} and set its Status to ${INITIAL_STATUS}.`,
    );
    return null;
  }
  // GitHub returns the existing item when the content is already in the
  // project, so reruns and duplicate events add nothing.
  const result = await api(
    `mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id fullDatabaseId } }
    }`,
    { project: project.id, content: content.id },
  );
  const { id, fullDatabaseId: databaseId } =
    result.addProjectV2ItemById?.item ?? {};
  if (!id || !databaseId)
    throw new Error(`GitHub did not return a project item for #${number}`);
  log(`Added issue #${number} to Prismatic delivery as item ${id}.`);
  const current = await readItem(api, id, context);
  if (!current)
    throw new Error(`Could not read project item ${id} for #${number}`);
  if (current.fields.Status) {
    log(`Kept Status ${current.fields.Status} on issue #${number}.`);
    return { id, databaseId, status: current.fields.Status };
  }
  await updateProjectStatus(api, context, id, INITIAL_STATUS);
  log(`Set Status ${INITIAL_STATUS} on issue #${number}.`);
  return { id, databaseId, status: INITIAL_STATUS };
}

// Lists open issues a page at a time with their project items, so a sweep that
// finds nothing missing costs one query per 100 open issues and no writes.
export async function addMissingIssues({
  api,
  dryRun = true,
  log = console.log,
}) {
  const [owner, name] = REPOSITORY.split('/');
  let project;
  const issues = await paginate(async (cursor) => {
    const data = await api(
      `query($owner: String!, $name: String!, $login: String!, $project: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          issues(first: 100, after: $cursor, states: [OPEN]) {
            nodes { number projectItems(first: 100) { nodes { project { id } } } }
            pageInfo { hasNextPage endCursor }
          }
        }
        user(login: $login) { projectV2(number: $project) { id closed } }
      }`,
      {
        owner,
        name,
        login: PROJECT.owner,
        project: PROJECT.number,
        cursor,
      },
    );
    project = data.user?.projectV2;
    if (!project?.id || project.closed)
      throw new Error('Prismatic delivery project is unavailable');
    return data.repository?.issues;
  });
  const missing = issues
    .filter(
      (issue) =>
        !issue.projectItems?.nodes?.some(
          (node) => node?.project?.id === project.id,
        ),
    )
    .map((issue) => issue.number);
  let added = 0;
  const failed = [];
  for (const number of missing) {
    try {
      if ((await addToProject({ api, number, dryRun, log })) !== null) added++;
    } catch (error) {
      failed.push(number);
      log(`Could not add issue #${number}: ${failureMessage(error)}`);
    }
  }
  log(
    `Project membership sweep: ${issues.length} open, ${missing.length} missing, ${added} added, ${failed.length} failed; DRY_RUN=${dryRun}`,
  );
  if (failed.length)
    throw new Error(
      `Could not add ${failed.map((number) => `#${number}`).join(', ')} to Prismatic delivery`,
    );
  return { missing, added, failed };
}

export function configuration(env, args = []) {
  if (env.GITHUB_ACTIONS === 'true') {
    if (!env.PRISMATIC_PROJECT_TOKEN)
      throw new Error(
        'PRISMATIC_PROJECT_TOKEN is required for Projects access; GITHUB_TOKEN cannot access Projects.',
      );
    if (env.GITHUB_REPOSITORY !== REPOSITORY)
      throw new Error('Unexpected repository');
  }
  const mode = env.DRY_RUN ?? 'true';
  if (!['true', 'false'].includes(mode))
    throw new Error('DRY_RUN must be true or false');
  if (args.length === 1 && args[0] === '--sweep')
    return { sweep: true, dryRun: mode === 'true' };
  if (args.length > 1 || (args.length && args[0] !== '--json'))
    throw new Error('The only options are --sweep and --json');
  const number = env.ISSUE_NUMBER ?? '';
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number)))
    throw new Error('ISSUE_NUMBER must be a positive integer');
  return {
    number: Number(number),
    dryRun: mode === 'true',
    json: args[0] === '--json',
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { sweep, json, ...config } = configuration(
      process.env,
      process.argv.slice(2),
    );
    if (process.env.GITHUB_ACTIONS === 'true')
      process.env.GH_TOKEN = process.env.PRISMATIC_PROJECT_TOKEN;
    // With --json the log goes to stderr, so stdout holds only the JSON line.
    const result = await (sweep ? addMissingIssues : addToProject)({
      api: ghGraphql,
      ...config,
      log: json ? console.error : console.log,
    });
    if (json)
      console.log(
        JSON.stringify({
          issue: config.number,
          item: result?.databaseId ?? null,
          status: result?.status ?? null,
        }),
      );
  } catch (error) {
    console.error(failureMessage(error));
    process.exitCode = 1;
  }
}
