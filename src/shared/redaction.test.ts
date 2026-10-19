import { describe, expect, it } from 'vitest';
import {
  credentialExamples,
  privateKeyBlock,
  randomText,
} from '../../tests/support/credentials.ts';
import {
  createSecretRedactor,
  maxRedactionDepth,
  patternSecretRedactor,
  redactSecrets,
} from './redaction.ts';

const redactText = (text: string): string =>
  patternSecretRedactor.redactText(text);

const seededSecret = ['ghs', randomText(36, 21)].join('_');

describe('credential patterns', () => {
  it.each(Object.entries(credentialExamples))(
    'masks a %s inside surrounding text',
    (_kind, credential) => {
      const masked = redactText(`before ${credential} after`);
      expect(masked).not.toContain(credential);
      expect(masked).toMatch(/^before \[REDACTED:[a-z-]+\] after$/);
    },
  );

  it('names the kind in the marker', () => {
    expect(redactText(credentialExamples['github-token'] ?? '')).toBe(
      '[REDACTED:github-token]',
    );
    expect(redactText(credentialExamples['aws-access-key-id'] ?? '')).toBe(
      '[REDACTED:aws-access-key-id]',
    );
  });

  it('masks a whole private key block, and an unterminated one to the end', () => {
    const block = privateKeyBlock();
    expect(redactText(`key:\n${block}\nafter`)).toBe(
      'key:\n[REDACTED:private-key]\nafter',
    );
    const unterminated = block.slice(0, block.lastIndexOf('-----END'));
    expect(redactText(`key:\n${unterminated}`)).toBe(
      'key:\n[REDACTED:private-key]',
    );
  });

  it('masks the password in a connection string and keeps the rest', () => {
    const password = randomText(16, 22);
    expect(redactText(`postgres://app:${password}@db.internal:5432/main`)).toBe(
      'postgres://app:[REDACTED:connection-string-password]@db.internal:5432/main',
    );
    expect(
      redactText(`https://x-access-token:${password}@github.com/o/r.git`),
    ).toBe(
      'https://x-access-token:[REDACTED:connection-string-password]@github.com/o/r.git',
    );
    expect(redactText(`redis://:${password}@cache:6379/0`)).toBe(
      'redis://:[REDACTED:connection-string-password]@cache:6379/0',
    );
  });

  it('leaves a URL with a port and no credentials alone', () => {
    const url = 'https://host:8080/path@v2';
    expect(redactText(url)).toBe(url);
  });

  it('masks authorization headers and bearer and basic credentials', () => {
    const value = randomText(32, 23);
    expect(redactText(`Authorization: token ${value}`)).toBe(
      'Authorization: [REDACTED:authorization-header]',
    );
    expect(redactText(`{"authorization":"Bearer ${value}"}`)).toBe(
      '{"authorization":"[REDACTED:authorization-header]"}',
    );
    expect(redactText(`sent Bearer ${value} upstream`)).toBe(
      'sent Bearer [REDACTED:bearer-token] upstream',
    );
    const basic = Buffer.from(`user:${value}`).toString('base64');
    expect(redactText(`header basic ${basic} sent`)).toBe(
      'header basic [REDACTED:basic-credentials] sent',
    );
  });

  it('masks values assigned to secret-like names', () => {
    const value = randomText(20, 24);
    expect(redactText(`DB_PASSWORD=${value} next`)).toBe(
      'DB_PASSWORD=[REDACTED:secret-assignment] next',
    );
    expect(redactText(`{"client_secret": "${value}"}`)).toBe(
      '{"client_secret": "[REDACTED:secret-assignment]"}',
    );
    expect(redactText(`api-key: ${value}`)).toBe(
      'api-key: [REDACTED:secret-assignment]',
    );
  });

  it.each([
    'maxTokens=4096',
    'tokenCount: 12',
    'Unexpected token } in JSON',
    'basic authentication failed',
    'the bearer of bad news',
    'https://github.com/o/r.git',
    'ghp_short',
    'sk-short',
    'see task-assessment-for-the-quarter-report',
    'commit 0123456789abcdef0123456789abcdef01234567',
  ])('leaves ordinary text alone: %j', (text) => {
    expect(redactText(text)).toBe(text);
  });

  it('gives the same result when applied twice', () => {
    const text = [
      ...Object.values(credentialExamples),
      `GITHUB_TOKEN=${credentialExamples['github-token'] ?? ''}`,
      `postgres://u:${randomText(12, 25)}@h/db`,
      `Authorization: Bearer ${randomText(30, 26)}`,
      `password=${randomText(12, 27)}`,
    ].join('\n');
    const once = redactText(text);
    expect(redactText(once)).toBe(once);
  });
});

