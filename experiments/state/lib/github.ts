// The slice of the GitHub REST API the state protocol needs, and an in-memory
// fake of it. The fake behaves the way GitHub does where it matters here:
// comments stay editable and deletable after they are written, the author is
// whoever owns the token that wrote them, a maintainer can edit or delete a
// comment without changing its author, and an installation token (the Actions
// GITHUB_TOKEN or a GitHub App token) cannot read `GET /user`.

export type AccountType = 'User' | 'Bot' | 'Organization';

// GitHub reports `login`, `id` and `type`; the protocol only trusts `id`.
export interface Account {
  readonly login: string;
  readonly id: number;
  readonly type: AccountType;
}

export interface Anchor {
  readonly path: string;
  readonly line: number;
}

export interface Comment {
  readonly id: number;
  readonly author: Account;
  readonly body: string;
  // Set on review (inline) comments only.
  readonly anchor?: Anchor;
}

// `issue` comments hold the status snapshot, journal shards and progress
// comments; `review` comments are the inline threads.
export type CommentChannel = 'issue' | 'review';

export type Permission = 'admin' | 'maintain' | 'write' | 'triage' | 'read';

export interface GitHubPort {
  // The account that owns the token. Installation tokens get a 403.
  authenticatedUser(): Promise<Account>;
  // The account a login names today. Logins can be renamed and reused; ids
  // cannot.
  userByLogin(login: string): Promise<Account>;
  // The permission of the account the login names now, with that account.
  permissionOf(
    login: string,
  ): Promise<{ readonly account: Account; readonly permission: Permission }>;
  // Every page, oldest first.
  listComments(channel: CommentChannel): Promise<readonly Comment[]>;
  createComment(
    channel: CommentChannel,
    body: string,
    anchor?: Anchor,
  ): Promise<Comment>;
  updateComment(
    channel: CommentChannel,
    id: number,
    body: string,
  ): Promise<Comment>;
  // The pull request's head SHA now.
  headSha(): Promise<string>;
}

export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

// What a client sees when its request reached GitHub but the response did
// not come back: the write may or may not have happened.
export class LostResponseError extends Error {
  constructor() {
    super('The response was lost; the write may have been applied.');
    this.name = 'LostResponseError';
  }
}

export type TokenKind = 'installation' | 'personal';

interface StoredComment {
  readonly channel: CommentChannel;
  comment: Comment;
}

// One pull request in one repository. Each `client(...)` writes as one
// account, so a test can hold the publisher's client and an attacker's client
// at the same time.
export class FakeGitHub {
  readonly #accounts = new Map<string, Account>();
  readonly #permissions = new Map<number, Permission>();
  readonly #comments = new Map<number, StoredComment>();
  #nextId = 1000;
  #head: string;
  #loseAfter: number | undefined;
  #writes = 0;

  constructor(head: string) {
    this.#head = head;
  }

  get writes(): number {
    return this.#writes;
  }

  addAccount(account: Account, permission: Permission = 'read'): Account {
    this.#accounts.set(account.login.toLowerCase(), account);
    this.#permissions.set(account.id, permission);
    return account;
  }

  // A rename frees the old login, and another account can then take it.
  rename(id: number, login: string): void {
    const entry = [...this.#accounts].find(([, account]) => account.id === id);
    if (entry === undefined) throw new RangeError(`No account ${id}.`);
    this.#accounts.delete(entry[0]);
    this.#accounts.set(login.toLowerCase(), { ...entry[1], login });
  }

  setHead(sha: string): void {
    this.#head = sha;
  }

  // After `skip` more writes, the next one is applied and then throws
  // LostResponseError.
  loseResponse(skip = 0): void {
    this.#loseAfter = skip;
  }

  comments(channel: CommentChannel): readonly Comment[] {
    return [...this.#comments.values()]
      .filter((stored) => stored.channel === channel)
      .map((stored) => stored.comment);
  }

  // A maintainer's edit through the UI or API. The author does not change.
  edit(id: number, body: string): void {
    const stored = this.#stored(id);
    stored.comment = { ...stored.comment, body };
  }

  delete(id: number): void {
    this.#stored(id);
    this.#comments.delete(id);
  }

  client(login: string, token: TokenKind): GitHubPort {
    const account = this.account(login);
    if (account === undefined) throw new RangeError(`No account ${login}.`);
    return new FakeClient(this, account, token);
  }

  account(login: string): Account | undefined {
    return this.#accounts.get(login.toLowerCase());
  }

  permission(id: number): Permission {
    return this.#permissions.get(id) ?? 'read';
  }

  head(): string {
    return this.#head;
  }

  write(
    channel: CommentChannel,
    author: Account,
    body: string,
    target: { readonly anchor?: Anchor; readonly id?: number },
  ): Comment {
    let comment: Comment;
    if (target.id === undefined) {
      comment = {
        id: this.#nextId,
        author,
        body,
        ...(target.anchor === undefined ? {} : { anchor: target.anchor }),
      };
      this.#nextId += 1;
      this.#comments.set(comment.id, { channel, comment });
    } else {
      const stored = this.#stored(target.id);
      if (stored.channel !== channel) throw new GitHubError(404, 'Not Found');
      if (stored.comment.author.id !== author.id) {
        throw new GitHubError(403, 'Only the author can edit this comment.');
      }
      comment = { ...stored.comment, body };
      stored.comment = comment;
    }
    this.#writes += 1;
    if (this.#loseAfter !== undefined) {
      this.#loseAfter -= 1;
      if (this.#loseAfter < 0) {
        this.#loseAfter = undefined;
        throw new LostResponseError();
      }
    }
    return comment;
  }

  #stored(id: number): StoredComment {
    const stored = this.#comments.get(id);
    if (stored === undefined) throw new GitHubError(404, 'Not Found');
    return stored;
  }
}

class FakeClient implements GitHubPort {
  readonly #github: FakeGitHub;
  readonly #account: Account;
  readonly #token: TokenKind;

  constructor(github: FakeGitHub, account: Account, token: TokenKind) {
    this.#github = github;
    this.#account = account;
    this.#token = token;
  }

  async authenticatedUser(): Promise<Account> {
    if (this.#token === 'installation') {
      throw new GitHubError(403, 'Resource not accessible by integration');
    }
    return this.#account;
  }

  async userByLogin(login: string): Promise<Account> {
    const account = this.#github.account(login);
    if (account === undefined) throw new GitHubError(404, 'Not Found');
    return account;
  }

  async permissionOf(
    login: string,
  ): Promise<{ readonly account: Account; readonly permission: Permission }> {
    const account = await this.userByLogin(login);
    return { account, permission: this.#github.permission(account.id) };
  }

  async listComments(channel: CommentChannel): Promise<readonly Comment[]> {
    return this.#github.comments(channel);
  }

  async createComment(
    channel: CommentChannel,
    body: string,
    anchor?: Anchor,
  ): Promise<Comment> {
    return this.#github.write(
      channel,
      this.#account,
      body,
      anchor === undefined ? {} : { anchor },
    );
  }

  async updateComment(
    channel: CommentChannel,
    id: number,
    body: string,
  ): Promise<Comment> {
    return this.#github.write(channel, this.#account, body, { id });
  }

  async headSha(): Promise<string> {
    return this.#github.head();
  }
}
