import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import {
  defaultIgnorePath,
  main,
  maxIgnoreDays,
  parseIgnores,
} from './TrivyIgnoreCheck.ts';

const checkFile = fileURLToPath(
  new URL('TrivyIgnoreCheck.ts', import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const now = new Date('2026-10-19T12:00:00Z');

const ignoreFile = (entries: readonly Record<string, unknown>[]) =>
  JSON.stringify({ vulnerabilities: entries });

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: 'CVE-2026-12345',
  statement: 'Fixed in openssl 3.5.5, which no node image carries yet.',
  expired_at: '2026-11-01',
  ...overrides,
});

describe('parseIgnores', () => {
  test('reads entries written as YAML', () => {
    expect(
      parseIgnores(
        'vulnerabilities:\n  - id: GHSA-238p-pmpm-9mq7\n    statement: Not shipped.\n    expired_at: 2026-11-18\n',
        now,
      ),
    ).toEqual([
      {
        id: 'GHSA-238p-pmpm-9mq7',
        statement: 'Not shipped.',
        expiredAt: '2026-11-18',
      },
    ]);
    expect(parseIgnores('vulnerabilities: []\n', now)).toEqual([]);
  });

  test('refuses a file that is not only a vulnerabilities list', () => {
    for (const text of [
      '',
      '[]',
      'vulnerabilities: {}',
      'vulnerabilities: []\nsecrets: []',
    ])
      expect(() => parseIgnores(text, now)).toThrow(
        'The ignore file needs only a vulnerabilities list',
      );
  });

  test('refuses an entry with missing, extra, or malformed fields', () => {
    const cases: [Record<string, unknown> | string, string][] = [
      ['CVE-2026-12345', 'needs exactly expired_at, id, statement'],
      [{ id: 'CVE-2026-12345' }, 'needs exactly'],
      [entry({ paths: ['usr/lib'] }), 'needs exactly'],
      [entry({ id: 'CVE-*' }), 'id is not a CVE or GHSA ID'],
      [entry({ id: 12345 }), 'id is not a CVE or GHSA ID'],
      [entry({ statement: ' ' }), 'statement must be a non-empty string'],
      [entry({ statement: 1 }), 'statement must be a non-empty string'],
      [
        entry({ expired_at: '2026-02-30' }),
        'expired_at is not a YYYY-MM-DD date',
      ],
      [
        entry({ expired_at: '2026-11-1' }),
        'expired_at is not a YYYY-MM-DD date',
      ],
      [entry({ expired_at: 20261101 }), 'expired_at is not a YYYY-MM-DD date'],
    ];
    for (const [value, message] of cases)
      expect(() =>
        parseIgnores(JSON.stringify({ vulnerabilities: [value] }), now),
      ).toThrow(`Ignore entry 1 ${message}`);
  });

  test(`refuses an expiry more than ${maxIgnoreDays} days away`, () => {
    expect(
      parseIgnores(ignoreFile([entry({ expired_at: '2026-11-18' })]), now),
    ).toHaveLength(1);
    expect(() =>
      parseIgnores(ignoreFile([entry({ expired_at: '2026-11-19' })]), now),
    ).toThrow(`Ignore entry 1 expired_at is more than ${maxIgnoreDays} days`);
  });
});

describe('main', () => {
  const io = (contents: Record<string, string>) => ({
    readFile: (file: string) => {
      if (!(file in contents)) throw new Error(`no such file ${file}`);
      return contents[file]!;
    },
    log: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    now: () => now,
  });

  test('passes the default file and warns about expired entries', () => {
    const output = io({
      [defaultIgnorePath]: ignoreFile([
        entry(),
        entry({ id: 'CVE-2026-1000', expired_at: '2026-10-19' }),
      ]),
    });
    expect(main([], output)).toBe(0);
    expect(output.log.mock.calls.map(([message]) => message)).toEqual([
      'Ignoring CVE-2026-12345 until 2026-11-01',
      `${defaultIgnorePath} passed with 2 entries.`,
    ]);
    expect(output.warn).toHaveBeenCalledWith(
      `CVE-2026-1000 expired on 2026-10-19; remove it from ${defaultIgnorePath}`,
    );
  });

  test('fails on a bad entry or an unreadable file', () => {
    const output = io({
      'far.yaml': ignoreFile([entry({ expired_at: '2099-01-01' })]),
    });
    expect(main(['far.yaml'], output)).toBe(1);
    expect(output.error.mock.calls.map(([message]) => message)).toEqual([
      `Ignore entry 1 expired_at is more than ${maxIgnoreDays} days from now`,
      'Fix far.yaml as CONTRIBUTING.md describes before the image scan uses it.',
    ]);
    expect(main(['missing.yaml'], output)).toBe(1);
    expect(output.error).toHaveBeenCalledWith('no such file missing.yaml');
    const thrower = {
      ...output,
      readFile: () => {
        throw 'unreadable';
      },
    };
    expect(main([], thrower)).toBe(1);
    expect(output.error).toHaveBeenCalledWith('unreadable');
  });

  test('passes the repository ignore file from the command line', () => {
    const run = spawnSync(process.execPath, [checkFile], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`${defaultIgnorePath} passed`);
  });
});
