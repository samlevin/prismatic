import { describe, expect, it } from 'vitest';
import {
  credentialExamples,
  privateKeyBlock,
  randomText,
} from '../../tests/support/credentials.ts';
import {
  maxNormalizedCauseDepth,
  maxNormalizedMessageLength,
  normalizeError as normalizeWith,
} from './errors.ts';
import {
  createSecretRedactor,
  patternSecretRedactor,
  type SecretRedactor,
} from './redaction.ts';
import { ValidationError } from './validation.ts';

const token = credentialExamples['github-token'] ?? '';

const normalizeError = (
  error: unknown,
  redactor: SecretRedactor = patternSecretRedactor,
) => normalizeWith(error, redactor);

describe('normalizeError', () => {
  it('keeps the name, code, and message of an operational error', () => {
    expect(
      normalizeError(new ValidationError('invalid-path', 'Bad path.')),
    ).toEqual({
      name: 'ValidationError',
      code: 'invalid-path',
      message: 'Bad path.',
    });
  });

  it('keeps Node.js system error codes and numeric codes', () => {
    const system = Object.assign(new Error('ENOENT: no such file'), {
      code: 'ENOENT',
    });
    expect(normalizeError(system).code).toBe('ENOENT');
    const http = Object.assign(new Error('Not Found'), { code: 404 });
    expect(normalizeError(http).code).toBe('404');
  });

  it('never includes a stack trace', () => {
    const error = new Error('boom');
    const normalized = normalizeError(error);
    expect(normalized).toEqual({
      name: 'Error',
      code: 'unknown',
      message: 'boom',
    });
    expect(JSON.stringify(normalized)).not.toContain('    at ');
    expect(Object.keys(normalized)).not.toContain('stack');
  });

  it('drops stack frame lines that a message carries', () => {
    const error = new Error(
      'request failed\n    at fetch (/app/src/github/x.ts:1:1)\n    at main',
    );
    expect(normalizeError(error).message).toBe('request failed');
  });

  it('masks secrets in the message and the cause', () => {
    const error = new Error(`token ${token} rejected`, {
      cause: new Error(`retry with ${token}`),
    });
    const normalized = normalizeError(error);
    expect(normalized.message).toBe('token [REDACTED:github-token] rejected');
    expect(normalized.cause?.message).toBe(
      'retry with [REDACTED:github-token]',
    );
    expect(JSON.stringify(normalized)).not.toContain(token);
  });

  it('masks a whole private key block before joining lines', () => {
    const normalized = normalizeError(
      new Error(`bad key\n${privateKeyBlock()}`),
    );
    expect(normalized.message).toBe('bad key [REDACTED:private-key]');
  });

  it.each([
    ['password:\n', 'password: [REDACTED:secret-assignment]'],
    [
      'Authorization:\n token ',
      'Authorization:  [REDACTED:authorization-header]',
    ],
    ['sent Bearer\n', 'sent Bearer [REDACTED:bearer-token]'],
  ])('masks a credential split across lines after %j', (prefix, expected) => {
    const value = randomText(24, 43);
    expect(normalizeError(new Error(`${prefix}${value}`)).message).toBe(
      expected,
    );
  });

  it('masks the secrets a seeded redactor knows', () => {
    const secret = randomText(24, 41);
    const redactor = createSecretRedactor([secret]);
    expect(normalizeError(new Error(`value ${secret}`), redactor).message).toBe(
      'value [REDACTED:secret]',
    );
  });

  it('masks a seeded secret that spans lines', () => {
    const secret = `${randomText(12, 44)}\n${randomText(12, 45)}`;
    const redactor = createSecretRedactor([secret]);
    expect(normalizeError(new Error(`key ${secret}`), redactor).message).toBe(
      'key [REDACTED:secret]',
    );
  });

  it('refuses a code that carries a secret or is not an identifier', () => {
    const leaky = Object.assign(new Error('x'), { code: token });
    expect(normalizeError(leaky).code).toBe('unknown');
    const odd = Object.assign(new Error('x'), { code: 'has space' });
    expect(normalizeError(odd).code).toBe('unknown');
    const fractional = Object.assign(new Error('x'), { code: 1.5 });
    expect(normalizeError(fractional).code).toBe('unknown');
  });

  it('replaces a name that is not an identifier', () => {
    const error = new Error('x');
    error.name = `Bad\u001B[31m ${token}`;
    expect(normalizeError(error).name).toBe('Error');
  });

  it('replaces a name that is a credential or a seeded secret', () => {
    const tokenName = new Error('x');
    tokenName.name = token;
    expect(normalizeError(tokenName).name).toBe('Error');
    const secret = `S${randomText(31, 42)}`;
    const secretName = new Error('x');
    secretName.name = secret;
    expect(normalizeError(secretName).name).toBe(secret);
    expect(
      normalizeError(secretName, createSecretRedactor([secret])).name,
    ).toBe('Error');
  });

  it('strips terminal escapes and keeps the message on one line', () => {
    const error = new Error('\u001B[31mred\u001B[0m\r\nsecond\u0007 line');
    expect(normalizeError(error).message).toBe('red second  line');
  });

  it('truncates a long message', () => {
    const message = normalizeError(new Error('a'.repeat(5000))).message;
    expect(message).toHaveLength(maxNormalizedMessageLength);
    expect(message.endsWith('...')).toBe(true);
  });

  it('limits the depth of causes, including a cycle', () => {
    const error = new Error('loop');
    error.cause = error;
    let normalized = normalizeError(error);
    let levels = 1;
    while (normalized.cause !== undefined) {
      normalized = normalized.cause;
      levels += 1;
    }
    expect(levels).toBe(maxNormalizedCauseDepth);
  });

  it('describes a thrown string without its secrets', () => {
    expect(normalizeError(`failed: ${token}`)).toEqual({
      name: 'NonError',
      code: 'unknown',
      message: 'failed: [REDACTED:github-token]',
    });
  });

  it.each([
    [null, 'A non-error null value was thrown.'],
    [undefined, 'A non-error undefined value was thrown.'],
    [42, 'A non-error number value was thrown.'],
    [{ password: 'x', token }, 'A non-error object value was thrown.'],
  ])('describes the thrown value %j by type only', (value, message) => {
    expect(normalizeError(value)).toEqual({
      name: 'NonError',
      code: 'unknown',
      message,
    });
  });

  it('normalizes a non-error cause', () => {
    const error = new Error('outer', { cause: { secret: token } });
    expect(normalizeError(error).cause).toEqual({
      name: 'NonError',
      code: 'unknown',
      message: 'A non-error object value was thrown.',
    });
  });

  it('never throws, even when the error throws on access', () => {
    const hostile = new Error('x');
    for (const key of ['name', 'message', 'code', 'cause']) {
      Object.defineProperty(hostile, key, {
        get() {
          throw new Error('trap');
        },
      });
    }
    expect(normalizeError(hostile)).toEqual({
      name: 'Error',
      code: 'unknown',
      message: '',
    });
  });
});
