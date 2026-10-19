import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  defaultTriagePath,
  main,
  maxTriageDays,
  parseAuditReport,
  parseTriage,
  triage,
  type Advisory,
  type TriageEntry,
} from './NpmAuditTriage.ts';

const triageFile = fileURLToPath(new URL('NpmAuditTriage.ts', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const now = new Date('2026-10-19T12:00:00Z');

const advisoryVia = (overrides: Record<string, unknown> = {}) => ({
  source: 1241206,
  name: 'katex',
  dependency: 'katex',
  title: 'KaTeX: prototype pollution',
  url: 'https://github.com/advisories/GHSA-238p-pmpm-9mq7',
  severity: 'low',
  range: '<0.18.2',
  ...overrides,
});

const report = (vulnerabilities: Record<string, unknown>) => ({
  auditReportVersion: 2,
  vulnerabilities,
  metadata: {},
});

const katexReport = report({
  katex: { name: 'katex', severity: 'low', via: [advisoryVia()] },
  'micromark-extension-math': {
    name: 'micromark-extension-math',
    severity: 'low',
    via: ['katex'],
  },
});

const entry = (overrides: Partial<TriageEntry> = {}): TriageEntry => ({
  id: 'GHSA-238p-pmpm-9mq7',
  packageName: 'katex',
  reason: 'Development only.',
  expires: '2027-01-19',
  ...overrides,
});

const triageJson = (overrides: Record<string, unknown> = {}) => ({
  advisories: [
    {
      id: 'GHSA-238p-pmpm-9mq7',
      package: 'katex',
      reason: 'Development only.',
      expires: '2027-01-19',
      ...overrides,
    },
  ],
});

describe('parseAuditReport', () => {
  test('reads each advisory once and skips package-name vias', () => {
    expect(parseAuditReport(katexReport)).toEqual<Advisory[]>([
      {
        id: 'GHSA-238p-pmpm-9mq7',
        packageName: 'katex',
        severity: 'low',
        title: 'KaTeX: prototype pollution',
      },
    ]);
  });

  test('keeps the same advisory for two packages apart', () => {
    const advisories = parseAuditReport(
      report({
        a: { via: [advisoryVia({ name: 'a' }), advisoryVia({ name: 'a' })] },
        b: { via: [advisoryVia({ name: 'b', title: 7 })] },
      }),
    );
    expect(
      advisories.map(({ packageName, title }) => [packageName, title]),
    ).toEqual([
      ['a', 'KaTeX: prototype pollution'],
      ['b', ''],
    ]);
  });

  test('uses the URL as the ID when it names no GHSA advisory', () => {
    const [advisory] = parseAuditReport(
      report({ a: { via: [advisoryVia({ url: 'https://npmjs.test/1' })] } }),
    );
    expect(advisory?.id).toBe('https://npmjs.test/1');
  });

  test('passes a clean report', () => {
    expect(parseAuditReport(report({}))).toEqual([]);
  });

  test('fails when npm could not audit', () => {
    expect(() =>
      parseAuditReport({ error: { code: 'ENOTFOUND', summary: 'offline' } }),
    ).toThrow('npm audit failed: {"code":"ENOTFOUND","summary":"offline"}');
    expect(() => parseAuditReport([])).toThrow('is not an object');
    expect(() => parseAuditReport({ auditReportVersion: 1 })).toThrow(
      'is not audit report version 2',
    );
    expect(() =>
      parseAuditReport({ auditReportVersion: 2, vulnerabilities: [] }),
    ).toThrow('is not audit report version 2');
  });

  test('fails on a malformed entry instead of skipping it', () => {
    expect(() => parseAuditReport(report({ a: { via: 'b' } }))).toThrow(
      'The npm audit entry for a has no via list',
    );
    expect(() => parseAuditReport(report({ a: null }))).toThrow(
      'has no via list',
    );
    expect(() => parseAuditReport(report({ a: { via: [7] } }))).toThrow(
      'has a malformed via',
    );
    expect(() =>
      parseAuditReport(report({ a: { via: [advisoryVia({ url: '' })] } })),
    ).toThrow('The advisory URL for a must be a non-empty string');
    expect(() =>
      parseAuditReport(report({ a: { via: [advisoryVia({ name: 1 })] } })),
    ).toThrow('The advisory package for a');
    expect(() =>
      parseAuditReport(
        report({ a: { via: [advisoryVia({ severity: undefined })] } }),
      ),
    ).toThrow('The advisory severity for a');
  });
});

describe('parseTriage', () => {
  test('reads entries', () => {
    expect(parseTriage(triageJson(), now)).toEqual([entry()]);
  });

  test('refuses malformed entries', () => {
    expect(() => parseTriage({}, now)).toThrow('needs an advisories list');
    expect(() => parseTriage({ advisories: [1] }, now)).toThrow(
      'Triage entry 1 is not an object',
    );
    expect(() => parseTriage(triageJson({ id: 'CVE-2026-1' }), now)).toThrow(
      'Triage entry 1 id is not a GHSA ID',
    );
    expect(() => parseTriage(triageJson({ package: '' }), now)).toThrow(
      'Triage entry 1 package must be a non-empty string',
    );
    expect(() => parseTriage(triageJson({ reason: ' ' }), now)).toThrow(
      'Triage entry 1 reason',
    );
  });

  test('refuses an expiry that is not a real date', () => {
    for (const expires of ['2027-02-30', '2027-1-19', '19/01/2027', 'never'])
      expect(() => parseTriage(triageJson({ expires }), now)).toThrow(
        'is not a YYYY-MM-DD date',
      );
  });

  test(`refuses an expiry more than ${maxTriageDays} days away`, () => {
    expect(() =>
      parseTriage(triageJson({ expires: '2027-04-18' }), now),
    ).toThrow(`expires more than ${maxTriageDays} days from now`);
    expect(
      parseTriage(triageJson({ expires: '2027-04-17' }), now),
    ).toHaveLength(1);
  });
});

describe('triage', () => {
  const [katex] = parseAuditReport(katexReport) as [Advisory];

  test('accepts a triaged advisory', () => {
    expect(triage([katex], [entry()], now)).toEqual({
      errors: [],
      accepted: [
        'Accepted until 2027-01-19: GHSA-238p-pmpm-9mq7 (low) in katex: KaTeX: prototype pollution',
      ],
      unused: [],
    });
  });

  test('fails an untriaged advisory and one triaged for another package', () => {
    expect(triage([katex], [], now).errors).toEqual([
      'Untriaged advisory GHSA-238p-pmpm-9mq7 (low) in katex: KaTeX: prototype pollution',
    ]);
    const result = triage([katex], [entry({ packageName: 'other' })], now);
    expect(result.errors).toHaveLength(1);
    expect(result.unused).toEqual([
      'GHSA-238p-pmpm-9mq7 in other is no longer reported; remove its triage entry',
    ]);
  });

  test('fails from the start of the expiry date', () => {
    expect(
      triage([katex], [entry({ expires: '2026-10-20' })], now).errors,
    ).toEqual([]);
    expect(
      triage([katex], [entry({ expires: '2026-10-19' })], now).errors,
    ).toEqual([
      'Triage expired on 2026-10-19 for GHSA-238p-pmpm-9mq7 (low) in katex: KaTeX: prototype pollution',
    ]);
  });
});

describe('main', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  const files = (contents: Record<string, unknown>) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'npm-audit-triage-'));
    directories.push(directory);
    for (const [name, value] of Object.entries(contents))
      writeFileSync(path.join(directory, name), JSON.stringify(value));
    return directory;
  };

  test('reads files and writes to the console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = files({
      'audit.json': katexReport,
      'triage.json': {
        advisories: [
          ...triageJson().advisories,
          ...triageJson({ package: 'other' }).advisories,
        ],
      },
      'empty.json': { advisories: [] },
    });
    const audit = path.join(directory, 'audit.json');
    expect(main([audit, path.join(directory, 'triage.json')])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      '::warning::GHSA-238p-pmpm-9mq7 in other is no longer reported; remove its triage entry',
    );
    expect(main([audit, path.join(directory, 'empty.json')])).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Untriaged advisory GHSA-238p-pmpm-9mq7'),
    );
  });

  const io = (contents: Record<string, unknown>) => ({
    readFile: (file: string) => {
      if (!(file in contents)) throw new Error(`no such file ${file}`);
      return JSON.stringify(contents[file]);
    },
    log: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    now: () => now,
  });

  test('passes and reads the default triage file', () => {
    const output = io({
      'audit.json': katexReport,
      [defaultTriagePath]: triageJson(),
    });
    expect(main(['audit.json'], output)).toBe(0);
    expect(output.log).toHaveBeenLastCalledWith(
      'npm audit passed: 1 triaged advisories, none untriaged.',
    );
    expect(output.error).not.toHaveBeenCalled();
  });

  test('warns about unused entries without failing', () => {
    const output = io({ 'audit.json': report({}), 't.json': triageJson() });
    expect(main(['audit.json', 't.json'], output)).toBe(0);
    expect(output.warn).toHaveBeenCalledWith(
      'GHSA-238p-pmpm-9mq7 in katex is no longer reported; remove its triage entry',
    );
  });

  test('fails with each untriaged advisory and the way to fix it', () => {
    const output = io({
      'audit.json': katexReport,
      't.json': { advisories: [] },
    });
    expect(main(['audit.json', 't.json'], output)).toBe(1);
    expect(output.error.mock.calls.map(([message]) => message)).toEqual([
      'Untriaged advisory GHSA-238p-pmpm-9mq7 (low) in katex: KaTeX: prototype pollution',
      'Fix each advisory or add a triage entry to t.json, as CONTRIBUTING.md describes.',
    ]);
  });

  test('fails without an audit report path or on unreadable input', () => {
    const output = io({});
    expect(main([], output)).toBe(1);
    expect(output.error).toHaveBeenCalledWith(
      'Usage: NpmAuditTriage.ts <audit.json> [triage.json]',
    );
    expect(main(['missing.json'], output)).toBe(1);
    expect(output.error).toHaveBeenLastCalledWith('no such file missing.json');
    const thrower = {
      ...output,
      readFile: () => {
        throw 'unreadable';
      },
    };
    expect(main(['a'], thrower)).toBe(1);
    expect(output.error).toHaveBeenLastCalledWith('unreadable');
  });

  test('accepts the repository triage file and fails on untriaged advisories from the command line', () => {
    const directory = files({
      'clean.json': report({}),
      'katex.json': katexReport,
      'empty.json': { advisories: [] },
    });
    const clean = spawnSync(
      process.execPath,
      [triageFile, path.join(directory, 'clean.json')],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('npm audit passed');
    const failing = spawnSync(
      process.execPath,
      [
        triageFile,
        path.join(directory, 'katex.json'),
        path.join(directory, 'empty.json'),
      ],
      { encoding: 'utf8' },
    );
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('Untriaged advisory GHSA-238p-pmpm-9mq7');
  });
});
