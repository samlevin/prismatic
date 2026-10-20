// Adversarial inputs for the shared primitives: names a malicious repository
// can commit, text a PR can carry into logs and comments, and errors that
// hold credentials. The fixture corpus in #139 will supply these from
// generated repositories; until then the cases are listed here.
import { describe, expect, it } from 'vitest';
import { normalizeError } from '../../src/shared/errors.ts';
import { escapeMarkdown } from '../../src/shared/markdown.ts';
import {
  assertNoNormalizationCollisions,
  normalizeRepoPath,
} from '../../src/shared/path.ts';
import {
  createSecretRedactor,
  redactSecrets,
} from '../../src/shared/redaction.ts';
import { boundedUtf8, stripAnsi } from '../../src/shared/text.ts';
import { credentialExamples, randomText } from '../support/credentials.ts';

const char = (codePoint: number): string => String.fromCodePoint(codePoint);

describe('hostile repository paths', () => {
  it.each([
    '../../../../etc/passwd',
    'src/../../outside.ts',
    '/proc/self/environ',
    '.git/config',
    '.git/hooks/post-checkout',
    'sub/.GIT/config',
    'GIT~1/config',
    '.git\u0000/config',
    'src/a.ts\u0000../../etc/passwd',
    '..\\..\\windows\\system32',
    'src\\..\\..\\secret.ts',
    'C:\\secret.ts',
    'src/\nINJECTED log line.ts',
    `src/innocent${char(0x202e)}st.ts`,
    `src/a${char(0x2067)}b.ts`,
    'src/./a.ts',
    'src//a.ts',
    '',
  ])('refuses %j', (path) => {
    expect(() => normalizeRepoPath(path)).toThrow();
  });

  it('refuses a tree whose names collide under Unicode normalization', () => {
    // An attacker commits a second copy of a reviewed directory whose name
    // differs only in normalization; on macOS both land in one directory.
    const reviewed = `src/caf${char(0xe9)}/handler.ts`;
    const shadow = `src/cafe${char(0x301)}/handler.ts`;
    expect(normalizeRepoPath(shadow)).toBe(shadow);
    expect(() => assertNoNormalizationCollisions([reviewed, shadow])).toThrow();
  });

  it('accepts shell metacharacters, which are data, not commands', () => {
    const path = 'src/$(rm -rf ~); `id` | tee >out & echo.ts';
    expect(normalizeRepoPath(path)).toBe(path);
  });
});

describe('hostile text', () => {
  it('removes escape sequences that would rewrite a log or terminal', () => {
    const injected = [
      'ok',
      '\u001B[1A\u001B[2K', // move up and erase the previous line
      '\u001B]0;pwned\u0007', // retitle the terminal
      '\u001B]8;;https://evil.test\u001B\\click\u001B]8;;\u001B\\', // hyperlink
      '\u001BP+q\u001B\\', // DCS query
      `${char(0x9b)}6n`, // 8-bit device status report
    ].join('');
    const cleaned = stripAnsi(injected);
    expect(cleaned).toBe('okclick');
    // eslint-disable-next-line no-control-regex -- control characters are the point
    expect(cleaned).not.toMatch(/[\u001B\u0080-\u009F]/);
  });

  it('refuses binary and control-heavy content before it is read as text', () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);
    expect(() => boundedUtf8(binary, 100)).toThrow();
    const terminalBomb = new TextEncoder().encode('\u001B[2J'.repeat(50));
    expect(() => boundedUtf8(terminalBomb, 1000)).toThrow();
  });

  // Each input takes minutes against a backtracking pattern and milliseconds
  // against a linear one, so the budget leaves wide room for a slow machine.
  it.each([
    ['unterminated 8-bit string introducers', char(0x9d).repeat(200_000)],
    [
      'an OSC followed by unterminated introducers',
      `\u001B]${char(0x9d).repeat(200_000)}`,
    ],
    ['a base64url run full of JWT prefixes', 'eyJ-'.repeat(100_000)],
  ])('cleans %s in linear time', (_label, input) => {
    const redactor = createSecretRedactor([]);
    const started = performance.now();
    stripAnsi(input);
    escapeMarkdown(input);
    redactSecrets(input);
    normalizeError(new Error(input), redactor);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('renders hostile metadata as inert Markdown', () => {
    const branch =
      'fix</summary><img src=x onerror=alert(1)> [click](javascript:alert(1)) @admins\n# Approved';
    const rendered = escapeMarkdown(branch);
    expect(rendered).not.toMatch(/[<>\n]/);
    expect(rendered).not.toContain('](');
    expect(rendered).not.toMatch(/@(?!&#8203;)/);
    expect(rendered).toContain('\\#&#8203; Approved');
  });
});

describe('credentials in output', () => {
  it('masks a token at any depth of a thrown error', () => {
    const token = credentialExamples['github-token'] ?? '';
    const error = Object.assign(new Error('request failed'), {
      request: {
        url: `https://x-access-token:${token}@github.com/o/r.git`,
        headers: { Authorization: `token ${token}` },
        body: [{ note: `pasted ${token}` }],
      },
    });
    const masked = redactSecrets(error);
    const own = Object.getOwnPropertyNames(masked).map((key) =>
      JSON.stringify((masked as unknown as Record<string, unknown>)[key]),
    );
    expect(own.join('\n')).not.toContain(token);
  });

  it('keeps the run token out of a normalized Git failure', () => {
    const token = randomText(40, 51);
    const header = Buffer.from(`x-access-token:${token}`).toString('base64');
    const redactor = createSecretRedactor([token]);
    const failure = new Error(
      `git fetch failed: -c http.extraheader=AUTHORIZATION: basic ${header}\nfatal: could not read ${token}\n    at spawn (node:child_process)`,
    );
    const normalized = normalizeError(failure, redactor);
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(header);
    expect(serialized).not.toContain('child_process');
  });
});
