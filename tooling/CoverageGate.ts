// Fails the build when unit test coverage drops below the thresholds.
// `npm run test:unit` runs Vitest with coverage, then runs this file on the
// JSON summary Vitest writes. The two SDK adapters are exempt from the branch
// metric because contract tests cover them instead.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const coverageMetrics = [
  'statements',
  'branches',
  'functions',
  'lines',
] as const;

export type CoverageMetric = (typeof coverageMetrics)[number];

export interface MetricCounts {
  readonly total: number;
  readonly covered: number;
}

export type FileCoverage = Readonly<Record<CoverageMetric, MetricCounts>>;

// Coverage counts per file, keyed by repository-relative POSIX path.
export type CoverageSummary = Readonly<Record<string, FileCoverage>>;

export const defaultThreshold = 90;

export const branchExemptFiles: readonly string[] = [
  'src/github/GitHubGateway.ts',
  'src/model/OpenAIAdapter.ts',
];

export interface CoverageGateOptions {
  // Minimum percentage for every metric.
  readonly threshold?: number;
  // Files left out of the branch metric only.
  readonly branchExemptFiles?: readonly string[];
}

export class CoverageGateError extends Error {
  readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    super(`Coverage is below the threshold: ${failures.join('; ')}`);
    this.name = 'CoverageGateError';
    this.failures = failures;
  }
}

export class CoverageGate {
  readonly #threshold: number;
  readonly #branchExemptFiles: ReadonlySet<string>;

  constructor(options: CoverageGateOptions = {}) {
    this.#threshold = options.threshold ?? defaultThreshold;
    this.#branchExemptFiles = new Set(
      options.branchExemptFiles ?? branchExemptFiles,
    );
  }

  // Throws CoverageGateError naming every metric below the threshold.
  assertThresholds(report: CoverageSummary): void {
    const files = Object.entries(report);
    if (files.length === 0)
      throw new CoverageGateError(['the coverage report lists no files']);
    const failures: string[] = [];
    for (const metric of coverageMetrics) {
      let total = 0;
      let covered = 0;
      for (const [file, coverage] of files) {
        if (metric === 'branches' && this.#branchExemptFiles.has(file))
          continue;
        total += coverage[metric].total;
        covered += coverage[metric].covered;
      }
      // Comparing products avoids rounding; no measured items is 100%.
      if (covered * 100 < this.#threshold * total)
        failures.push(
          `${metric} ${((covered / total) * 100).toFixed(2)}% (${covered}/${total}) is below ${this.#threshold}%`,
        );
    }
    if (failures.length > 0) throw new CoverageGateError(failures);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function counts(value: unknown, where: string): MetricCounts {
  if (
    isRecord(value) &&
    Number.isInteger(value['total']) &&
    Number.isInteger(value['covered']) &&
    (value['total'] as number) >= 0 &&
    (value['covered'] as number) >= 0 &&
    (value['covered'] as number) <= (value['total'] as number)
  )
    return {
      total: value['total'] as number,
      covered: value['covered'] as number,
    };
  throw new Error(`${where} needs integer total and covered counts`);
}

// Reads Istanbul's json-summary output: absolute file paths mapped to
// per-metric counts, plus a `total` entry that the gate recomputes itself.
export function parseCoverageSummary(
  json: unknown,
  rootDir: string,
): CoverageSummary {
  if (!isRecord(json)) throw new Error('The coverage summary is not an object');
  const report: Record<string, FileCoverage> = {};
  for (const [file, value] of Object.entries(json)) {
    if (file === 'total') continue;
    if (!isRecord(value)) throw new Error(`${file} has no coverage counts`);
    const relative = path.relative(rootDir, file).split(path.sep).join('/');
    report[relative] = {
      statements: counts(value['statements'], `${file} statements`),
      branches: counts(value['branches'], `${file} branches`),
      functions: counts(value['functions'], `${file} functions`),
      lines: counts(value['lines'], `${file} lines`),
    };
  }
  return report;
}

export interface CoverageGateIo {
  readonly readFile: (file: string) => string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly cwd: string;
}

const processIo: CoverageGateIo = {
  readFile: (file) => readFileSync(file, 'utf8'),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  cwd: process.cwd(),
};

// Command line entry: `node tooling/CoverageGate.ts [summary.json]`. Returns
// the process exit code.
export function main(
  args: readonly string[],
  io: CoverageGateIo = processIo,
): number {
  const summaryPath = args[0] ?? 'coverage/coverage-summary.json';
  try {
    const report = parseCoverageSummary(
      JSON.parse(io.readFile(summaryPath)),
      io.cwd,
    );
    new CoverageGate().assertThresholds(report);
    io.log(
      `Coverage gate passed: ${Object.keys(report).length} files at or above ${defaultThreshold}% on every metric.`,
    );
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