describe('seeded secrets', () => {
  const redactor = createSecretRedactor([seededSecret, '']);

  it('masks the raw secret', () => {
    expect(redactor.redactText(`value=${seededSecret};`)).toBe(
      'value=[REDACTED:secret];',
    );
  });

  it('masks a secret that matches no pattern', () => {
    const opaque = randomText(24, 28);
    expect(createSecretRedactor([opaque]).redactText(`x ${opaque} y`)).toBe(
      'x [REDACTED:secret] y',
    );
  });

  it.each([0, 1, 2, 15])(
    'masks the secret base64-encoded after %i preceding bytes',
    (offset) => {
      const prefix = 'p'.repeat(offset);
      for (const encoding of ['base64', 'base64url'] as const) {
        const encoded = Buffer.from(`${prefix}${seededSecret}tail`).toString(
          encoding,
        );
        const masked = redactor.redactText(encoded);
        expect(masked).toContain('[REDACTED:secret]');
        // At most a few edge characters of the encoding remain on each side.
        expect(masked.replace('[REDACTED:secret]', '').length).toBeLessThan(
          Math.ceil(((offset + 4) * 8) / 6) + 4,
        );
      }
    },
  );

  it('masks the token inside the basic header Git sends', () => {
    const header = Buffer.from(`x-access-token:${seededSecret}`).toString(
      'base64',
    );
    // No header name in front, so only the seeded secret can match.
    const masked = redactor.redactText(`credential ${header}`);
    expect(masked).toContain('[REDACTED:secret]');
    expect(masked).not.toContain(header);
    expect(masked).not.toContain(
      Buffer.from(seededSecret).toString('base64').slice(0, 20),
    );
  });

  it('masks longer secrets before shorter ones that they contain', () => {
    const short = randomText(10, 29);
    const long = `${short}${randomText(10, 30)}`;
    expect(createSecretRedactor([short, long]).redactText(long)).toBe(
      '[REDACTED:secret]',
    );
  });

  it('redactSecrets accepts the secrets directly', () => {
    expect(
      redactSecrets({ note: `id ${seededSecret}` }, [seededSecret]),
    ).toEqual({ note: 'id [REDACTED:secret]' });
  });
});

