import { execFileSync } from 'node:child_process';

// Every script that calls GitHub goes through `gh api` here, and every one of
// them reports a failure with failureMessage. The message comes from GitHub's
// response, which `gh api --include` prints on stdout even when it exits
// non-zero: the HTTP status, GitHub's error type and message, and the
// rate-limit reset. gh's stderr, request headers, and tokens never reach it.

const KINDS = ['rate_limit', 'auth', 'not_found', 'other'];
const AUTH_TYPES = new Set([
  'FORBIDDEN',
  'INSUFFICIENT_SCOPES',
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
]);
const RATE_LIMIT_TYPES = new Set([
  'RATE_LIMIT',
  'RATE_LIMITED',
  'GRAPHQL_RATE_LIMIT',
]);
const RATE_LIMIT = /rate.?limit/i;
const SECONDARY_LIMIT = /secondary rate limit|abuse detection/i;
const MAX_DETAIL = 300;
const MAX_ERRORS = 5;
const TOKEN_PATTERN = /\b(?:gh[opsru]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g;
// gh exits with status 4 when it has no credentials at all.
const GH_AUTH_REQUIRED = 4;

export class GitHubApiError extends Error {
  constructor(message, { kind = 'other', httpStatus, resetAt } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.kind = kind;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (resetAt !== undefined) this.resetAt = resetAt;
  }
}

// Removes token values that appear in the environment, and anything shaped
// like a GitHub token, in case GitHub ever echoes one back.
export function redact(text, env = process.env) {
  let result = String(text);
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'PRISMATIC_PROJECT_TOKEN']) {
    const token = env[name];
    if (token && token.length >= 8) result = result.split(token).join('***');
  }
  return result.replace(TOKEN_PATTERN, '***');
}

function clean(text) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > MAX_DETAIL ? `${value.slice(0, MAX_DETAIL)}...` : value;
}

// Splits `gh api --include` output into the HTTP status, lower-cased response
// headers, the body text, and the body parsed as JSON. Output without a status
// line is treated as a bare body.
export function parseResponse(output) {
  const text = String(output ?? '');
  const headers = {};
  let status;
  let body = text;
  const statusLine = /^HTTP\/[\d.]+ (\d{3})\b[^\n]*\n/.exec(text);
  if (statusLine) {
    status = Number(statusLine[1]);
    const blank = /\r?\n\r?\n/.exec(text);
    const head = blank ? text.slice(0, blank.index) : text;
    body = blank ? text.slice(blank.index + blank[0].length) : '';
    for (const line of head.split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0)
        headers[line.slice(0, colon).trim().toLowerCase()] = line
          .slice(colon + 1)
          .trim();
    }
  }
  let json;
  try {
    json = body.trim() ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }
  return { status, headers, body, json };
}

function graphqlKind(error) {
  const type = String(error?.type ?? error?.extensions?.code ?? '');
  if (
    RATE_LIMIT_TYPES.has(type) ||
    RATE_LIMIT.test(String(error?.code ?? '')) ||
    RATE_LIMIT.test(String(error?.message ?? ''))
  )
    return 'rate_limit';
  if (AUTH_TYPES.has(type)) return 'auth';
  if (type === 'NOT_FOUND') return 'not_found';
  return 'other';
}

function httpKind(status, headers, message) {
  if (status === 429) return 'rate_limit';
  if (status === 403) {
    if (
      RATE_LIMIT.test(String(message ?? '')) ||
      headers['x-ratelimit-remaining'] === '0' ||
      headers['retry-after'] !== undefined
    )
      return 'rate_limit';
    return 'auth';
  }
  if (status === 401) return 'auth';
  if (status === 404) return 'not_found';
  return 'other';
}

function rateLimitHint(headers, now, secondary) {
  const limit = secondary ? 'GitHub secondary rate limit' : 'GitHub rate limit';
  const retryAfter = Number(headers['retry-after']);
  if (headers['retry-after'] !== undefined && Number.isFinite(retryAfter)) {
    const resetAt = new Date(now + retryAfter * 1000);
    return {
      resetAt,
      hint: `${limit} reached; retry after ${retryAfter} seconds (${iso(resetAt)}).`,
    };
  }
  const reset = Number(headers['x-ratelimit-reset']);
  const remaining = headers['x-ratelimit-remaining'];
  // The reset header times the primary limit, so a secondary limit uses it
  // only when the primary limit is spent too.
  if (
    headers['x-ratelimit-reset'] !== undefined &&
    Number.isFinite(reset) &&
    (remaining === '0' || (remaining === undefined && !secondary))
  ) {
    const resetAt = new Date(reset * 1000);
    return {
      resetAt,
      hint: `${limit} reached; it resets at ${iso(resetAt)}.`,
    };
  }
  return {
    hint: `${limit} reached; wait for it to reset before retrying.`,
  };
}

