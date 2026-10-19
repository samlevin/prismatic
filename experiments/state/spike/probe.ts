// Live publisher identity probe for #143. A person runs it once per token
// path against an approved sandbox pull request:
//
//   GITHUB_TOKEN=... node experiments/state/spike/probe.ts \
//     --repo <owner/name> --pr <n> --path actions|app|personal|cli-app \
//     [--publisher-login <login>] [--write]
//
// Without --write it only reads. With --write it creates one issue comment,
// edits it, reads it back and deletes it, checking the author id GitHub
// reports at every step against the independently resolved publisher. The
// JSON on stdout holds outcomes only: no token, account id or personal login.
import { parseArgs } from 'node:util';
import { normalizeError } from '../../../src/shared/errors.ts';
import { createSecretRedactor } from '../../../src/shared/redaction.ts';
import { GitHubError } from '../lib/github.ts';
import { findEffectMarkers, findMarkers } from '../lib/marker.ts';
import { isAuthentic, resolveExpectedPublisher } from '../lib/publisher.ts';
import type { PublisherSource } from '../lib/publisher.ts';
import { RestGitHub } from '../lib/restGitHub.ts';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    pr: { type: 'string' },
    path: { type: 'string' },
    'publisher-login': { type: 'string' },
    write: { type: 'boolean', default: false },
  },
});

function source(): PublisherSource {
  const login = values['publisher-login'];
  switch (values.path) {
    case 'actions':
      return login === undefined
        ? { kind: 'actions-token' }
        : { kind: 'actions-token', publisherLogin: login };
    case 'app':
      return { kind: 'app-token', publisherLogin: login ?? '' };
    case 'personal':
      return { kind: 'cli-personal-token' };
    case 'cli-app':
      return { kind: 'cli-app-token', publisherLogin: login ?? '' };
    default:
      throw new RangeError('--path must be actions, app, personal or cli-app.');
  }
}

const token = process.env.GITHUB_TOKEN ?? '';

async function main(): Promise<Record<string, unknown>> {
  if (token === '') throw new RangeError('Set GITHUB_TOKEN.');
  const github = new RestGitHub({
    token,
    repository: values.repo ?? '',
    prNumber: Number(values.pr),
  });
  const result: Record<string, unknown> = {
    path: values.path,
    write: values.write,
  };
  const chosen = source();
  try {
    await github.authenticatedUser();
    result.userEndpoint = 'ok';
  } catch (error) {
    result.userEndpoint = error instanceof GitHubError ? error.status : 'error';
  }
  const publisher = await resolveExpectedPublisher(chosen, github);
  result.publisherResolved = true;
  if (chosen.kind !== 'cli-personal-token')
    result.publisherLogin = publisher.login;

  let authentic = 0;
  let other = 0;
  for (const channel of ['issue', 'review'] as const) {
    for (const comment of await github.listComments(channel)) {
      const marked =
        findMarkers(comment.body, 'state').length +
          findMarkers(comment.body, 'journal').length +
          findEffectMarkers(comment.body).length >
        0;
      if (!marked) continue;
      if (isAuthentic(comment, publisher)) authentic += 1;
      else other += 1;
    }
  }
  result.markedComments = { authentic, other };

  if (values.write) {
    const nonce = `${Date.now().toString(36)}`;
    const body = `Prismatic identity probe ${nonce}. This comment is removed by the probe.`;
    const created = await github.createComment('issue', body);
    result.createAuthorMatches = isAuthentic(created, publisher);
    const edited = await github.updateComment(
      'issue',
      created.id,
      `${body} (edited)`,
    );
    result.editAuthorMatches = isAuthentic(edited, publisher);
    const listed = (await github.listComments('issue')).find(
      (c) => c.id === created.id,
    );
    result.listAuthorMatches =
      listed !== undefined && isAuthentic(listed, publisher);
    await github.deleteComment('issue', created.id);
    result.deleted = true;
  }
  return result;
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const failed = [
    'createAuthorMatches',
    'editAuthorMatches',
    'listAuthorMatches',
  ].some((key) => result[key] === false);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  process.stderr.write(
    `${JSON.stringify(normalizeError(error, createSecretRedactor([token])))}\n`,
  );
  process.exitCode = 1;
}
