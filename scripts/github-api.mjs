import { execFileSync } from 'node:child_process';

// Every script that calls GitHub goes through `gh api` here and reports a
// failure through GitHubError and failureMessage, so logs carry GitHub's own
// error type and message but never a token, request headers, or gh stderr.
const MAX_DETAIL = 300;
const MAX_ERRORS = 5;
const TOKEN_PATTERN = /\b(?:gh[opsru]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g;
const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'PRISMATIC_PROJECT_TOKEN'];
const RATE_LIMIT_TYPES = new Set([
  'RATE_LIMITED',
  'RATE_LIMIT',
  'GRAPHQL_RATE_LIMIT',
]);
const ACCESS_TYPES = new Set([
  'FORBIDDEN',
  'INSUFFICIENT_SCOPES',
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
]);
const ACCESS_HINT =
  'Check that the token is valid and has issue and Projects access.';

export function redact(text, env = process.env) {
  let result = String(text);
  for (const name of TOKEN_VARIABLES) {
    const token = env[name];
    if (token && token.length >= 8) result = result.split(token).join('***');
  }
  return result.replace(TOKEN_PATTERN, '***');
}

export class GitHubError extends Error {
  constructor(message, details = {}) {
    super(redact(message));
    this.name = 'GitHubError';
    Object.assign(this, details);
  }
}

// Splits `gh api --include` output into the status, lowercased headers, and
// body. Output without a status line is treated as a bare body.
export function parseResponse(output) {
  const raw = String(output ?? '');
  const headers = {};
  let status;
  let text = raw;
  const statusLine = /^HTTP\/\S+ (\d{3})/.exec(raw);
  if (statusLine) {
    status = Number(statusLine[1]);
    const end = /\r?\n\r?\n/.exec(raw);
    text = end ? raw.slice(end.index + end[0].length) : '';
    const head = end ? raw.slice(0, end.index) : raw;
    for (const line of head.split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0)
        headers[line.slice(0, colon).trim().toLowerCase()] = line
          .slice(colon + 1)
          .trim();
    }
  }
  let body;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status, headers, body, text };
}

function clean(value) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text;
}

function sentence(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function errorDetail(error) {
  if (typeof error === 'string') return clean(error);
  const kind = error?.type ?? error?.code;
  const message = typeof error?.message === 'string' ? error.message : '';
  return [kind, message]
    .filter((part) => part !== undefined && part !== '')
    .map(clean)
    .join(': ');
}

function resetHint(headers, secondary) {
  const retryAfter = headers['retry-after'];
  if (retryAfter !== undefined && /^\d+$/.test(retryAfter))
    return `retry after ${Number(retryAfter)} seconds`;
  const reset = Number(headers['x-ratelimit-reset']);
  if (
    Number.isSafeInteger(reset) &&
    reset > 0 &&
    (headers['x-ratelimit-remaining'] === '0' || !secondary)
  )
    return `the limit resets at ${new Date(reset * 1000).toISOString()}`;
  return 'GitHub did not say when it resets';
}

// Builds the error for a GitHub response that failed or carried errors.
export function githubError(api, { status, headers = {}, body, text = '' }) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const types = errors.map((error) =>
    String(error?.type ?? error?.code ?? '').toUpperCase(),
  );
  const texts = [body?.message, ...errors.map((error) => error?.message)]
    .filter((text) => typeof text === 'string')
    .join(' ');
  const failedStatus = status >= 400 ? status : undefined;
  const parts = [];
  const head = [
    failedStatus && `HTTP ${failedStatus}`,
    typeof body?.message === 'string' && clean(body.message),
  ]
    .filter(Boolean)
    .join(': ');
  if (head) parts.push(head);
  for (const error of errors.slice(0, MAX_ERRORS)) {
    const detail = errorDetail(error);
    if (detail) parts.push(detail);
  }
  if (errors.length > MAX_ERRORS)
    parts.push(`${errors.length - MAX_ERRORS} more errors`);
  // A body that is not JSON is never echoed; it may not come from GitHub.
  if (body === null && text.trim()) parts.push('the response was not JSON');
  if (!parts.length) parts.push('GitHub returned no error details');
  const secondary = /secondary rate limit|abuse detection/i.test(texts);
  const rateLimited =
    status === 429 ||
    secondary ||
    types.some((type) => RATE_LIMIT_TYPES.has(type)) ||
    /\brate limit/i.test(texts) ||
    (status === 403 && headers['x-ratelimit-remaining'] === '0');
  const accessDenied =
    !rateLimited &&
    (status === 401 ||
      status === 403 ||
      types.some((type) => ACCESS_TYPES.has(type)));
  const notFound =
    status === 404 ||
    (errors.length > 0 && types.every((type) => type === 'NOT_FOUND'));
  let message = `GitHub ${api} request failed: ${sentence(parts.join('; '))}`;
  if (rateLimited)
    message += ` ${secondary ? 'Secondary rate limit' : 'Rate limit'} reached; ${resetHint(headers, secondary)}.`;
  else if (accessDenied) message += ` ${ACCESS_HINT}`;
  return new GitHubError(message, {
    httpStatus: failedStatus,
    kind: rateLimited
      ? 'rate-limit'
      : accessDenied
        ? 'access'
        : notFound
          ? 'not-found'
          : 'other',
  });
}

