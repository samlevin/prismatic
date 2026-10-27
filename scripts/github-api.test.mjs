import assert from 'node:assert/strict';
import test from 'node:test';
import {
  failureMessage,
  ghGraphql,
  GitHubError,
  ghRest,
  ghRestPages,
  redact,
} from './github-api.mjs';

// `gh api --include` output: a status line, CRLF headers, a blank line, the body.
function httpResponse(status, headers, body) {
  const lines = Object.entries(headers).map(
    ([name, value]) => `${name}: ${value}\r\n`,
  );
  return `HTTP/2.0 ${status} Status\n${lines.join('')}\r\n${
    typeof body === 'string' ? body : JSON.stringify(body)
  }`;
}

// gh exits non-zero on an HTTP or GraphQL error and writes the response to stdout.
function ghFails(stdout, overrides = {}) {
  return () => {
    throw Object.assign(new Error('Command failed: gh api'), {
      status: 1,
      stderr: 'gh: stderr-marker',
      stdout,
      ...overrides,
    });
  };
}

const RESET = 1792126278;
const RESET_AT = new Date(RESET * 1000).toISOString();
const ACCESS =
  'Check that the token is valid and has issue and Projects access.';
const exhausted = {
  'X-Ratelimit-Limit': '5000',
  'X-Ratelimit-Remaining': '0',
  'X-Ratelimit-Reset': String(RESET),
};

test('GraphQL errors report each type or code with its message', () => {
  assert.throws(
    () =>
      ghGraphql(
        'query { viewer { login } }',
        {},
        {
          run: ghFails(
            httpResponse(
              200,
              {},
              {
                errors: [
                  { type: 'INTERNAL', message: 'Something\n  went wrong' },
                  { code: 'undefinedField', message: 'Field x is unknown' },
                  { message: 'Parse error on "}"' },
                ],
              },
            ),
          ),
        },
      ),
    {
      name: 'GitHubError',
      kind: 'other',
      message:
        'GitHub GraphQL request failed: INTERNAL: Something went wrong; undefinedField: Field x is unknown; Parse error on "}".',
    },
  );
});

test('rate limits are named as rate limits with the reset time GitHub reports', () => {
  const cases = [
    [
      'GraphQL RATE_LIMITED',
      () =>
        ghGraphql(
          'query { viewer { login } }',
          {},
          {
            run: ghFails(
              httpResponse(200, exhausted, {
                errors: [
                  {
                    type: 'RATE_LIMITED',
                    message: 'API rate limit already exceeded for user ID 1.',
                  },
                ],
              }),
            ),
          },
        ),
      {
        httpStatus: undefined,
        message: `GitHub GraphQL request failed: RATE_LIMITED: API rate limit already exceeded for user ID 1. Rate limit reached; the limit resets at ${RESET_AT}.`,
      },
    ],
    [
      'REST 403 primary limit',
      () =>
        ghRest(['repos/example/issues/1'], {
          run: ghFails(
            httpResponse(403, exhausted, {
              message: 'API rate limit exceeded for user ID 1.',
              documentation_url: 'https://docs.github.com/rest',
            }),
          ),
        }),
      {
        httpStatus: 403,
        message: `GitHub REST request failed: HTTP 403: API rate limit exceeded for user ID 1. Rate limit reached; the limit resets at ${RESET_AT}.`,
      },
    ],
    [
      'REST 403 secondary limit with Retry-After',
      () =>
        ghRest(['repos/example/issues/1'], {
          run: ghFails(
            httpResponse(
              403,
              {
                ...exhausted,
                'X-Ratelimit-Remaining': '4000',
                'Retry-After': '60',
              },
              {
                message:
                  'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
              },
            ),
          ),
        }),
      {
        httpStatus: 403,
        message:
          'GitHub REST request failed: HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. Secondary rate limit reached; retry after 60 seconds.',
      },
    ],
    [
      'REST 429 without a reset GitHub stands behind',
      () =>
        ghRest(['repos/example/issues/1'], {
          run: ghFails(
            httpResponse(
              429,
              { ...exhausted, 'X-Ratelimit-Remaining': '10' },
              { message: 'You have exceeded a secondary rate limit.' },
            ),
          ),
        }),
      {
        httpStatus: 429,
        message:
          'GitHub REST request failed: HTTP 429: You have exceeded a secondary rate limit. Secondary rate limit reached; GitHub did not say when it resets.',
      },
    ],
    [
      'GraphQL RATE_LIMITED without headers',
      () =>
        ghGraphql(
          'query { viewer { login } }',
          {},
          {
            run: ghFails(
              JSON.stringify({
                errors: [{ type: 'RATE_LIMITED', message: 'Limit exceeded' }],
              }),
            ),
          },
        ),
      {
        message:
          'GitHub GraphQL request failed: RATE_LIMITED: Limit exceeded. Rate limit reached; GitHub did not say when it resets.',
      },
    ],
  ];
  for (const [name, call, expected] of cases)
    assert.throws(call, { kind: 'rate-limit', ...expected }, name);
});

