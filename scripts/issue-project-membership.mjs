// Adds one issue or pull request in this repository to the Prismatic delivery
// project. The project's built-in auto-add cannot be enabled through the API,
// so tracker-project-membership.yml runs this when an issue or PR opens.
import { pathToFileURL } from 'node:url';
import { ghGraphql, REPOSITORY } from './issue-triage.mjs';

export const PROJECT = { owner: 'samlevin', number: 2 };

export async function addToProject({
  api,
  number,
  dryRun = true,
  log = console.log,
}) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('A positive issue or pull request number is required');
  const [owner, name] = REPOSITORY.split('/');
  const data = await api(
    `query($owner: String!, $name: String!, $number: Int!, $login: String!, $project: Int!) {
      repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
        __typename ... on Issue { id } ... on PullRequest { id }
      } }
      user(login: $login) { projectV2(number: $project) { id closed } }
    }`,
    { owner, name, number, login: PROJECT.owner, project: PROJECT.number },
  );
  const content = data.repository?.issueOrPullRequest;
  if (!content?.id) throw new Error(`#${number} not found in ${REPOSITORY}`);
  const kind = content.__typename === 'PullRequest' ? 'pull request' : 'issue';
  const project = data.user?.projectV2;
  if (!project?.id || project.closed)
    throw new Error('Prismatic delivery project is unavailable');
  if (dryRun) {
    log(`DRY_RUN would add ${kind} #${number} to Prismatic delivery.`);
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
  log(`Added ${kind} #${number} to Prismatic delivery as item ${item}.`);
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
  const number = env.ISSUE_OR_PR_NUMBER ?? '';
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number)))
    throw new Error('ISSUE_OR_PR_NUMBER must be a positive integer');
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
    // Do not print subprocess stderr, which can contain authentication details.
    console.error(
      error.code || error.status
        ? 'GitHub API request failed; check authentication and Projects permissions.'
        : error.message,
    );
    process.exitCode = 1;
  }
}
