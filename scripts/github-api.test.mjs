import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  failureMessage,
  ghGraphql,
  ghRest,
  GitHubApiError,
  parseResponse,
  responseError,
} from './github-api.mjs';

const TOKEN = 'ghp_example-token-value';
const RESET = 1792126800; // 2026-10-16T05:00:00Z
const RESET_TEXT = '2026-10-16T05:00:00Z';

// Formats a response the way `gh api --include` prints it: the status line,
// CRLF-terminated headers, a blank line, and the body.
function include(status, headers, body) {
  const lines = Object.entries(headers).map(
    ([name, value]) => `${name}: ${value}\r\n`,
  );
  return `HTTP/2.0 ${status} Status\n${lines.join('')}\r\n${typeof body === 'string' ? body : JSON.stringify(body)}`;
}

// A gh stand-in that exits non-zero with `stdout` and stderr that holds the
// token, the way a failing `gh api` call does.
function failing(stdout, status = 1) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    throw Object.assign(new Error(`Command failed: gh api\ngh: ${TOKEN}`), {
      status,
      stdout,
      stderr: `gh: request failed with Authorization: token ${TOKEN}`,
    });
  };
  return Object.assign(run, { calls });
}

function caught(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw');
}

const rateLimited = include(
  200,
  {
    'X-Ratelimit-Remaining': '0',
    'X-Ratelimit-Reset': String(RESET),
    'X-Ratelimit-Resource': 'graphql',
  },
  {
    errors: [
      {
        type: 'RATE_LIMIT',
        code: 'graphql_rate_limit',
        message: 'API rate limit already exceeded for user ID 1.',
      },
    ],
  },
);

test('parseResponse reads the status, headers, and body that gh prints with --include', () => {
  assert.deepEqual(
    parseResponse(
      include(404, { 'X-Ratelimit-Remaining': '9' }, { message: 'Not Found' }),
    ),
    {
      status: 404,
      headers: { 'x-ratelimit-remaining': '9' },
      body: '{"message":"Not Found"}',
      json: { message: 'Not Found' },
    },
  );
  assert.deepEqual(parseResponse('{"data":{}}'), {
    status: undefined,
    headers: {},
    body: '{"data":{}}',
    json: { data: {} },
  });
  assert.equal(parseResponse(include(502, {}, '<html>')).json, undefined);
});

test('ghGraphql sends the query on stdin with --include and returns the data', () => {
  const calls = [];
  const data = ghGraphql(
    'query { viewer { login } }',
    { a: 1 },
    {
      run: (command, args, options) => {
        calls.push({ command, args, options });
        return include(200, {}, { data: { viewer: { login: 'octocat' } } });
      },
    },
  );
  assert.deepEqual(data, { viewer: { login: 'octocat' } });
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args, [
    'api',
    '--include',
    'graphql',
    '--input',
    '-',
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.input), {
    query: 'query { viewer { login } }',
    variables: { a: 1 },
  });
});

test('ghRest returns the body text and closes stdin', () => {
  const calls = [];
  const body = ghRest(['repos/o/r/issues/1'], {
    run: (command, args, options) => {
      calls.push({ args, options });
      return include(200, {}, '{"title":"x"}');
    },
  });
  assert.equal(body, '{"title":"x"}');
  assert.deepEqual(calls[0].args, ['api', '--include', 'repos/o/r/issues/1']);
  assert.equal(calls[0].options.stdio[0], 'ignore');
});

test('a GraphQL error reports each type or code with its message', () => {
  const error = caught(() =>
    ghGraphql(
      'query',
      {},
      {
        run: failing(
          include(
            200,
            {},
            {
              errors: [
                { type: 'SOMETHING_ELSE', message: 'First\nproblem.' },
                { code: 'undefinedField', message: 'Field is missing.' },
                { message: 'No type.' },
              ],
            },
          ),
        ),
      },
    ),
  );
  assert.ok(error instanceof GitHubApiError);
  assert.equal(error.kind, 'other');
  assert.equal(
    error.message,
    'GitHub GraphQL request failed: SOMETHING_ELSE: First problem.; undefinedField: Field is missing.; No type.',
  );
});

test('a GraphQL rate limit names the error and when the limit resets', () => {
  const error = caught(() =>
    ghGraphql('query', {}, { run: failing(rateLimited) }),
  );
  assert.equal(error.kind, 'rate_limit');
  assert.equal(
    error.message,
    `GitHub GraphQL request failed: RATE_LIMIT: API rate limit already exceeded for user ID 1. GitHub rate limit reached; it resets at ${RESET_TEXT}.`,
  );
  assert.equal(error.resetAt.getTime(), RESET * 1000);
});