test('authentication and permission failures point at the token and Projects access', () => {
  const cases = [
    [
      () =>
        ghGraphql(
          'query { viewer { login } }',
          {},
          {
            run: ghFails(
              httpResponse(
                401,
                {},
                {
                  message: 'Bad credentials',
                  documentation_url: 'https://docs.github.com/rest',
                  status: '401',
                },
              ),
            ),
          },
        ),
      `GitHub GraphQL request failed: HTTP 401: Bad credentials. ${ACCESS}`,
    ],
    [
      () =>
        ghGraphql(
          'query { viewer { login } }',
          {},
          {
            run: ghFails(
              httpResponse(
                200,
                {},
                {
                  errors: [
                    {
                      type: 'INSUFFICIENT_SCOPES',
                      message:
                        "Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project'].",
                    },
                  ],
                },
              ),
            ),
          },
        ),
      `GitHub GraphQL request failed: INSUFFICIENT_SCOPES: Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project']. ${ACCESS}`,
    ],
    [
      () =>
        ghRest(['repos/example/issues/1'], {
          run: ghFails(
            httpResponse(
              403,
              {},
              { message: 'Resource not accessible by personal access token' },
            ),
          ),
        }),
      `GitHub REST request failed: HTTP 403: Resource not accessible by personal access token. ${ACCESS}`,
    ],
  ];
  for (const [call, message] of cases)
    assert.throws(call, { kind: 'access', message });
});

test('not-found and other failures keep GitHub details without stderr or raw bodies', () => {
  assert.throws(
    () =>
      ghRest(['repos/example/issues/9'], {
        run: ghFails(httpResponse(404, {}, { message: 'Not Found' })),
      }),
    {
      kind: 'not-found',
      httpStatus: 404,
      message: 'GitHub REST request failed: HTTP 404: Not Found.',
    },
  );
  // ghGraphql without allowErrors does not tolerate NOT_FOUND.
  assert.throws(
    () =>
      ghGraphql(
        'query { repository { issueOrPullRequest(number: 9) { id } } }',
        {},
        {
          run: ghFails(
            httpResponse(
              200,
              {},
              {
                data: { repository: { issueOrPullRequest: null } },
                errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }],
              },
            ),
          ),
        },
      ),
    {
      kind: 'not-found',
      message: 'GitHub GraphQL request failed: NOT_FOUND: Could not resolve.',
    },
  );
  assert.throws(
    () =>
      ghRest(['repos/example/issues/9'], {
        run: ghFails(httpResponse(502, {}, '<html>proxy body</html>')),
      }),
    {
      kind: 'other',
      httpStatus: 502,
      message:
        'GitHub REST request failed: HTTP 502; the response was not JSON.',
    },
  );
  assert.throws(
    () =>
      ghGraphql(
        'query { viewer { login } }',
        {},
        { run: ghFails('', { status: 4 }) },
      ),
    {
      kind: 'other',
      message:
        'GitHub GraphQL request failed: gh exited with status 4 without a GitHub response. Check that gh is authenticated and GitHub is reachable.',
    },
  );
  assert.throws(
    () =>
      ghRest(['repos/example/issues/9'], {
        run: ghFails(undefined, { status: undefined, code: 'ENOENT' }),
      }),
    {
      message:
        'GitHub REST request failed: gh is not installed or not on PATH. Check that gh is authenticated and GitHub is reachable.',
    },
  );
  for (const run of [
    ghFails(httpResponse(404, {}, { message: 'Not Found' })),
    ghFails(''),
  ])
    assert.throws(
      () => ghRest(['repos/example/issues/9'], { run: run }),
      (error) =>
        !error.message.includes('stderr-marker') && error.cause === undefined,
    );
});

test('messages redact tokens from GitHub text and the environment', () => {
  const pattern = ['ghp', 'a1'.repeat(18)].join('_');
  const fineGrained = ['github', 'pat', 'b2'.repeat(20)].join('_');
  assert.equal(
    redact(`one ${pattern} two ${fineGrained} three secret-value-188`, {
      GH_TOKEN: 'secret-value-188',
    }),
    'one *** two *** three ***',
  );
  assert.throws(
    () =>
      ghRest(['user'], {
        run: ghFails(
          httpResponse(401, {}, { message: `Bad credentials for ${pattern}` }),
        ),
      }),
    (error) =>
      error.message ===
      `GitHub REST request failed: HTTP 401: Bad credentials for ***. ${ACCESS}`,
  );
});