// Runs `gh api --include` so a failure carries its HTTP status and rate-limit
// headers. gh writes the response to stdout even when it exits non-zero; its
// stderr is never read.
export function ghRequest(api, args, { input, run = execFileSync } = {}) {
  try {
    const output = run('gh', ['api', '--include', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...(input === undefined
        ? { stdio: ['ignore', 'pipe', 'pipe'] }
        : { input, stdio: ['pipe', 'pipe', 'pipe'] }),
    });
    return { ...parseResponse(output), failed: false };
  } catch (cause) {
    if (cause?.stdout) return { ...parseResponse(cause.stdout), failed: true };
    const reason =
      cause?.code === 'ENOENT'
        ? 'gh is not installed or not on PATH'
        : `gh exited${cause?.status == null ? '' : ` with status ${cause.status}`} without a GitHub response`;
    throw new GitHubError(
      `GitHub ${api} request failed: ${reason}. Check that gh is authenticated and GitHub is reachable.`,
      { kind: 'other' },
    );
  }
}

// `allowErrors(result)` lets a caller accept a response whose errors it
// expects, such as a NOT_FOUND for a reference.
export function ghGraphql(
  query,
  variables,
  { run = execFileSync, allowErrors = () => false } = {},
) {
  const response = ghRequest('GraphQL', ['graphql', '--input', '-'], {
    input: JSON.stringify({ query, variables }),
    run,
  });
  const result = response.body;
  if (result?.errors?.length) {
    if (!allowErrors(result)) throw githubError('GraphQL', response);
  } else if (
    response.failed ||
    !result ||
    typeof result !== 'object' ||
    !('data' in result)
  )
    throw githubError('GraphQL', response);
  return result.data;
}

// Returns the response body text; errors carry `httpStatus` when GitHub sent one.
export function ghRest(args, { run = execFileSync, input } = {}) {
  const response = ghRequest('REST', args, { input, run });
  if (response.failed) throw githubError('REST', response);
  return response.text;
}

// Reads every page of a REST list by following the Link header, which also
// pages the cursor-based Projects v2 endpoints. Returns each page's body.
export function ghRestPages(path, { run = execFileSync } = {}) {
  const pages = [];
  const seen = new Set();
  for (let next = path; next;) {
    if (seen.has(next)) throw new Error(`the next page of ${path} repeats`);
    seen.add(next);
    const response = ghRequest('REST', [next], { run });
    if (response.failed) throw githubError('REST', response);
    pages.push(response.body);
    next = /<https:\/\/api\.github\.com\/([^>]+)>;\s*rel="next"/.exec(
      response.headers.link ?? '',
    )?.[1];
  }
  return pages;
}

// The only text an entry point prints for a failure.
export function failureMessage(error) {
  if (error instanceof GitHubError) return error.message;
  if (error?.code || error?.status)
    return `GitHub API request failed. ${ACCESS_HINT}`;
  return redact(error?.message ?? error);
}
