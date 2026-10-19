// Resolves the account whose comments the protocol may trust, from inputs an
// attacker cannot write, and checks authors against its immutable id.
//
// The expected login comes from the trusted workflow input or from the CLI's
// own personal token. It is never read from a marker, a snapshot, the author
// of a comment that a marker selected, or model output. Comments are then
// accepted only when the author id GitHub reports equals the resolved id, so
// a forged snapshot that names its own author, or an account that took over a
// renamed login, does not pass.
import type { Account, Comment, GitHubPort } from './github.ts';

export const defaultActionsPublisher = 'github-actions[bot]';

// The ways a run can hold a token. The Actions GITHUB_TOKEN and a GitHub App
// token are installation tokens: `GET /user` refuses them, so the login has
// to come from the trusted workflow input.
export type PublisherSource =
  | { readonly kind: 'actions-token'; readonly publisherLogin?: string }
  | { readonly kind: 'app-token'; readonly publisherLogin: string }
  | { readonly kind: 'cli-personal-token' }
  | { readonly kind: 'cli-app-token'; readonly publisherLogin: string };

export interface ExpectedPublisher {
  readonly login: string;
  readonly id: number;
  readonly source: PublisherSource['kind'];
}

export type PublisherErrorCode =
  | 'invalid-login'
  | 'publisher-login-required'
  | 'unexpected-account-type'
  | 'author-mismatch';

export class PublisherError extends Error {
  readonly code: PublisherErrorCode;

  constructor(code: PublisherErrorCode, message: string) {
    super(message);
    this.name = 'PublisherError';
    this.code = code;
  }
}

// A user or organization login, or an App's bot login (`<slug>[bot]`).
const login = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

export async function resolveExpectedPublisher(
  source: PublisherSource,
  github: GitHubPort,
): Promise<ExpectedPublisher> {
  if (source.kind === 'cli-personal-token') {
    const account = await github.authenticatedUser();
    requireType(account, 'User');
    return { login: account.login, id: account.id, source: source.kind };
  }
  const configured =
    source.kind === 'actions-token'
      ? (source.publisherLogin ?? defaultActionsPublisher)
      : source.publisherLogin;
  if (configured.trim() === '') {
    throw new PublisherError(
      'publisher-login-required',
      'An App token needs the trusted publisher-login input.',
    );
  }
  if (!login.test(configured)) {
    throw new PublisherError(
      'invalid-login',
      'The publisher login is invalid.',
    );
  }
  // An App token always posts as the App's bot user.
  if (source.kind !== 'actions-token' && !configured.endsWith('[bot]')) {
    throw new PublisherError(
      'invalid-login',
      'An App publisher login ends in [bot].',
    );
  }
  const account = await github.userByLogin(configured);
  // An App posts as its bot user. That user's id is not the App id, and only
  // the bot user's id appears as a comment author.
  requireType(account, configured.endsWith('[bot]') ? 'Bot' : 'User');
  return { login: account.login, id: account.id, source: source.kind };
}

function requireType(account: Account, type: Account['type']): void {
  if (account.type !== type) {
    throw new PublisherError(
      'unexpected-account-type',
      `The publisher resolved to a ${account.type} account, not a ${type}.`,
    );
  }
}

export function isAuthentic(
  comment: Comment,
  publisher: ExpectedPublisher,
): boolean {
  return comment.author.id === publisher.id;
}

// Every write response must name the expected publisher; a token for another
// account means the run is not writing what later runs will trust.
export function requireAuthentic(
  comment: Comment,
  publisher: ExpectedPublisher,
): Comment {
  if (!isAuthentic(comment, publisher)) {
    throw new PublisherError(
      'author-mismatch',
      'GitHub reported a different author for a write than the expected publisher.',
    );
  }
  return comment;
}