test('REST rate limits are reported as rate limits, with the reset when GitHub sends one', () => {
  const now = Date.UTC(2026, 9, 16, 4, 0, 0);
  const cases = [
    [
      include(
        403,
        { 'X-Ratelimit-Remaining': '0', 'X-Ratelimit-Reset': String(RESET) },
        {
          message: 'API rate limit exceeded for user ID 1.',
        },
      ),
      `GitHub API request failed: HTTP 403: API rate limit exceeded for user ID 1. GitHub rate limit reached; it resets at ${RESET_TEXT}.`,
    ],
    [
      include(429, { 'Retry-After': '60' }, { message: 'Too many requests' }),
      'GitHub API request failed: HTTP 429: Too many requests. GitHub rate limit reached; retry after 60 seconds (2026-10-16T04:01:00Z).',
    ],
    [
      include(
        403,
        { 'X-Ratelimit-Remaining': '4000', 'X-Ratelimit-Reset': String(RESET) },
        {
          message:
            'You have exceeded a secondary rate limit. Please wait a few minutes.',
        },
      ),
      'GitHub API request failed: HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes. GitHub rate limit reached; wait for it to reset before retrying.',
    ],
  ];
  for (const [output, message] of cases) {
    const error = responseError(parseResponse(output), { now, env: {} });
    assert.equal(error.kind, 'rate_limit');
    assert.equal(error.message, message);
  }
  const rest = caught(() => ghRest(['user'], { run: failing(cases[0][0]) }));
  assert.equal(rest.kind, 'rate_limit');
  assert.equal(rest.httpStatus, 403);
});

test('authentication and permission failures say to check the token and Projects access', () => {
  const cases = [
    [
      include(401, {}, { message: 'Bad credentials', status: '401' }),
      'GitHub API request failed: HTTP 401: Bad credentials. Check the token and Projects access.',
    ],
    [
      include(
        403,
        { 'X-Ratelimit-Remaining': '4000' },
        {
          message: 'Resource not accessible by personal access token',
        },
      ),
      'GitHub API request failed: HTTP 403: Resource not accessible by personal access token. Check the token and Projects access.',
    ],
  ];
  for (const [output, message] of cases) {
    const error = caught(() => ghRest(['user'], { run: failing(output) }));
    assert.equal(error.kind, 'auth');
    assert.equal(error.message, message);
  }
  for (const type of ['FORBIDDEN', 'INSUFFICIENT_SCOPES']) {
    const error = caught(() =>
      ghGraphql(
        'query',
        {},
        {
          run: failing(
            include(200, {}, { errors: [{ type, message: 'No access.' }] }),
          ),
        },
      ),
    );
    assert.equal(error.kind, 'auth');
    assert.equal(
      error.message,
      `GitHub GraphQL request failed: ${type}: No access. Check the token and Projects access.`,
    );
  }
  const unauthenticated = caught(() =>
    ghGraphql('query', {}, { run: failing('', 4) }),
  );
  assert.equal(unauthenticated.kind, 'auth');
  assert.equal(
    unauthenticated.message,
    'GitHub GraphQL request failed: gh has no GitHub credentials. Check the token and Projects access.',
  );
});

test('not-found failures say the resource is missing or hidden from the token', () => {
  const rest = caught(() =>
    ghRest(['repos/o/r/issues/9'], {
      run: failing(include(404, {}, { message: 'Not Found', status: '404' })),
    }),
  );
  assert.equal(rest.kind, 'not_found');
  assert.equal(rest.httpStatus, 404);
  assert.equal(
    rest.message,
    'GitHub API request failed: HTTP 404: Not Found. It does not exist, or the token cannot see it; check the token and Projects access.',
  );
  const graphql = caught(() =>
    ghGraphql(
      'query',
      {},
      {
        run: failing(
          include(
            200,
            {},
            {
              data: { user: null },
              errors: [
                {
                  type: 'NOT_FOUND',
                  message: "Could not resolve to a User with the login of 'x'.",
                },
              ],
            },
          ),
        ),
      },
    ),
  );
  assert.equal(graphql.kind, 'not_found');
  assert.match(
    graphql.message,
    /^GitHub GraphQL request failed: NOT_FOUND: Could not resolve/,
  );
});

