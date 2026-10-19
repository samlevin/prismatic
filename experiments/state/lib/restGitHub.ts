// The GitHub port over the REST API, for the live identity probe. It maps
// GitHub's payloads to the port's types and nothing more: the author of
// every comment is `user.id` exactly as GitHub reports it, and a comment
// whose user was deleted gets an id no publisher can have.
import type {
  Account,
  AccountType,
  Anchor,
  Comment,
  CommentChannel,
  GitHubPort,
  Permission,
} from './github.ts';
import { GitHubError } from './github.ts';

export interface RestOptions {
  readonly token: string;
  readonly repository: string;
  readonly prNumber: number;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly maxPages?: number;
}

const repository = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const permissions: readonly string[] = [
  'admin',
  'maintain',
  'write',
  'triage',
  'read',
];
const ghost: Account = { login: 'ghost', id: -1, type: 'User' };

export class RestGitHub implements GitHubPort {
  readonly #token: string;
  readonly #repo: string;
  readonly #pr: number;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #maxPages: number;

  constructor(options: RestOptions) {
    if (!repository.test(options.repository)) {
      throw new RangeError('The repository must be owner/name.');
    }
    if (!Number.isSafeInteger(options.prNumber) || options.prNumber <= 0) {
      throw new RangeError('The pull request number must be positive.');
    }
    this.#token = options.token;
    this.#repo = `/repos/${options.repository}`;
    this.#pr = options.prNumber;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = options.baseUrl ?? 'https://api.github.com';
    this.#maxPages = options.maxPages ?? 30;
  }

  async authenticatedUser(): Promise<Account> {
    return toAccount(await this.#request('GET', '/user'));
  }

  async userByLogin(login: string): Promise<Account> {
    return toAccount(
      await this.#request('GET', `/users/${encodeURIComponent(login)}`),
    );
  }

  async permissionOf(login: string): Promise<Permission> {
    const body = (await this.#request(
      'GET',
      `${this.#repo}/collaborators/${encodeURIComponent(login)}/permission`,
    )) as { role_name?: unknown; permission?: unknown };
    const role = [body.role_name, body.permission].find((value) =>
      permissions.includes(value as string),
    );
    return (role as Permission | undefined) ?? 'read';
  }

  async listComments(channel: CommentChannel): Promise<readonly Comment[]> {
    const comments: Comment[] = [];
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const items = (await this.#request(
        'GET',
        `${this.#collection(channel)}?per_page=100&page=${page}`,
      )) as unknown[];
      comments.push(...items.map(toComment));
      if (items.length < 100) return comments;
    }
    throw new GitHubError(
      0,
      'The pull request has more comments than the probe reads.',
    );
  }

  async createComment(
    channel: CommentChannel,
    body: string,
    anchor?: Anchor,
  ): Promise<Comment> {
    const payload =
      channel === 'review'
        ? {
            body,
            commit_id: await this.headSha(),
            path: anchor?.path,
            line: anchor?.line,
            side: 'RIGHT',
          }
        : { body };
    return toComment(
      await this.#request('POST', this.#collection(channel), payload),
    );
  }

  async updateComment(
    channel: CommentChannel,
    id: number,
    body: string,
  ): Promise<Comment> {
    return toComment(
      await this.#request('PATCH', this.#item(channel, id), { body }),
    );
  }

  // Not part of the port: the probe removes its own test comment.
  async deleteComment(channel: CommentChannel, id: number): Promise<void> {
    await this.#request('DELETE', this.#item(channel, id));
  }

  async headSha(): Promise<string> {
    const pull = (await this.#request(
      'GET',
      `${this.#repo}/pulls/${this.#pr}`,
    )) as {
      head?: { sha?: unknown };
    };
    const sha = pull.head?.sha;
    if (typeof sha !== 'string')
      throw new GitHubError(0, 'The pull request has no head.');
    return sha;
  }

  #collection(channel: CommentChannel): string {
    return `${this.#repo}/${channel === 'issue' ? 'issues' : 'pulls'}/${this.#pr}/comments`;
  }

  #item(channel: CommentChannel, id: number): string {
    return `${this.#repo}/${channel === 'issue' ? 'issues' : 'pulls'}/comments/${id}`;
  }

  async #request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.#token}`,
        'user-agent': 'prismatic-state-spike',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return undefined;
    const parsed: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = (parsed as { message?: unknown }).message;
      throw new GitHubError(
        response.status,
        typeof message === 'string'
          ? message.slice(0, 200)
          : `HTTP ${response.status}`,
      );
    }
    return parsed;
  }
}

function toAccount(value: unknown): Account {
  const user = value as {
    login?: unknown;
    id?: unknown;
    type?: unknown;
  } | null;
  if (
    user === null ||
    typeof user.login !== 'string' ||
    !Number.isSafeInteger(user.id) ||
    typeof user.type !== 'string'
  ) {
    return ghost;
  }
  return {
    login: user.login,
    id: user.id as number,
    type: user.type as AccountType,
  };
}

function toComment(value: unknown): Comment {
  const item = value as {
    id: number;
    user: unknown;
    body?: unknown;
    path?: unknown;
    line?: unknown;
  };
  const comment = {
    id: item.id,
    author: toAccount(item.user),
    body: typeof item.body === 'string' ? item.body : '',
  };
  return typeof item.path === 'string' && typeof item.line === 'number'
    ? { ...comment, anchor: { path: item.path, line: item.line } }
    : comment;
}
