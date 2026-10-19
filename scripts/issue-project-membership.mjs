// Adds one issue in this repository to the Prismatic delivery project. The
// project's built-in auto-add cannot be enabled through the API, so
// tracker-project-membership.yml runs this when an issue opens. An issue whose
// item has no Status gets Inbox, so issue-triage.mjs picks it up, and an
// existing Status never changes. Pull requests never go on the board, so the
// board counts only issues.
import { pathToFileURL } from 'node:url';
import { failureMessage, ghGraphql } from './github-api.mjs';
import {
  discover,
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
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
    }`,
    { project: project.id, content: content.id },
  );
  const item = result.addProjectV2ItemById?.item?.id;
  if (!item)
    throw new Error(`GitHub did not return a project item for #${number}`);
  log(`Added issue #${number} to Prismatic delivery as item ${item}.`);
  const current = await readItem(api, item, context);
  if (!current)
    throw new Error(`Could not read project item ${item} for #${number}`);
  if (current.fields.Status) {
    log(`Kept Status ${current.fields.Status} on issue #${number}.`);
    return item;
  }
  await updateProjectStatus(api, context, item, INITIAL_STATUS);
  log(`Set Status ${INITIAL_STATUS} on issue #${number}.`);
  return item;
}

export function configuration(env) {
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
  const number = env.ISSUE_NUMBER ?? '';
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number)))
    throw new Error('ISSUE_NUMBER must be a positive integer');
  return { number: Number(number), dryRun: mode === 'true' };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const config = configuration(process.env);
    if (process.env.GITHUB_ACTIONS === 'true')
      process.env.GH_TOKEN = process.env.PRISMATIC_PROJECT_TOKEN;
    await addToProject({ api: ghGraphql, ...config });
  } catch (error) {
    console.error(failureMessage(error));
    process.exitCode = 1;
  }
}