test('allowErrors accepts expected GraphQL errors and returns the data', () => {
  const output = include(
    200,
    {},
    { data: { node: null }, errors: [{ type: 'NOT_FOUND' }] },
  );
  assert.deepEqual(
    ghGraphql('query', {}, { run: failing(output), allowErrors: () => true }),
    { node: null },
  );
  assert.throws(
    () =>
      ghGraphql(
        'query',
        {},
        { run: failing(output), allowErrors: () => false },
      ),
    /NOT_FOUND: no message/,
  );
});

test('failures without a GitHub response report a generic error without stderr', () => {
  const cases = [
    [
      failing('', 1),
      'GitHub GraphQL request failed: gh exited with status 1 and no response from GitHub.',
    ],
    [
      failing('gh: not json', 1),
      'GitHub GraphQL request failed: gh exited with status 1 and no response from GitHub.',
    ],
    [
      () => {
        throw Object.assign(new Error('spawnSync gh ENOENT'), {
          code: 'ENOENT',
        });
      },
      'GitHub GraphQL request failed: the gh command is not installed.',
    ],
    [
      () => include(502, {}, '<html>'),
      'GitHub GraphQL request failed: HTTP 502 with no usable response body.',
    ],
    [
      () => include(500, {}, { message: 'Server Error' }),
      'GitHub GraphQL request failed: HTTP 500: Server Error.',
    ],
  ];
  for (const [run, message] of cases) {
    const error = caught(() => ghGraphql('query', {}, { run }));
    assert.equal(error.kind, 'other');
    assert.equal(error.message, message);
  }
});

test('messages never include the token, request headers, or gh stderr', () => {
  const env = { GH_TOKEN: TOKEN };
  const error = responseError(
    parseResponse(
      include(
        401,
        { 'X-Accepted-Oauth-Scopes': 'repo' },
        {
          message: `Bad credentials for ${TOKEN}`,
        },
      ),
    ),
    { env },
  );
  assert.equal(
    error.message,
    'GitHub API request failed: HTTP 401: Bad credentials for ***. Check the token and Projects access.',
  );
  const thrown = caught(() =>
    ghRest(['user'], {
      run: failing(include(401, {}, { message: 'Bad credentials' })),
    }),
  );
  for (const message of [thrown.message, failureMessage(thrown, env)]) {
    assert.ok(!message.includes(TOKEN));
    assert.ok(!message.includes('Authorization'));
    assert.ok(!message.includes('X-Accepted'));
  }
  assert.equal(
    failureMessage(
      Object.assign(new Error(`Command failed: gh api\n${TOKEN}`), {
        status: 1,
        stderr: TOKEN,
      }),
      env,
    ),
    'GitHub API request failed. Check the token and Projects access.',
  );
  assert.equal(
    failureMessage(new Error('DRY_RUN must be true or false'), env),
    'DRY_RUN must be true or false',
  );
});

test('every script that calls GitHub prints the shared message and exits non-zero', (t) => {
  if (process.platform === 'win32')
    return t.skip('the fake gh is a shell script');
  const directory = mkdtempSync(join(tmpdir(), 'github-api-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const response = join(directory, 'response.txt');
  writeFileSync(response, rateLimited);
  const gh = join(directory, 'gh');
  writeFileSync(
    gh,
    '#!/bin/sh\ncat > /dev/null\ncat "$FAKE_GH_RESPONSE"\necho "gh: secret stderr $GH_TOKEN" >&2\nexit 1\n',
  );
  chmodSync(gh, 0o755);
  const scripts = [
    ['issue-triage.mjs', []],
    ['issue-containers.mjs', []],
    ['issue-project-membership.mjs', [], { ISSUE_OR_PR_NUMBER: '12' }],
    ['issue-pr-metadata.mjs', [], { PR_NUMBER: '10' }],
    ['issue-pr-status.mjs', [], { PR_NUMBER: '10' }],
    ['branch-name.mjs', ['33']],
  ];
  for (const [name, args, env = {}] of scripts) {
    let failure;
    try {
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL(`./${name}`, import.meta.url)), ...args],
        {
          env: {
            PATH: `${directory}:${process.env.PATH}`,
            GH_TOKEN: TOKEN,
            FAKE_GH_RESPONSE: response,
            ...env,
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1, name);
    assert.match(
      failure.stderr,
      /RATE_LIMIT: API rate limit already exceeded for user ID 1\./,
      name,
    );
    assert.match(
      failure.stderr,
      new RegExp(`it resets at ${RESET_TEXT}`),
      name,
    );
    assert.ok(!failure.stderr.includes(TOKEN), name);
    assert.ok(!failure.stderr.includes('secret stderr'), name);
  }
});
