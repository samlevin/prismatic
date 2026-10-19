// Operational errors in a form that is safe to log, publish, or return as an
// Action output: a name, a code, and a one-line message, with secrets masked
// and stack traces, terminal escapes, and control characters removed.
import { patternSecretRedactor, type SecretRedactor } from './redaction.ts';
import { stripAnsi } from './text.ts';

export interface NormalizedError {
  readonly name: string;
  // The error's own `code` (such as `ENOENT` or `invalid-path`) when it is a
  // short identifier, else `unknown`.
  readonly code: string;
  readonly message: string;
  readonly cause?: NormalizedError;
}

export const maxNormalizedMessageLength = 500;

// The most levels kept, counting the error itself and each cause below it.
export const maxNormalizedCauseDepth = 3;

const identifier = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const lineBreak = /\r\n|[\n\r\u2028\u2029]/;
const stackFrame = /^\s*at\s/;
// eslint-disable-next-line no-control-regex -- control characters are the point
const controlCharacters = /[\u0000-\u001F\u007F]/g;

// Never throws. Pass the run's redactor, seeded with its secrets at
// bootstrap; the default masks credential patterns only.
export function normalizeError(
  error: unknown,
  redactor: SecretRedactor = patternSecretRedactor,
): NormalizedError {
  return normalize(error, redactor, 0);
}

function normalize(
  error: unknown,
  redactor: SecretRedactor,
  depth: number,
): NormalizedError {
  if (!(error instanceof Error)) {
    return {
      name: 'NonError',
      code: 'unknown',
      message:
        typeof error === 'string'
          ? cleanMessage(error, redactor)
          : `A non-error ${error === null ? 'null' : typeof error} value was thrown.`,
    };
  }
  const name = readString(error, 'name');
  const normalized = {
    name: name !== undefined && identifier.test(name) ? name : 'Error',
    code: readCode(error, redactor),
    message: cleanMessage(readString(error, 'message') ?? '', redactor),
  };
  const cause = read(error, 'cause');
  if (cause === undefined || depth + 1 >= maxNormalizedCauseDepth) {
    return normalized;
  }
  return { ...normalized, cause: normalize(cause, redactor, depth + 1) };
}

// Masks secrets first, while a private key block is still whole, then drops
// stack frame lines, joins the rest into one line, and truncates it.
function cleanMessage(raw: string, redactor: SecretRedactor): string {
  const message = redactor
    .redactText(stripAnsi(raw))
    .split(lineBreak)
    .filter((line) => !stackFrame.test(line))
    .join(' ')
    .replace(controlCharacters, ' ')
    .trim();
  return message.length > maxNormalizedMessageLength
    ? `${message.slice(0, maxNormalizedMessageLength - 3)}...`
    : message;
}

function readCode(error: Error, redactor: SecretRedactor): string {
  const code = read(error, 'code');
  if (typeof code === 'number' && Number.isSafeInteger(code)) {
    return String(code);
  }
  if (typeof code !== 'string') return 'unknown';
  const masked = redactor.redactText(code);
  return masked === code && identifier.test(code) ? code : 'unknown';
}

function readString(error: Error, key: string): string | undefined {
  const value = read(error, key);
  return typeof value === 'string' ? value : undefined;
}

// A getter that throws must not turn error handling into a second failure.
function read(error: Error, key: string): unknown {
  try {
    return (error as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
