// Adversarial inputs for the supply-chain audits (#201): source written to
// slip a process start or code loading past ProcessPatternAudit, and audit
// reports, triage files, and lockfiles built to pass a gate they should
// fail. The shell-metacharacter file names are the `shell-metacharacters`
// scenario of the fixture corpus in #139; until that corpus lands they are
// listed here.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  auditLicenses,
  parseLockfile,
  satisfies,
} from '../../tooling/security/LicenseAudit.ts';
import {
  main as triageMain,
  parseAuditReport,
  parseTriage,
  triage,
} from '../../tooling/security/NpmAuditTriage.ts';
import {
  auditSource,
  main as processAuditMain,
} from '../../tooling/security/ProcessPatternAudit.ts';

const now = new Date('2026-10-19T12:00:00Z');

describe('ProcessPatternAudit evasion attempts', () => {
  const flagged = (source: string, file = 'src/core/a.ts') =>
    auditSource(file, source).map((finding) => finding.rule);

  test.each([
    ["await import('node:' + 'child_process');", 'dynamic-import'],
    ["process.getBuiltinModule('node:child_process');", 'process-loader'],
    ["Reflect.get(process, 'x')('child_process');", 'process-import'],
    ["const name = 'node:child_process';", 'process-import'],
    ["const name = 'child\\u005fprocess';", 'process-import'],
    ['ev\\u0061l(code);', 'dynamic-code'],
    ['globalThis[name](code);', 'dynamic-code'],
    ["global['Fun' + 'ction'](code);", 'dynamic-code'],
    ['process[loader]();', 'process-loader'],
    ['const { getBuiltinModule: load } = process;', 'process-loader'],
    ["module.require('child_process');", 'commonjs-require'],
    ["import { createRequire } from 'node:module';", 'code-loading-import'],
    ["import { Worker } from 'node:worker_threads';", 'code-loading-import'],
    ["import { runInNewContext } from 'vm';", 'code-loading-import'],
    ["import x from 'https://cdn.example.test/x.mjs';", 'remote-import'],
    ["export * from 'file:///tmp/x.mjs';", 'remote-import'],
    ['spawn(file, args, { shell: !0 });', 'shell-option'],
    ["spawn(file, args, { shell: 'false' });", 'shell-option'],
    ['spawn(file, args, { ...options, shell: undefined });', 'shell-option'],
    ['(async () => {}).constructor(code)();', 'dynamic-code'],
    ["new (function* () {})['constructor'](code);", 'dynamic-code'],
    ['const F = (() => {}).constructor;\nF(code)();', 'dynamic-code'],
    ['const { constructor: F } = () => {};', 'dynamic-code'],
    ["Reflect.get(Reflect.getPrototypeOf(f), 'constructor');", 'dynamic-code'],
    ["Reflect.get(globalThis, 'Fun\\u0063tion')(code);", 'dynamic-code'],
  ])('flags %s', (source, rule) => {
    expect(flagged(source)).toContain(rule);
  });

  test('flags a non-spawn import in a file allowed to spawn', () => {
    expect(
      flagged(
        "import { spawn, execSync as run } from 'node:child_process';",
        'src/repository/ReadOnlyProcessRunner.ts',
      ),
    ).toEqual(['process-import']);
  });

  test('does not flag text in comments or ordinary strings', () => {
    expect(
      flagged(
        "// eval(code); require('child_process')\nconst message = 'do not eval this';",
      ),
    ).toEqual([]);
  });

  test('reads files with shell metacharacters in their names as data', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-audit-names-'));
    try {
      const names = [
        'src/$(touch prism-canary-subshell).ts',
        'src/`touch prism-canary-backtick`.ts',
        'src/a; touch prism-canary-semicolon.ts',
      ];
      mkdirSync(path.join(root, 'src'));
      for (const name of names)
        writeFileSync(path.join(root, name), 'eval(x);');
      const error = vi.fn<(message: string) => void>();
      expect(processAuditMain({ root, log: vi.fn(), error })).toBe(1);
      expect(error).toHaveBeenCalledTimes(names.length + 1);
      for (const name of names)
        expect(error).toHaveBeenCalledWith(
          `${name}:1:1 dynamic-code: refers to eval`,
        );
      for (const canary of ['subshell', 'backtick', 'semicolon'])
        for (const directory of [root, path.join(root, 'src'), process.cwd()])
          expect(
            existsSync(path.join(directory, `prism-canary-${canary}`)),
          ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('npm audit triage against forged inputs', () => {
  const via = {
    name: '__proto__',
    title: 'Forged',
    url: 'https://github.com/advisories/GHSA-238p-pmpm-9mq7',
    severity: 'critical',
  };

  test('a package named __proto__ is still an untriaged advisory', () => {
    const advisories = parseAuditReport(
      JSON.parse(
        `{"auditReportVersion":2,"vulnerabilities":{"__proto__":{"via":[${JSON.stringify(via)}]}}}`,
      ),
    );
    expect(advisories.map((advisory) => advisory.packageName)).toEqual([
      '__proto__',
    ]);
    expect(triage(advisories, [], now).errors).toHaveLength(1);
    expect(({} as Record<string, unknown>)['via']).toBeUndefined();
  });

  test('a triage entry cannot use a wildcard or a far expiry', () => {
    const entry = (id: string, expires: string) => ({
      advisories: [{ id, package: 'katex', reason: 'x', expires }],
    });
    expect(() => parseTriage(entry('GHSA-*', '2026-12-01'), now)).toThrow(
      'is not a GHSA ID',
    );
    expect(() =>
      parseTriage(entry('GHSA-238p-pmpm-9mq7', '9999-12-31'), now),
    ).toThrow('days from now');
  });

  test('a truncated, empty, or error report fails the gate', () => {
    for (const text of [
      '',
      '{"auditReportVersion":2,"vulnerabilities":{',
      '{"error":{"code":"E403","summary":"forbidden"}}',
      'null',
    ]) {
      const error = vi.fn<(message: string) => void>();
      const result = triageMain(['audit.json', 'triage.json'], {
        readFile: (file) =>
          file === 'audit.json' ? text : '{"advisories":[]}',
        log: vi.fn(),
        warn: vi.fn(),
        error,
        now: () => now,
      });
      expect(result, text).toBe(1);
      expect(error).toHaveBeenCalled();
    }
  });
});

describe('license audit against misleading declarations', () => {
  const allowed = new Set(['MIT']);

  test.each([
    'SEE LICENSE IN LICENSE.txt',
    'UNLICENSED',
    'MIT AND GPL-3.0-only',
    '(MIT',
    'MIT OR',
    'MIT+',
    'MIT WITH Commons-Clause',
  ])('refuses %s', (license) => {
    expect(satisfies(license, allowed)).toBe(false);
  });

  test('a nested copy of a package is audited under its own name', () => {
    const packages = parseLockfile({
      packages: {
        'node_modules/ok': { version: '1.0.0', license: 'MIT' },
        'node_modules/ok/node_modules/ok': {
          version: '0.1.0',
          license: 'GPL-3.0-only',
        },
      },
    });
    expect(auditLicenses(packages, { allowed, exceptions: [] }).errors).toEqual(
      ['ok@0.1.0 is licensed GPL-3.0-only, which the policy does not allow'],
    );
  });
});
