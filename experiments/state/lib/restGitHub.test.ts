import { describe, expect, test } from 'vitest';
import { RestGitHub } from './restGitHub.ts';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

// Answers each request from a route table and records it. No network.
function fakeFetch(routes: Record<string, [number, unknown]>): {
  readonly calls: Call[];
  readonly fetch: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: init?.headers as Record<string, string>,
      body:
        init?.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const key = `${method} ${url.replace('https://api.github.com', '')}`;
    const [status, body] = routes[key] ?? [404, { message: 'Not Found' }];
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
    });
  };
  return { calls, fetch: fetchImpl as typeof fetch };
}

const bot = { login: 'github-actions[bot]', id: 11, type: 'Bot' };
const repo = '/repos/octo/sandbox';

function client(routes: Record<string, [number, unknown]>) {
  const fake = fakeFetch(routes);
  return {
    ...fake,
    github: new RestGitHub({
      token: 'test-token',
      repository: 'octo/sandbox',
      prNumber: 5,
      fetch: fake.fetch,
      maxPages: 2,
    }),
  };
}

describe('RestGitHub', () => {
  test('resolves users and sends the API headers', async () => {
    const { github, calls } = client({
      'GET /user': [200, { login: 'cli-user', id: 3, type: 'User' }],
      'GET /users/github-actions%5Bbot%5D': [200, bot],
    });
    await expect(github.authenticatedUser()).resolves.toEqual({
      login: 'cli-user',
      id: 3,
      type: 'User',
    });
    await expect(github.userByLogin('github-actions[bot]')).resolves.toEqual(
      bot,
    );
    expect(calls[0]?.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      authorization: 'Bearer test-token',
      'x-github-api-version': '2022-11-28',
    });
  });

  test('turns an error status into a GitHubError with GitHub’s message', async () => {
    const { github } = client({
      'GET /user': [403, { message: 'Resource not accessible by integration' }],
    });
    await expect(github.authenticatedUser()).rejects.toMatchObject({
      status: 403,
      message: 'Resource not accessible by integration',
    });
    const bare = client({ 'GET /user': [500, 'oops'] });
    await expect(bare.github.authenticatedUser()).rejects.toMatchObject({
      message: 'HTTP 500',
    });
  });

  test('reads the role name, then the permission, then defaults to read', async () => {
    const path = `GET ${repo}/collaborators/maya/permission`;
    await expect(
      client({
        [path]: [200, { role_name: 'maintain', permission: 'write' }],
      }).github.permissionOf('maya'),
    ).resolves.toBe('maintain');
    await expect(
      client({
        [path]: [200, { role_name: 'custom', permission: 'admin' }],
      }).github.permissionOf('maya'),
    ).resolves.toBe('admin');
    await expect(
      client({ [path]: [200, { permission: 'none' }] }).github.permissionOf(
        'maya',
      ),
    ).resolves.toBe('read');
  });

  test('pages through comments and keeps GitHub’s author id', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      user: bot,
      body: `c${i}`,
    }));
    const { github } = client({
      [`GET ${repo}/issues/5/comments?per_page=100&page=1`]: [200, page1],
      [`GET ${repo}/issues/5/comments?per_page=100&page=2`]: [
        200,
        [{ id: 100, user: null, body: null }],
      ],
      [`GET ${repo}/pulls/5/comments?per_page=100&page=1`]: [
        200,
        [{ id: 7, user: bot, body: 'inline', path: 'a.ts', line: 3 }],
      ],
    });
    const issue = await github.listComments('issue');
    expect(issue).toHaveLength(101);
    expect(issue[100]).toEqual({
      id: 100,
      author: { login: 'ghost', id: -1, type: 'User' },
      body: '',
    });
    await expect(github.listComments('review')).resolves.toEqual([
      { id: 7, author: bot, body: 'inline', anchor: { path: 'a.ts', line: 3 } },
    ]);
  });

  test('refuses to read past its page bound', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      user: bot,
      body: '',
    }));
    const { github } = client({
      [`GET ${repo}/issues/5/comments?per_page=100&page=1`]: [200, full],
      [`GET ${repo}/issues/5/comments?per_page=100&page=2`]: [200, full],
    });
    await expect(github.listComments('issue')).rejects.toThrow('more comments');
  });

  test('creates, edits and deletes comments on the right endpoints', async () => {
    const { github, calls } = client({
      [`POST ${repo}/issues/5/comments`]: [
        201,
        { id: 1, user: bot, body: 'a' },
      ],
      [`GET ${repo}/pulls/5`]: [200, { head: { sha: 'f'.repeat(40) } }],
      [`POST ${repo}/pulls/5/comments`]: [
        201,
        { id: 2, user: bot, body: 'b', path: 'x.ts', line: 4 },
      ],
      [`PATCH ${repo}/issues/comments/1`]: [
        200,
        { id: 1, user: bot, body: 'c' },
      ],
      [`PATCH ${repo}/pulls/comments/2`]: [
        200,
        { id: 2, user: bot, body: 'd' },
      ],
      [`DELETE ${repo}/issues/comments/1`]: [204, null],
    });
    await expect(github.createComment('issue', 'a')).resolves.toMatchObject({
      id: 1,
    });
    await expect(
      github.createComment('review', 'b', { path: 'x.ts', line: 4 }),
    ).resolves.toMatchObject({ anchor: { path: 'x.ts', line: 4 } });
    await expect(github.updateComment('issue', 1, 'c')).resolves.toMatchObject({
      body: 'c',
    });
    await expect(github.updateComment('review', 2, 'd')).resolves.toMatchObject(
      { body: 'd' },
    );
    await expect(github.deleteComment('issue', 1)).resolves.toBeUndefined();
    expect(
      calls.find(
        (call) => call.method === 'POST' && call.url.includes('/pulls/'),
      )?.body,
    ).toEqual({
      body: 'b',
      commit_id: 'f'.repeat(40),
      path: 'x.ts',
      line: 4,
      side: 'RIGHT',
    });
  });

  test('refuses a pull request with no head and bad constructor input', async () => {
    const { github } = client({ [`GET ${repo}/pulls/5`]: [200, {}] });
    await expect(github.headSha()).rejects.toThrow('no head');
    expect(
      () => new RestGitHub({ token: 't', repository: '../x', prNumber: 1 }),
    ).toThrow('owner/name');
    expect(
      () => new RestGitHub({ token: 't', repository: 'a/b', prNumber: 0 }),
    ).toThrow('positive');
    expect(
      new RestGitHub({ token: 't', repository: 'a/b', prNumber: 1 }),
    ).toBeInstanceOf(RestGitHub);
  });
});
