import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CoverageGate,
  CoverageGateError,
  branchExemptFiles,
  main,
  parseCoverageSummary,
  type CoverageSummary,
  type FileCoverage,
} from './CoverageGate.ts';

const gateFile = fileURLToPath(new URL('CoverageGate.ts', import.meta.url));

const file = (
  covered: Partial<Record<keyof FileCoverage, number>> = {},
  total = 100,
): FileCoverage => ({
  statements: { total, covered: covered.statements ?? total },
  branches: { total, covered: covered.branches ?? total },
  functions: { total, covered: covered.functions ?? total },
  lines: { total, covered: covered.lines ?? total },
});

const failures = (report: CoverageSummary, gate = new CoverageGate()) => {
  try {
    gate.assertThresholds(report);
    return [];
  } catch (error) {
    if (!(error instanceof CoverageGateError)) throw error;
    return error.failures;
  }
};

describe('CoverageGate', () => {
  test('passes at exactly 90% on every metric', () => {
    expect(
      failures({
        'src/a.ts': file({
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        }),
      }),
    ).toEqual([]);
  });

  test.each(['statements', 'branches', 'functions', 'lines'] as const)(
    'fails when %s drops below 90%%',
    (metric) => {
      expect(failures({ 'src/a.ts': file({ [metric]: 89 }) })).toEqual([
        `${metric} 89.00% (89/100) is below 90%`,
      ]);
    },
  );

  test('names every failing metric in one error', () => {
    expect(() =>
      new CoverageGate().assertThresholds({
        'src/a.ts': file({ statements: 50, lines: 80 }),
      }),
    ).toThrow(
      'Coverage is below the threshold: statements 50.00% (50/100) is below 90%; lines 80.00% (80/100) is below 90%',
    );
  });

  test('totals counts across files instead of averaging percentages', () => {
    // 0/1 and 99/99 total 99/100, which passes; averaging would give 49.5%.
    expect(
      failures({
        'src/small.ts': file({ lines: 0 }, 1),
        'src/large.ts': file({}, 99),
      }),
    ).toEqual([]);
    expect(
      failures({
        'src/small.ts': file({ lines: 0 }, 11),
        'src/large.ts': file({}, 89),
      }),
    ).toEqual(['lines 89.00% (89/100) is below 90%']);
  });

  test('leaves the two SDK adapters out of the branch metric only', () => {
    expect(branchExemptFiles).toEqual([
      'src/github/GitHubGateway.ts',
      'src/model/OpenAIAdapter.ts',
    ]);
    const report = {
      'src/github/GitHubGateway.ts': file({ branches: 0 }),
      'src/model/OpenAIAdapter.ts': file({ branches: 0 }),
      'src/core/a.ts': file(),
    };
    expect(failures(report)).toEqual([]);
    expect(
      failures({
        ...report,
        'src/model/OpenAIAdapter.ts': file({ branches: 0, statements: 0 }),
      }),
    ).toEqual(['statements 66.67% (200/300) is below 90%']);
    // Any other file still counts for branches.
    expect(
      failures({
        ...report,
        'src/model/ModelGateway.ts': file({ branches: 0 }),
      }),
    ).toEqual(['branches 50.00% (100/200) is below 90%']);
  });

  test('treats a metric with nothing to measure as covered', () => {
    expect(failures({ 'src/core/index.ts': file({}, 0) })).toEqual([]);
  });

  test('fails a report that lists no files', () => {
    expect(failures({})).toEqual(['the coverage report lists no files']);
  });

  test('accepts a custom threshold and exemption list', () => {
    const gate = new CoverageGate({ threshold: 50, branchExemptFiles: [] });
    expect(failures({ 'src/a.ts': file({ branches: 50 }) }, gate)).toEqual([]);
    expect(
      failures({ 'src/github/GitHubGateway.ts': file({ branches: 49 }) }, gate),
    ).toEqual(['branches 49.00% (49/100) is below 50%']);
  });
});

describe('parseCoverageSummary', () => {
  const counts = { total: 4, covered: 3, skipped: 0, pct: 75 };
  const entry = {
    statements: counts,
    branches: counts,
    functions: counts,
    lines: counts,
  };

  test('keys files by repository-relative path and drops the total', () => {
    const root = path.join(tmpdir(), 'repo');
    expect(
      parseCoverageSummary(
        { total: entry, [path.join(root, 'src', 'core', 'a.ts')]: entry },
        root,
      ),
    ).toEqual({
      'src/core/a.ts': {
        statements: { total: 4, covered: 3 },
        branches: { total: 4, covered: 3 },
        functions: { total: 4, covered: 3 },
        lines: { total: 4, covered: 3 },
      },
    });
  });

  test.each([
    ['a non-object summary', [], 'The coverage summary is not an object'],
    ['a null summary', null, 'The coverage summary is not an object'],
    ['a file without counts', { '/a.ts': 3 }, '/a.ts has no coverage counts'],
    [
      'a missing metric',
      { '/a.ts': { ...entry, lines: undefined } },
      '/a.ts lines needs integer total and covered counts',
    ],
    [
      'a fractional count',
      { '/a.ts': { ...entry, branches: { total: 1.5, covered: 1 } } },
      '/a.ts branches needs integer total and covered counts',
    ],
    [
      'a negative count',
      { '/a.ts': { ...entry, functions: { total: 1, covered: -1 } } },
      '/a.ts functions needs integer total and covered counts',
    ],
    [
      'more covered than total',
      { '/a.ts': { ...entry, statements: { total: 1, covered: 2 } } },
      '/a.ts statements needs integer total and covered counts',
    ],
  ])('rejects %s', (_name, json, message) => {
    expect(() => parseCoverageSummary(json, '/')).toThrow(message);
  });
});

describe('main', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  const summary = (covered: number) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'coverage-gate-'));
    directories.push(directory);
    const counts = { total: 10, covered };
    const target = path.join(directory, 'coverage-summary.json');
    writeFileSync(
      target,
      JSON.stringify({
        [path.join(directory, 'src', 'a.ts')]: {
          statements: counts,
          branches: counts,
          functions: counts,
          lines: counts,
        },
      }),
    );
    return target;
  };

  test('reads the summary, logs success, and returns 0', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main([summary(9)])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      'Coverage gate passed: totals across 1 file are at or above 90% on every metric.',
    );
  });

  test('prints the failure and returns 1 below the threshold', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main([summary(8)])).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('statements 80.00% (8/10) is below 90%'),
    );
  });

  test('defaults to the Vitest summary path and reports a missing file', () => {
    const readFile = vi.fn<(file: string) => string>(() => {
      throw new Error('no such file');
    });
    const error = vi.fn<(message: string) => void>();
    expect(main([], { readFile, log: vi.fn(), error, cwd: '/' })).toBe(1);
    expect(readFile).toHaveBeenCalledWith('coverage/coverage-summary.json');
    expect(error).toHaveBeenCalledWith('no such file');
  });

  test('reports a thrown value that is not an Error', () => {
    const error = vi.fn<(message: string) => void>();
    const readFile = () => {
      throw 'unreadable';
    };
    expect(main(['x'], { readFile, log: vi.fn(), error, cwd: '/' })).toBe(1);
    expect(error).toHaveBeenCalledWith('unreadable');
  });

  test('exits non-zero from the command line so CI fails', () => {
    const failing = spawnSync(process.execPath, [gateFile, summary(5)], {
      encoding: 'utf8',
    });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('is below 90%');
    const passing = spawnSync(process.execPath, [gateFile, summary(10)], {
      encoding: 'utf8',
    });
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain('Coverage gate passed');
  });
});