function iso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const HINTS = {
  auth: 'Check the token and Projects access.',
  not_found:
    'It does not exist, or the token cannot see it; check the token and Projects access.',
};

// Builds the error for a failed `gh api` call from GitHub's response.
export function responseError(
  { status, headers = {}, json, exitStatus, missingGh = false } = {},
  { graphql = false, now = Date.now(), env = process.env } = {},
) {
  const prefix = graphql
    ? 'GitHub GraphQL request failed'
    : 'GitHub API request failed';
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const kinds = errors.map(graphqlKind);
  let details;
  if (errors.length) {
    const listed = [
      ...new Set(
        errors.map((error) => {
          const label = error?.type ?? error?.code ?? error?.extensions?.code;
          const message = clean(error?.message) || 'no message';
          return label ? `${clean(label)}: ${message}` : message;
        }),
      ),
    ];
    details = listed.slice(0, MAX_ERRORS).join('; ');
    if (listed.length > MAX_ERRORS)
      details += `; ${listed.length - MAX_ERRORS} more errors`;
  }
  if (status !== undefined && status >= 400) {
    kinds.push(httpKind(status, headers, json?.message));
    details ??= clean(json?.message)
      ? `HTTP ${status}: ${clean(json.message)}`
      : `HTTP ${status} with no usable response body`;
  }
  if (details === undefined) {
    if (missingGh) {
      details = 'the gh command is not installed';
    } else if (exitStatus === GH_AUTH_REQUIRED) {
      kinds.push('auth');
      details = 'gh has no GitHub credentials';
    } else if (status !== undefined) {
      details = `HTTP ${status} with no usable response body`;
    } else if (exitStatus !== undefined) {
      details = `gh exited with status ${exitStatus} and no response from GitHub`;
    } else {
      details = 'gh returned no usable response from GitHub';
    }
  }
  const kind = KINDS.find((candidate) => kinds.includes(candidate)) ?? 'other';
  let hint = HINTS[kind];
  let resetAt;
  if (kind === 'rate_limit') {
    const secondary = [json?.message, ...errors.map((error) => error?.message)]
      .filter((text) => typeof text === 'string')
      .some((text) => SECONDARY_LIMIT.test(text));
    ({ hint, resetAt } = rateLimitHint(headers, now, secondary));
  }
  const message = `${prefix}: ${details.replace(/\.$/, '')}.${hint ? ` ${hint}` : ''}`;
  return new GitHubApiError(redact(message, env), {
    kind,
    httpStatus: status !== undefined && status >= 400 ? status : undefined,
    resetAt,
  });
}

function request(args, { input, run = execFileSync, graphql }) {
  try {
    const output = run('gh', ['api', '--include', ...args], {
      ...(input === undefined ? {} : { input }),
      encoding: 'utf8',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    return { failed: false, ...parseResponse(output) };
  } catch (cause) {
    if (!cause?.stdout)
      throw responseError(
        {
          exitStatus:
            typeof cause?.status === 'number' ? cause.status : undefined,
          missingGh: cause?.code === 'ENOENT',
        },
        { graphql },
      );
    return {
      failed: true,
      exitStatus: cause.status,
      ...parseResponse(cause.stdout),
    };
  }
}

// Runs a GraphQL query and returns its data. `allowErrors(result)` may accept
// a response whose errors are expected, such as a NOT_FOUND for a reference.
export function ghGraphql(
  query,
  variables,
  { run = execFileSync, allowErrors } = {},
) {
  const response = request(['graphql', '--input', '-'], {
    input: JSON.stringify({ query, variables }),
    run,
    graphql: true,
  });
  const { json } = response;
  if (json?.errors?.length) {
    if (allowErrors?.(json)) return json.data;
    throw responseError(response, { graphql: true });
  }
  if (response.failed || response.status >= 400 || !json?.data)
    throw responseError(response, { graphql: true });
  return json.data;
}

// Runs a REST request and returns the response body text. A failure carries
// the HTTP status as `httpStatus` when GitHub sent one.
export function ghRest(args, { run = execFileSync } = {}) {
  const output = request(args, { run, graphql: false });
  if (output.failed || output.status >= 400) throw responseError(output);
  return output.body;
}

// The one line a script prints when it fails. GitHub failures carry a message
// built from the response; any other subprocess error can hold gh's stderr,
// which can contain authentication details, so it gets a fixed message.
export function failureMessage(error, env = process.env) {
  if (error instanceof GitHubApiError) return redact(error.message, env);
  if (error?.code || error?.status || error?.stderr)
    return 'GitHub API request failed. Check the token and Projects access.';
  return redact(error?.message ?? String(error), env);
}
