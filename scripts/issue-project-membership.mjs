import { pathToFileURL } from 'node:url';
import { failureMessage } from './github-api.mjs';
import {
  MissingIssueError,
  paginate,
  REPOSITORY,
  runTracker,
  trackerGraphql,
} from './issue-triage.mjs';

export async function addToProject({
  api,
  kind,
  number,
  dryRun = true,
  log = console.log,
}) {
  if (kind !== 'issue') throw new Error('CONTENT_TYPE must be issue');
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('A positive issue number is required');
  const [owner, name] = REPOSITORY.split('/');
  const data = await api(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) { id } }
      user(login: "samlevin") { projectV2(number: 2) { id closed } }
    }`,
    { owner, name, number },
  );
  const content = data.repository?.issue;
  // An issue deleted or transferred before the run reads as null.
  if (!content?.id) throw new MissingIssueError(number);
  const project = data.user?.projectV2;
  if (!project?.id || project.closed)
    throw new Error('Prismatic delivery project is unavailable');
  if (dryRun) {
    log(`Issue #${number}: would add to Prismatic delivery (dry run).`);
    return null;
  }
  // GitHub returns the existing item when the content is already in the
  // project, so reruns and earlier adds by the workflow neither fail nor
  // duplicate. The item's full database ID is the ID that the REST
  // `projectsV2/<n>/items/<id>` endpoints take, which issue filers use.
  const result = await api(
    `mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id fullDatabaseId } }
    }`,
    { project: project.id, content: content.id },
  );
  const item = result.addProjectV2ItemById?.item?.fullDatabaseId;
  if (!item || !/^[1-9]\d*$/.test(item))
    throw new Error('GitHub returned no project item');
  log(`Issue #${number}: in Prismatic delivery as item ${item}.`);
  return item;
}

// Adds every open issue that is not in Prismatic delivery. Archived project items
// count as present. An issue in more than 100 projects may be listed as
// missing; addToProject then returns its existing item.
export async function sweep({
  api,
  dryRun = true,
  log = console.log,
  logError = console.error,
}) {
  const [owner, name] = REPOSITORY.split('/');
  const data = await api(
    `query { user(login: "samlevin") { projectV2(number: 2) { id closed } } }`,
    {},
  );
  const project = data.user?.projectV2;
  if (!project?.id || project.closed)
    throw new Error('Prismatic delivery project is unavailable');
  const issues = await paginate(async (cursor) => {
    const page = await api(
      `query($owner: String!, $name: String!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          issues(first: 100, after: $cursor, states: [OPEN]) {
            nodes { number projectItems(first: 100) { nodes { project { id } } } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { owner, name, cursor },
    );
    return page.repository?.issues;
  });
  const missing = issues
    .filter(
      (issue) =>
        !issue.projectItems?.nodes.some(
          (item) => item?.project?.id === project.id,
        ),
    )
    .map((issue) => issue.number)
    .sort((a, b) => a - b);
  if (!missing.length) {
    log(`All ${issues.length} open issues are in Prismatic delivery.`);
    return { missing, failed: [] };
  }
  log(
    `Open issues missing from Prismatic delivery: ${missing.map((number) => `#${number}`).join(', ')}.`,
  );
  const failed = [];
  for (const number of missing) {
    try {
      await addToProject({ api, kind: 'issue', number, dryRun, log });
    } catch (error) {
      failed.push(number);
      logError(`Issue #${number}: ${failureMessage(error)}`);
    }
  }
  if (failed.length)
    throw new Error(
      `Could not add ${failed.length} of ${missing.length} missing issues: ${failed.map((number) => `#${number}`).join(', ')}`,
    );
  return { missing, failed };
}

function flag(env, name, fallback) {
  const value = env[name] ?? fallback;
  if (!['true', 'false'].includes(value))
    throw new Error(`${name} must be true or false`);
  return value === 'true';
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.env.GITHUB_ACTIONS === 'true') {
      if (!process.env.PRISMATIC_PROJECT_TOKEN)
        throw new Error(
          'PRISMATIC_PROJECT_TOKEN is required for Projects access.',
        );
      if (process.env.GITHUB_REPOSITORY !== REPOSITORY)
        throw new Error('Unexpected repository');
      process.env.GH_TOKEN = process.env.PRISMATIC_PROJECT_TOKEN;
    }
    const dryRun = flag(process.env, 'DRY_RUN', 'true');
    const sweeping = flag(process.env, 'SWEEP', 'false');
    process.exitCode = await runTracker({
      sweep: sweeping,
      task: () =>
        sweeping
          ? sweep({ api: trackerGraphql, dryRun })
          : addToProject({
              api: trackerGraphql,
              kind: process.env.CONTENT_TYPE,
              number: Number(process.env.CONTENT_NUMBER),
              dryRun,
            }),
    });
  } catch (error) {
    console.error(failureMessage(error));
    process.exitCode = 1;
  }
}
