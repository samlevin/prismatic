import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  auditLicenses,
  defaultLockPath,
  defaultPolicyPath,
  main,
  parseLockfile,
  parsePolicy,
  satisfies,
  type LicensePolicy,
} from './LicenseAudit.ts';

const auditFile = fileURLToPath(new URL('LicenseAudit.ts', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const allowed = new Set([
  'MIT',
  'Apache-2.0',
  'GPL-2.0-only WITH Classpath-exception-2.0',
]);

const policy = (
  exceptions: LicensePolicy['exceptions'] = [],
): LicensePolicy => ({
  allowed,
  exceptions,
});

describe('satisfies', () => {
  test('accepts an allowed identifier and rejects others', () => {
    expect(satisfies('MIT', allowed)).toBe(true);
    expect(satisfies('GPL-3.0-only', allowed)).toBe(false);
    expect(satisfies('mit', allowed)).toBe(false);
  });

  test('needs one allowed side of OR and both sides of AND', () => {
    expect(satisfies('(MIT OR GPL-3.0-only)', allowed)).toBe(true);
    expect(satisfies('GPL-3.0-only OR MIT', allowed)).toBe(true);
    expect(satisfies('MIT AND Apache-2.0', allowed)).toBe(true);
    expect(satisfies('MIT AND GPL-3.0-only', allowed)).toBe(false);
    expect(satisfies('GPL-3.0-only AND MIT', allowed)).toBe(false);
    expect(satisfies('GPL-3.0-only OR MIT AND Apache-2.0', allowed)).toBe(true);
    expect(satisfies('(GPL-3.0-only OR MIT) AND LGPL-2.1', allowed)).toBe(
      false,
    );
  });

  test('matches a WITH exception only as written', () => {
    expect(
      satisfies('GPL-2.0-only WITH Classpath-exception-2.0', allowed),
    ).toBe(true);
    expect(satisfies('MIT WITH Classpath-exception-2.0', allowed)).toBe(false);
  });

  test('never accepts a malformed expression', () => {
    for (const expression of [
      '',
      'MIT OR',
      'OR MIT',
      '(MIT',
      'MIT)',
      'MIT MIT',
      'MIT WITH',
      'MIT WITH (',
      'AND',
      '()',
    ])
      expect(satisfies(expression, allowed), expression).toBe(false);
  });
});

describe('parseLockfile', () => {
  test('lists installed packages and skips the root and workspace links', () => {
    expect(
      parseLockfile({
        packages: {
          '': { name: 'prismatic', version: '0.0.0' },
          'packages/tool': { version: '1.0.0', license: 'MIT' },
          'node_modules/tool': { link: true, resolved: 'packages/tool' },
          'node_modules/a': { version: '1.0.0', license: 'MIT' },
          'node_modules/a/node_modules/@scope/b': { version: '2.0.0' },
          'node_modules/c': { version: '3.0.0', license: { type: 'MIT' } },
        },
      }),
    ).toEqual([
      { name: 'a', version: '1.0.0', license: 'MIT' },
      { name: '@scope/b', version: '2.0.0', license: undefined },
      { name: 'c', version: '3.0.0', license: undefined },
    ]);
  });

  test('refuses a lockfile it cannot read fully', () => {
    expect(() => parseLockfile({ dependencies: {} })).toThrow(
      'has no packages map',
    );
    expect(() => parseLockfile({ packages: { 'node_modules/a': 1 } })).toThrow(
      'node_modules/a is not an object',
    );
    expect(() =>
      parseLockfile({ packages: { 'node_modules/a': { license: 'MIT' } } }),
    ).toThrow('node_modules/a version must be a non-empty string');
  });
});

describe('parsePolicy', () => {
  test('reads allowed licenses and exceptions', () => {
    expect(
      parsePolicy({
        allowed: ['MIT'],
        exceptions: [
          {
            package: 'a',
            version: '1.0.0',
            license: 'MIT',
            reason: 'Checked.',
          },
        ],
      }),
    ).toEqual({
      allowed: new Set(['MIT']),
      exceptions: [
        {
          packageName: 'a',
          version: '1.0.0',
          license: 'MIT',
          reason: 'Checked.',
        },
      ],
    });
  });

  test('refuses malformed policies', () => {
    expect(() => parsePolicy({ allowed: [] })).toThrow(
      'needs allowed and exceptions lists',
    );
    expect(() => parsePolicy({ allowed: [''], exceptions: [] })).toThrow(
      'Allowed license 1 must be a non-empty string',
    );
    expect(() => parsePolicy({ allowed: [], exceptions: ['a'] })).toThrow(
      'License exception 1 is not an object',
    );
    expect(() =>
      parsePolicy({
        allowed: [],
        exceptions: [{ package: 'a', version: '1', license: 'MIT' }],
      }),
    ).toThrow('License exception 1 reason');
  });
});

describe('auditLicenses', () => {
  const exception = {
    packageName: 'format',
    version: '0.2.2',
    license: 'MIT',
    reason: 'Declared in the licenses array.',
  };

  test('passes allowed licenses and recorded exceptions', () => {
    expect(
      auditLicenses(
        [
          { name: 'a', version: '1.0.0', license: '(MIT OR GPL-3.0-only)' },
          { name: 'format', version: '0.2.2', license: undefined },
        ],
        policy([exception]),
      ),
    ).toEqual({ errors: [], unused: [] });
  });

  test('fails a missing or disallowed license', () => {
    expect(
      auditLicenses(
        [
          { name: 'a', version: '1.0.0', license: undefined },
          { name: 'b', version: '2.0.0', license: 'GPL-3.0-only' },
        ],
        policy(),
      ).errors,
    ).toEqual([
      'a@1.0.0 declares no license in package-lock.json',
      'b@2.0.0 is licensed GPL-3.0-only, which the policy does not allow',
    ]);
  });

  test('applies an exception to one version only and flags it when unused', () => {
    const result = auditLicenses(
      [{ name: 'format', version: '0.3.0', license: undefined }],
      policy([exception]),
    );
    expect(result.errors).toEqual([
      'format@0.3.0 declares no license in package-lock.json',
    ]);
    expect(result.unused).toEqual([
      'format@0.2.2 is no longer installed; remove its license exception',
    ]);
  });

  test('fails an exception that records a disallowed license', () => {
    expect(
      auditLicenses(
        [{ name: 'format', version: '0.2.2', license: 'MIT' }],
        policy([{ ...exception, license: 'GPL-3.0-only' }]),
      ).errors,
    ).toEqual([
      'format@0.2.2 is recorded as GPL-3.0-only, which the policy does not allow',
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

  test('reads files and writes to the console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = mkdtempSync(path.join(tmpdir(), 'license-audit-'));
    directories.push(directory);
    const lockPath = path.join(directory, 'lock.json');
    const policyPath = path.join(directory, 'policy.json');
    writeFileSync(
      lockPath,
      JSON.stringify({
        packages: {
          'node_modules/a': { version: '1.0.0', license: 'GPL-3.0-only' },
        },
      }),
    );
    writeFileSync(
      policyPath,
      JSON.stringify({
        allowed: ['MIT'],
        exceptions: [
          { package: 'z', version: '1', license: 'MIT', reason: 'Checked.' },
        ],
      }),
    );
    expect(main([lockPath, policyPath])).toBe(1);
    expect(log).toHaveBeenCalledWith(
      '::warning::z@1 is no longer installed; remove its license exception',
    );
    expect(error).toHaveBeenCalledWith(
      'a@1.0.0 is licensed GPL-3.0-only, which the policy does not allow',
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
  });

  const lock = (license?: string) => ({
    packages: { 'node_modules/a': { version: '1.0.0', license } },
  });
  const policyJson = (exceptions: unknown[] = []) => ({
    allowed: ['MIT'],
    exceptions,
  });

  test('passes with the default paths', () => {
    const output = io({
      [defaultLockPath]: lock('MIT'),
      [defaultPolicyPath]: policyJson(),
    });
    expect(main([], output)).toBe(0);
    expect(output.log).toHaveBeenCalledWith(
      'License audit passed for 1 packages.',
    );
  });

  test('warns about unused exceptions and fails on disallowed licenses', () => {
    const output = io({
      'lock.json': lock('GPL-3.0-only'),
      'policy.json': policyJson([
        { package: 'z', version: '1', license: 'MIT', reason: 'Checked.' },
      ]),
    });
    expect(main(['lock.json', 'policy.json'], output)).toBe(1);
    expect(output.warn).toHaveBeenCalledWith(
      'z@1 is no longer installed; remove its license exception',
    );
    expect(output.error.mock.calls.map(([message]) => message)).toEqual([
      'a@1.0.0 is licensed GPL-3.0-only, which the policy does not allow',
      'Replace each package or record a reviewed decision in policy.json, as CONTRIBUTING.md describes.',
    ]);
  });

  test('fails on unreadable input', () => {
    const output = io({});
    expect(main([], output)).toBe(1);
    expect(output.error).toHaveBeenCalledWith(
      `no such file ${defaultLockPath}`,
    );
    const thrower = {
      ...output,
      readFile: () => {
        throw 'unreadable';
      },
    };
    expect(main([], thrower)).toBe(1);
    expect(output.error).toHaveBeenLastCalledWith('unreadable');
  });

  test('passes on this repository and fails a disallowed license from the command line', () => {
    const passing = spawnSync(process.execPath, [auditFile], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(passing.stderr).toBe('');
    expect(passing.status).toBe(0);
    const directory = mkdtempSync(path.join(tmpdir(), 'license-audit-'));
    directories.push(directory);
    writeFileSync(path.join(directory, 'lock.json'), JSON.stringify(lock()));
    writeFileSync(
      path.join(directory, 'policy.json'),
      JSON.stringify(policyJson()),
    );
    const failing = spawnSync(
      process.execPath,
      [
        auditFile,
        path.join(directory, 'lock.json'),
        path.join(directory, 'policy.json'),
      ],
      { encoding: 'utf8' },
    );
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('a@1.0.0 declares no license');
  });
});