test('successful responses parse past gh headers and keep the request shape', () => {
  const calls = [];
  const record = (output) => (command, args, options) => {
    calls.push({ command, args, options });
    return output;
  };
  assert.deepEqual(
    ghGraphql(
      'query { viewer { login } }',
      { a: 1 },
      {
        run: record(
          httpResponse(200, exhausted, { data: { viewer: { login: 'x' } } }),
        ),
      },
    ),
    { viewer: { login: 'x' } },
  );
  assert.deepEqual(
    ghGraphql('query { ok }', {}, { run: record('{"data":{"ok":true}}') }),
    { ok: true },
  );
  assert.equal(
    ghRest(['repos/example/issues/1'], {
      run: record(httpResponse(200, {}, '{"n":1}')),
    }),
    '{"n":1}',
  );
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      ['gh', 'api', '--include', 'graphql', '--input', '-'],
      ['gh', 'api', '--include', 'graphql', '--input', '-'],
      ['gh', 'api', '--include', 'repos/example/issues/1'],
    ],
  );
  assert.equal(
    calls[0].options.input,
    JSON.stringify({
      query: 'query { viewer { login } }',
      variables: { a: 1 },
    }),
  );
  assert.deepEqual(calls[2].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.throws(
    () =>
      ghGraphql(
        'query { ok }',
        {},
        { run: record(httpResponse(200, {}, 'oops')) },
      ),
    { message: 'GitHub GraphQL request failed: the response was not JSON.' },
  );
});

test('entry-point messages never print raw subprocess errors', () => {
  const github = new GitHubError('GitHub REST request failed: HTTP 404.');
  assert.equal(failureMessage(github), 'GitHub REST request failed: HTTP 404.');
  assert.equal(
    failureMessage(
      Object.assign(new Error('Command failed: gh\nstderr-marker'), {
        status: 1,
      }),
    ),
    `GitHub API request failed. ${ACCESS}`,
  );
  assert.equal(
    failureMessage(new Error('DRY_RUN must be true or false')),
    'DRY_RUN must be true or false',
  );
});

test('REST errors given as plain strings are reported with the message', () => {
  assert.throws(
    () =>
      ghRest(['repos/example/pulls/7/reviews'], {
        run: ghFails(
          httpResponse(
            422,
            {},
            {
              message: 'Unprocessable Entity',
              errors: [
                'Review Can not request changes on your own pull request',
              ],
            },
          ),
        ),
      }),
    {
      httpStatus: 422,
      message:
        'GitHub REST request failed: HTTP 422: Unprocessable Entity; Review Can not request changes on your own pull request.',
    },
  );
});

test('a REST request sends its input on stdin', () => {
  const calls = [];
  ghRest(
    ['--method', 'POST', 'repos/example/pulls/7/reviews', '--input', '-'],
    {
      input: '{"event":"COMMENT"}',
      run: (command, args, options) => {
        calls.push({ args, options });
        return httpResponse(200, {}, '{}');
      },
    },
  );
  assert.equal(calls[0].options.input, '{"event":"COMMENT"}');
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('REST pages follow the Link header until the last page', () => {
  const paths = [];
  const next = (path) => ({
    Link: `<https://api.github.com/${path}>; rel="next", <https://api.github.com/x?page=9>; rel="last"`,
  });
  const pages = ghRestPages('repos/example/branches?per_page=100', {
    run: (command, args) => {
      const path = args.at(-1);
      paths.push(path);
      if (path.endsWith('per_page=100'))
        return httpResponse(200, next('repos/example/branches?page=2'), [1]);
      return httpResponse(200, {}, [2]);
    },
  });
  assert.deepEqual(pages, [[1], [2]]);
  assert.deepEqual(paths, [
    'repos/example/branches?per_page=100',
    'repos/example/branches?page=2',
  ]);
  assert.throws(
    () =>
      ghRestPages('x', {
        run: () => httpResponse(200, next('x'), []),
      }),
    /^Error: the next page of x repeats$/,
  );
  assert.throws(
    () =>
      ghRestPages('x', {
        run: ghFails(httpResponse(404, {}, { message: 'Not Found' })),
      }),
    { message: 'GitHub REST request failed: HTTP 404: Not Found.' },
  );
});
