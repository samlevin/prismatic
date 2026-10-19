// Fails unless every advisory `npm audit --json` reports is fixed or has an
// unexpired entry in tooling/security/npm-audit-triage.json. The
// `CI: supply-chain security` workflow runs it as
// `node tooling/security/NpmAuditTriage.ts <audit.json>`.
import { readFileSync } from 'node:fs';

export const defaultTriagePath = 'tooling/security/npm-audit-triage.json';

// A triage entry may last at most this long, so every accepted advisory is
// looked at again.
export const maxTriageDays = 180;

const dayMs = 24 * 60 * 60 * 1000;
const ghsaId = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;

export interface Advisory {
  readonly id: string;
  readonly packageName: string;
  readonly severity: string;
  readonly title: string;
}

export interface TriageEntry {
  readonly id: string;
  readonly packageName: string;
  readonly reason: string;
  readonly expires: string;
}

export interface TriageResult {
  readonly errors: readonly string[];
  readonly accepted: readonly string[];
  readonly unused: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${where} must be a non-empty string`);
  return value;
}

// Reads the advisories from npm's audit report version 2. A report npm could
// not produce, such as a registry error, throws instead of passing.
export function parseAuditReport(json: unknown): Advisory[] {
  if (!isRecord(json)) throw new Error('The npm audit report is not an object');
  if (json['error'] !== undefined)
    throw new Error(
      `npm audit failed: ${JSON.stringify(json['error']).slice(0, 500)}`,
    );
  if (json['auditReportVersion'] !== 2 || !isRecord(json['vulnerabilities']))
    throw new Error('The npm audit report is not audit report version 2');
  const advisories = new Map<string, Advisory>();
  for (const [name, vulnerability] of Object.entries(json['vulnerabilities'])) {
    if (!isRecord(vulnerability) || !Array.isArray(vulnerability['via']))
      throw new Error(`The npm audit entry for ${name} has no via list`);
    for (const via of vulnerability['via']) {
      // A string names another vulnerable package, reported on its own.
      if (typeof via === 'string') continue;
      if (!isRecord(via))
        throw new Error(`The npm audit entry for ${name} has a malformed via`);
      const url = text(via['url'], `The advisory URL for ${name}`);
      const id = /\/advisories\/(GHSA(?:-[a-z0-9]{4}){3})$/.exec(url)?.[1];
      const packageName = text(via['name'], `The advisory package for ${name}`);
      const advisory = {
        id: id ?? url,
        packageName,
        severity: text(via['severity'], `The advisory severity for ${name}`),
        title: typeof via['title'] === 'string' ? via['title'] : '',
      };
      advisories.set(`${advisory.id} ${packageName}`, advisory);
    }
  }
  return [...advisories.values()];
}

export function parseTriage(json: unknown, now: Date): TriageEntry[] {
  if (!isRecord(json) || !Array.isArray(json['advisories']))
    throw new Error('The triage file needs an advisories list');
  const latest = now.getTime() + maxTriageDays * dayMs;
  return json['advisories'].map((entry: unknown, index) => {
    const where = `Triage entry ${index + 1}`;
    if (!isRecord(entry)) throw new Error(`${where} is not an object`);
    const id = text(entry['id'], `${where} id`);
    if (!ghsaId.test(id)) throw new Error(`${where} id is not a GHSA ID`);
    const expires = text(entry['expires'], `${where} expires`);
    const expiry = Date.parse(`${expires}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(expires) ||
      Number.isNaN(expiry) ||
      new Date(expiry).toISOString().slice(0, 10) !== expires
    )
      throw new Error(`${where} expires is not a YYYY-MM-DD date`);
    if (expiry > latest)
      throw new Error(
        `${where} expires more than ${maxTriageDays} days from now`,
      );
    return {
      id,
      packageName: text(entry['package'], `${where} package`),
      reason: text(entry['reason'], `${where} reason`),
      expires,
    };
  });
}

// An advisory passes only when an entry names its ID and package and has not
// expired. An entry expires at the start of its date, in UTC.
export function triage(
  advisories: readonly Advisory[],
  entries: readonly TriageEntry[],
  now: Date,
): TriageResult {
  const errors: string[] = [];
  const accepted: string[] = [];
  const used = new Set<TriageEntry>();
  for (const advisory of advisories) {
    const label = `${advisory.id} (${advisory.severity}) in ${advisory.packageName}: ${advisory.title}`;
    const entry = entries.find(
      (candidate) =>
        candidate.id === advisory.id &&
        candidate.packageName === advisory.packageName,
    );
    if (entry === undefined) {
      errors.push(`Untriaged advisory ${label}`);
      continue;
    }
    used.add(entry);
    if (Date.parse(`${entry.expires}T00:00:00Z`) <= now.getTime())
      errors.push(`Triage expired on ${entry.expires} for ${label}`);
    else accepted.push(`Accepted until ${entry.expires}: ${label}`);
  }
  const unused = entries
    .filter((entry) => !used.has(entry))
    .map(
      (entry) =>
        `${entry.id} in ${entry.packageName} is no longer reported; remove its triage entry`,
    );
  return { errors, accepted, unused };
}

export interface NpmAuditTriageIo {
  readonly readFile: (file: string) => string;
  readonly log: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
  readonly now: () => Date;
}

const processIo: NpmAuditTriageIo = {
  readFile: (file) => readFileSync(file, 'utf8'),
  log: (message) => console.log(message),
  warn: (message) => console.log(`::warning::${message}`),
  error: (message) => console.error(message),
  now: () => new Date(),
};

// Command line entry: `<audit.json> [triage.json]`. Returns the process exit
// code.
export function main(
  args: readonly string[],
  io: NpmAuditTriageIo = processIo,
): number {
  const [auditPath, triagePath = defaultTriagePath] = args;
  try {
    if (auditPath === undefined)
      throw new Error('Usage: NpmAuditTriage.ts <audit.json> [triage.json]');
    const now = io.now();
    const result = triage(
      parseAuditReport(JSON.parse(io.readFile(auditPath))),
      parseTriage(JSON.parse(io.readFile(triagePath)), now),
      now,
    );
    for (const message of result.accepted) io.log(message);
    for (const message of result.unused) io.warn(message);
    for (const message of result.errors) io.error(message);
    if (result.errors.length > 0) {
      io.error(
        `Fix each advisory or add a triage entry to ${triagePath}, as CONTRIBUTING.md describes.`,
      );
      return 1;
    }
    io.log(
      `npm audit passed: ${result.accepted.length} triaged advisories, none untriaged.`,
    );
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
