// Fails unless every package in package-lock.json has a license the policy in
// tooling/security/license-policy.json allows, or a reviewed exception there.
// The `CI: supply-chain security` workflow runs it as
// `node tooling/security/LicenseAudit.ts`.
import { readFileSync } from 'node:fs';

export const defaultLockPath = 'package-lock.json';
export const defaultPolicyPath = 'tooling/security/license-policy.json';

export interface LockedPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string | undefined;
}

export interface LicenseException {
  readonly packageName: string;
  readonly version: string;
  readonly license: string;
  readonly reason: string;
}

export interface LicensePolicy {
  readonly allowed: ReadonlySet<string>;
  readonly exceptions: readonly LicenseException[];
}

export interface LicenseAuditResult {
  readonly errors: readonly string[];
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

// Every installed package in a lockfile version 2 or 3. Workspace links and
// the root are this repository's own code.
export function parseLockfile(json: unknown): LockedPackage[] {
  if (!isRecord(json) || !isRecord(json['packages']))
    throw new Error('package-lock.json has no packages map');
  const packages: LockedPackage[] = [];
  for (const [key, entry] of Object.entries(json['packages'])) {
    const marker = key.lastIndexOf('node_modules/');
    if (marker === -1) continue;
    if (!isRecord(entry)) throw new Error(`${key} is not an object`);
    if (entry['link'] === true) continue;
    packages.push({
      name: key.slice(marker + 'node_modules/'.length),
      version: text(entry['version'], `${key} version`),
      license:
        typeof entry['license'] === 'string' ? entry['license'] : undefined,
    });
  }
  return packages;
}

export function parsePolicy(json: unknown): LicensePolicy {
  if (
    !isRecord(json) ||
    !Array.isArray(json['allowed']) ||
    !Array.isArray(json['exceptions'])
  )
    throw new Error('The license policy needs allowed and exceptions lists');
  return {
    allowed: new Set(
      json['allowed'].map((license: unknown, index) =>
        text(license, `Allowed license ${index + 1}`),
      ),
    ),
    exceptions: json['exceptions'].map((entry: unknown, index) => {
      const where = `License exception ${index + 1}`;
      if (!isRecord(entry)) throw new Error(`${where} is not an object`);
      return {
        packageName: text(entry['package'], `${where} package`),
        version: text(entry['version'], `${where} version`),
        license: text(entry['license'], `${where} license`),
        reason: text(entry['reason'], `${where} reason`),
      };
    }),
  };
}

// Whether an SPDX expression is satisfied by the allowed identifiers: OR
// needs one allowed side, AND needs both, and `X WITH Y` must be allowed as
// written. A malformed expression is never satisfied.
export function satisfies(
  expression: string,
  allowed: ReadonlySet<string>,
): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const license = (): boolean => {
    const token = tokens[position++];
    if (token === '(') {
      const value = or();
      if (tokens[position++] !== ')') throw new Error('unclosed parenthesis');
      return value;
    }
    if (token === undefined || [')', 'AND', 'OR', 'WITH'].includes(token))
      throw new Error('missing license');
    if (peek() !== 'WITH') return allowed.has(token);
    position++;
    const exception = tokens[position++];
    if (exception === undefined || ['(', ')'].includes(exception))
      throw new Error('missing exception');
    return allowed.has(`${token} WITH ${exception}`);
  };
  const and = (): boolean => {
    let value = license();
    while (peek() === 'AND') {
      position++;
      value = license() && value;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (peek() === 'OR') {
      position++;
      value = and() || value;
    }
    return value;
  };
  try {
    const value = or();
    return position === tokens.length && value;
  } catch {
    return false;
  }
}

export function auditLicenses(
  packages: readonly LockedPackage[],
  policy: LicensePolicy,
): LicenseAuditResult {
  const errors: string[] = [];
  const used = new Set<LicenseException>();
  for (const locked of packages) {
    const label = `${locked.name}@${locked.version}`;
    const exception = policy.exceptions.find(
      (entry) =>
        entry.packageName === locked.name && entry.version === locked.version,
    );
    if (exception !== undefined) {
      used.add(exception);
      if (!satisfies(exception.license, policy.allowed))
        errors.push(
          `${label} is recorded as ${exception.license}, which the policy does not allow`,
        );
    } else if (locked.license === undefined)
      errors.push(`${label} declares no license in package-lock.json`);
    else if (!satisfies(locked.license, policy.allowed))
      errors.push(
        `${label} is licensed ${locked.license}, which the policy does not allow`,
      );
  }
  const unused = policy.exceptions
    .filter((entry) => !used.has(entry))
    .map(
      (entry) =>
        `${entry.packageName}@${entry.version} is no longer installed; remove its license exception`,
    );
  return { errors, unused };
}

export interface LicenseAuditIo {
  readonly readFile: (file: string) => string;
  readonly log: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
}

const processIo: LicenseAuditIo = {
  readFile: (file) => readFileSync(file, 'utf8'),
  log: (message) => console.log(message),
  warn: (message) => console.log(`::warning::${message}`),
  error: (message) => console.error(message),
};

// Command line entry: `[package-lock.json] [license-policy.json]`. Returns
// the process exit code.
export function main(
  args: readonly string[],
  io: LicenseAuditIo = processIo,
): number {
  const [lockPath = defaultLockPath, policyPath = defaultPolicyPath] = args;
  try {
    const packages = parseLockfile(JSON.parse(io.readFile(lockPath)));
    const result = auditLicenses(
      packages,
      parsePolicy(JSON.parse(io.readFile(policyPath))),
    );
    for (const message of result.unused) io.warn(message);
    for (const message of result.errors) io.error(message);
    if (result.errors.length > 0) {
      io.error(
        `Replace each package or record a reviewed decision in ${policyPath}, as CONTRIBUTING.md describes.`,
      );
      return 1;
    }
    io.log(`License audit passed for ${packages.length} packages.`);
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
