// Fails unless every entry in tooling/security/trivy-ignore.yaml names one
// vulnerability, says why, and expires within maxIgnoreDays. Trivy honors any
// `expired_at`, so this check is what keeps an ignore short. The
// `CI: supply-chain security` workflow runs it as
// `node tooling/security/TrivyIgnoreCheck.ts` before the image scan.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export const defaultIgnorePath = 'tooling/security/trivy-ignore.yaml';

// An ignore may last at most this long, so a fixable vulnerability is looked
// at again soon.
export const maxIgnoreDays = 30;

const dayMs = 24 * 60 * 60 * 1000;
const vulnerabilityId =
  /^(?:CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/;
const entryKeys = ['expired_at', 'id', 'statement'];

export interface IgnoreEntry {
  readonly id: string;
  readonly statement: string;
  readonly expiredAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reads the ignore file's entries. A malformed file, an unknown field, or an
// expiry more than maxIgnoreDays after `now` throws.
export function parseIgnores(text: string, now: Date): IgnoreEntry[] {
  const json: unknown = parse(text);
  if (
    !isRecord(json) ||
    Object.keys(json).join(',') !== 'vulnerabilities' ||
    !Array.isArray(json['vulnerabilities'])
  )
    throw new Error('The ignore file needs only a vulnerabilities list');
  const latest = now.getTime() + maxIgnoreDays * dayMs;
  return json['vulnerabilities'].map((entry: unknown, index) => {
    const where = `Ignore entry ${index + 1}`;
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(',') !== entryKeys.join(',')
    )
      throw new Error(`${where} needs exactly ${entryKeys.join(', ')}`);
    const { id, statement, expired_at: expiredAt } = entry;
    if (typeof id !== 'string' || !vulnerabilityId.test(id))
      throw new Error(`${where} id is not a CVE or GHSA ID`);
    if (typeof statement !== 'string' || statement.trim() === '')
      throw new Error(`${where} statement must be a non-empty string`);
    const expiry =
      typeof expiredAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expiredAt)
        ? Date.parse(`${expiredAt}T00:00:00Z`)
        : Number.NaN;
    if (
      Number.isNaN(expiry) ||
      new Date(expiry).toISOString().slice(0, 10) !== expiredAt
    )
      throw new Error(`${where} expired_at is not a YYYY-MM-DD date`);
    if (expiry > latest)
      throw new Error(
        `${where} expired_at is more than ${maxIgnoreDays} days from now`,
      );
    return { id, statement, expiredAt: expiredAt as string };
  });
}

export interface TrivyIgnoreCheckIo {
  readonly readFile: (file: string) => string;
  readonly log: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
  readonly now: () => Date;
}

const processIo: TrivyIgnoreCheckIo = {
  readFile: (file) => readFileSync(file, 'utf8'),
  log: (message) => console.log(message),
  warn: (message) => console.log(`::warning::${message}`),
  error: (message) => console.error(message),
  now: () => new Date(),
};

// Command line entry: `[trivy-ignore.yaml]`. Returns the process exit code.
// An expired entry only warns, because Trivy no longer ignores it.
export function main(
  args: readonly string[],
  io: TrivyIgnoreCheckIo = processIo,
): number {
  const [ignorePath = defaultIgnorePath] = args;
  try {
    const now = io.now();
    const entries = parseIgnores(io.readFile(ignorePath), now);
    for (const entry of entries)
      if (Date.parse(`${entry.expiredAt}T00:00:00Z`) <= now.getTime())
        io.warn(
          `${entry.id} expired on ${entry.expiredAt}; remove it from ${ignorePath}`,
        );
      else io.log(`Ignoring ${entry.id} until ${entry.expiredAt}`);
    io.log(`${ignorePath} passed with ${entries.length} entries.`);
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error(
      `Fix ${ignorePath} as CONTRIBUTING.md describes before the image scan uses it.`,
    );
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