describe('nested values', () => {
  const token = credentialExamples['github-token'] ?? '';

  it('masks strings in nested objects, arrays, Maps, and Sets', () => {
    const value = {
      level: { list: [`a ${token}`, 1, true, null, undefined] },
      map: new Map<unknown, unknown>([
        ['k', token],
        [token, 'v'],
      ]),
      set: new Set([token]),
    };
    const masked = redactSecrets(value) as typeof value;
    expect(masked.level.list).toEqual([
      'a [REDACTED:github-token]',
      1,
      true,
      null,
      undefined,
    ]);
    expect([...masked.map]).toEqual([
      ['k', '[REDACTED:github-token]'],
      ['[REDACTED:github-token]', 'v'],
    ]);
    expect([...masked.set]).toEqual(['[REDACTED:github-token]']);
    expect(JSON.stringify(masked)).not.toContain(token);
  });

  it('does not change the input', () => {
    const value = { note: token, list: [token] };
    redactSecrets(value);
    expect(value).toEqual({ note: token, list: [token] });
  });

  it('masks every string under a secret-like key', () => {
    expect(
      redactSecrets({
        password: 'hunter2',
        apiKey: 'plain',
        GITHUB_TOKEN: 'x',
        privateKey: 'k',
        maxTokens: 'kept',
        tokenCount: 3,
        token: '',
        nested: { clientSecret: 'abc' },
      }),
    ).toEqual({
      password: '[REDACTED:secret-field]',
      apiKey: '[REDACTED:secret-field]',
      GITHUB_TOKEN: '[REDACTED:secret-field]',
      privateKey: '[REDACTED:secret-field]',
      maxTokens: 'kept',
      tokenCount: 3,
      token: '',
      nested: { clientSecret: '[REDACTED:secret-field]' },
    });
  });

  it('masks a secret used as an object key', () => {
    expect(redactSecrets({ [token]: 1 })).toEqual({
      '[REDACTED:github-token]': 1,
    });
  });

  it('keeps cycles and shared references', () => {
    const shared = { note: token };
    const cyclic: Record<string, unknown> = { left: shared, right: shared };
    cyclic['self'] = cyclic;
    const masked = redactSecrets(cyclic) as Record<string, unknown>;
    expect(masked['self']).toBe(masked);
    expect(masked['left']).toBe(masked['right']);
    expect(masked['left']).toEqual({ note: '[REDACTED:github-token]' });
  });

  it('turns class instances into plain objects and URLs into text', () => {
    class Request {
      readonly url = new URL(`https://user:${randomText(12, 31)}@e.test/p`);
      readonly header = `Bearer ${randomText(20, 32)}`;
    }
    expect(redactSecrets(new Request())).toEqual({
      url: 'https://user:[REDACTED:connection-string-password]@e.test/p',
      header: 'Bearer [REDACTED:bearer-token]',
    });
  });

  it('returns dates, regular expressions, and buffers unchanged', () => {
    const date = new Date(0);
    const pattern = /x/;
    const bytes = new Uint8Array([1]);
    const buffer = new ArrayBuffer(1);
    expect(redactSecrets([date, pattern, bytes, buffer])).toEqual([
      date,
      pattern,
      bytes,
      buffer,
    ]);
    expect((redactSecrets([bytes]) as unknown[])[0]).toBe(bytes);
  });

  it('returns other primitives and functions unchanged', () => {
    const fn = (): number => 1;
    const symbol = Symbol('s');
    expect(redactSecrets(5)).toBe(5);
    expect(redactSecrets(5n)).toBe(5n);
    expect(redactSecrets(fn)).toBe(fn);
    expect(redactSecrets(symbol)).toBe(symbol);
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  it('stops at the depth limit', () => {
    let value: unknown = 'leaf';
    for (let depth = 0; depth < maxRedactionDepth + 5; depth += 1) {
      value = [value];
    }
    let masked = redactSecrets(value);
    let depth = 0;
    while (Array.isArray(masked)) {
      masked = masked[0] as unknown;
      depth += 1;
    }
    expect(depth).toBe(maxRedactionDepth);
    expect(masked).toBe('[REDACTED:too-deep]');
  });

  it('survives a getter that throws', () => {
    const value = {};
    Object.defineProperty(value, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter');
      },
    });
    expect(redactSecrets(value)).toEqual({ boom: '[REDACTED:unreadable]' });
  });
});

describe('errors', () => {
  const token = credentialExamples['openai-key'] ?? '';

  it('masks the message, stack, cause, and own properties of an error', () => {
    class RequestError extends Error {
      readonly code = 'E_REQUEST';
      readonly response = { headers: { authorization: `Bearer ${token}` } };
    }
    const error = new RequestError(`failed with ${token}`, {
      cause: new Error(`inner ${token}`),
    });
    const masked = redactSecrets(error) as RequestError;
    expect(masked).toBeInstanceOf(RequestError);
    expect(masked).not.toBe(error);
    expect(masked.message).toBe('failed with [REDACTED:openai-key]');
    expect(masked.stack).toContain('[REDACTED:openai-key]');
    expect(masked.stack).not.toContain(token);
    expect((masked.cause as Error).message).toBe('inner [REDACTED:openai-key]');
    expect(masked.code).toBe('E_REQUEST');
    expect(masked.response.headers.authorization).toBe(
      '[REDACTED:secret-field]',
    );
    expect(Object.keys(masked)).toEqual(['code', 'response']);
    expect(error.message).toContain(token);
  });

  it('masks errors nested in objects and the errors of an AggregateError', () => {
    const aggregate = new AggregateError([new Error(token)], 'many');
    const masked = redactSecrets({ failure: aggregate }) as {
      failure: AggregateError;
    };
    expect(masked.failure).toBeInstanceOf(AggregateError);
    expect((masked.failure.errors[0] as Error).message).toBe(
      '[REDACTED:openai-key]',
    );
  });

  it('keeps an error that is its own cause', () => {
    const error = new Error('loop');
    error.cause = error;
    const masked = redactSecrets(error) as Error;
    expect(masked.cause).toBe(masked);
  });
});
