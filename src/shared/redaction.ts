// Defense-in-depth redaction of output: logs, errors, Action outputs, and
// published text. It masks the exact secrets the run holds, in raw and base64
// forms, plus token-shaped strings that match the credential patterns below.
// Masking is best effort and does not replace a secret scanner. Each match
// becomes `[REDACTED:<kind>]`; nothing of the value is kept.

// Seeded secrets are also matched inside longer base64 text, such as the
// basic Authorization header Git sends, where `x-access-token:<token>` is
// encoded as a whole. An encoded fragment shorter than this is not matched,
// so short random runs of ordinary text are left alone.
export const minEncodedSecretLength = 8;

// Nesting deeper than this is replaced, so a hostile value cannot exhaust the
// stack.
export const maxRedactionDepth = 64;

const marker = (kind: string): string => `[REDACTED:${kind}]`;

// The look-ahead `(?!\[REDACTED:)` keeps already masked text stable, so
// redacting twice gives the same result as redacting once.
interface CredentialPattern {
  readonly kind: string;
  readonly pattern: RegExp;
  // Number of leading capture groups kept in front of the marker.
  readonly keep?: number;
}

const credentialPatterns: readonly CredentialPattern[] = [
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN[A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END[A-Z0-9 ]{0,40}PRIVATE KEY-----|[\s\S]*$)/g,
  },
  {
    kind: 'authorization-header',
    pattern:
      /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?)(?!\[REDACTED:)[^\s"'][^\r\n"']*/gi,
    keep: 1,
  },
  {
    kind: 'basic-credentials',
    pattern:
      /\b(basic[ \t]+)(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{16,}={0,2}/gi,
    keep: 1,
  },
  {
    kind: 'bearer-token',
    pattern: /\b(bearer[ \t]+)(?!\[REDACTED:)[A-Za-z0-9._~+/-]{8,}=*/gi,
    keep: 1,
  },
  {
    kind: 'connection-string-password',
    pattern:
      /\b([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s:@/?#]+:)(?!\[REDACTED:)[^\s@/?#]+(?=@)/g,
    keep: 1,
  },
  {
    kind: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'stripe-key', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  },
  {
    // A value assigned to a name that ends in a secret-like word, such as
    // `GITHUB_TOKEN=...` or `"password": "..."`.
    kind: 'secret-assignment',
    pattern:
      /\b([A-Za-z0-9_.-]{0,40}(?:secret|password|passwd|pwd|token|api[_-]?key)["']?[ \t]{0,5}[:=][ \t]{0,5}["']?)(?!\[REDACTED:)[^\s"'&,;]{3,}/gi,
    keep: 1,
  },
];

// String values under a key that ends in one of these words are masked
// whatever they look like. `maxTokens` and `tokenCount` do not match.
const secretKey =
  /(?:secret|password|passwd|pwd|token|api[_-]?key|authorization|credentials?|private[_-]?key)$/i;

export interface SecretRedactor {
  // Returns a copy of the value with every string masked. Arrays, plain
  // objects, Maps, Sets, and errors are copied with their structure,
  // including shared references and cycles; other class instances become
  // plain objects of their own enumerable properties. Primitives other than
  // strings, dates, regular expressions, and binary buffers are returned
  // unchanged.
  redact(value: unknown): unknown;
  redactText(text: string): string;
}

// A redactor for the given secrets, typically every secret the run holds,
// built once at bootstrap. Empty strings are ignored.
export function createSecretRedactor(
  secrets: Iterable<string> = [],
): SecretRedactor {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    forms.add(secret);
    for (const form of encodedForms(secret)) forms.add(form);
  }
  const seeded = [...forms].sort((a, b) => b.length - a.length);
  const redactText = (text: string): string => {
    let result = text;
    for (const form of seeded) {
      result = result.split(form).join(marker('secret'));
    }
    for (const { kind, pattern, keep = 0 } of credentialPatterns) {
      result = result.replace(pattern, (...groups: unknown[]) => {
        let kept = '';
        for (let index = 1; index <= keep; index += 1) {
          kept += String(groups[index]);
        }
        return kept + marker(kind);
      });
    }
    return result;
  };
  return {
    redactText,
    redact: (value) => redactValue(value, redactText, new Map(), 0),
  };
}

// A redactor that knows only the credential patterns.
export const patternSecretRedactor: SecretRedactor = createSecretRedactor();

export function redactSecrets(
  value: unknown,
  secrets: Iterable<string> = [],
): unknown {
  return createSecretRedactor(secrets).redact(value);
}

// The base64 and base64url text that encodes the secret when it starts at
// each of the three byte offsets of a 3-byte group, without the edge
// characters that also carry neighboring bits.
function encodedForms(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  const forms: string[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor((padded.length * 8) / 6);
    for (const encoding of ['base64', 'base64url'] as const) {
      const inner = padded.toString(encoding).slice(start, end);
      if (inner.length >= minEncodedSecretLength) forms.push(inner);
    }
  }
  return forms;
}

type TextRedactor = (text: string) => string;

function redactValue(
  value: unknown,
  redactText: TextRedactor,
  copies: Map<object, unknown>,
  depth: number,
): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object' || value === null) return value;
  const existing = copies.get(value);
  if (existing !== undefined) return existing;
  if (depth >= maxRedactionDepth) return marker('too-deep');
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  if (value instanceof URL) return redactText(value.href);
  const next = (item: unknown): unknown =>
    redactValue(item, redactText, copies, depth + 1);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    for (const item of value) copy.push(next(item));
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    copies.set(value, copy);
    for (const [key, item] of value) {
      copy.set(next(key), redactMember(key, item, next));
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    copies.set(value, copy);
    for (const item of value) copy.add(next(item));
    return copy;
  }
  if (value instanceof Error)
    return redactError(value, copies, next, redactText);
  const copy: Record<string, unknown> = {};
  copies.set(value, copy);
  for (const key of Object.keys(value)) {
    copy[redactText(key)] = redactMember(key, readProperty(value, key), next);
  }
  return copy;
}

function redactMember(
  key: unknown,
  item: unknown,
  next: (item: unknown) => unknown,
): unknown {
  if (
    typeof key === 'string' &&
    typeof item === 'string' &&
    item.length > 0 &&
    secretKey.test(key)
  ) {
    return marker('secret-field');
  }
  return next(item);
}

// Copies an error with the same prototype, so instanceof and name still
// hold, and every own property, including the non-enumerable message, stack,
// and cause, redacted. The stack is kept because it repeats the message;
// normalizeError, not this function, drops stacks.
function redactError(
  error: Error,
  copies: Map<object, unknown>,
  next: (item: unknown) => unknown,
  redactText: TextRedactor,
): Error {
  const copy = Object.create(Object.getPrototypeOf(error) as object) as Error;
  copies.set(error, copy);
  for (const key of Object.getOwnPropertyNames(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    Object.defineProperty(copy, redactText(key), {
      value: redactMember(key, readProperty(error, key), next),
      enumerable: descriptor?.enumerable ?? false,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

// A getter that throws must not stop redaction of everything else.
function readProperty(owner: object, key: string): unknown {
  try {
    return (owner as Record<string, unknown>)[key];
  } catch {
    return marker('unreadable');
  }
}
