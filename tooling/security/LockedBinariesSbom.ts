// Adds the native binaries from docker/binaries.lock to the image's CycloneDX
// SBOM. Trivy finds no package metadata for them, because Git is built from
// source into /usr/local and ast-grep is a bare release binary, so its SBOM
// leaves them out. The `CI: supply-chain security` workflow runs it as
// `node tooling/security/LockedBinariesSbom.ts <sbom.json> <platform>`.
import { readFileSync, writeFileSync } from 'node:fs';

export const defaultLockPath = 'docker/binaries.lock';

export interface LockEntry {
  readonly name: string;
  readonly version: string;
  readonly platform: string;
  readonly sha256: string;
  readonly url: string;
}

export interface SbomComponent {
  readonly type: 'application';
  readonly 'bom-ref': string;
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly externalReferences: readonly [
    {
      readonly type: 'distribution';
      readonly url: string;
      readonly hashes: readonly [
        { readonly alg: 'SHA-256'; readonly content: string },
      ];
    },
  ];
}

// The docker/binaries.lock format: `name version platform sha256 url` per
// line, with `#` comments and blank lines ignored.
export function parseLock(text: string): LockEntry[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [name, version, platform, sha256, url, ...rest] = line.split(/\s+/);
      if (
        name === undefined ||
        version === undefined ||
        platform === undefined ||
        url === undefined ||
        rest.length > 0 ||
        !/^[0-9a-f]{64}$/.test(sha256 ?? '') ||
        !url.startsWith('https://')
      )
        throw new Error(`Malformed lock line ${JSON.stringify(line)}`);
      return { name, version, platform, sha256: sha256 as string, url };
    });
}

// One component per binary: its `source` entry, or else its entry for the
// image platform. The hash is that of the locked download.
export function lockComponents(
  entries: readonly LockEntry[],
  platform: string,
): SbomComponent[] {
  const names = [...new Set(entries.map((entry) => entry.name))];
  return names.map((name) => {
    const matches = entries.filter(
      (entry) =>
        entry.name === name &&
        (entry.platform === 'source' || entry.platform === platform),
    );
    const [entry] = matches;
    if (entry === undefined || matches.length > 1)
      throw new Error(
        `Expected one ${name} entry for source or ${platform}, found ${matches.length}`,
      );
    const reference = `pkg:generic/${entry.name}@${entry.version}`;
    return {
      type: 'application',
      'bom-ref': reference,
      name: entry.name,
      version: entry.version,
      purl: `${reference}?download_url=${encodeURIComponent(entry.url)}`,
      externalReferences: [
        {
          type: 'distribution',
          url: entry.url,
          hashes: [{ alg: 'SHA-256', content: entry.sha256 }],
        },
      ],
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function addComponents(
  sbom: unknown,
  components: readonly SbomComponent[],
): Record<string, unknown> {
  if (!isRecord(sbom) || sbom['bomFormat'] !== 'CycloneDX')
    throw new Error('The SBOM is not a CycloneDX document');
  const existing = sbom['components'] ?? [];
  if (!Array.isArray(existing))
    throw new Error('The SBOM components are not a list');
  const references = new Set(
    existing.map((component: unknown) =>
      isRecord(component) ? component['bom-ref'] : undefined,
    ),
  );
  return {
    ...sbom,
    components: [
      ...existing,
      ...components.filter(
        (component) => !references.has(component['bom-ref']),
      ),
    ],
  };
}

export interface LockedBinariesSbomIo {
  readonly readFile: (file: string) => string;
  readonly writeFile: (file: string, text: string) => void;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

const processIo: LockedBinariesSbomIo = {
  readFile: (file) => readFileSync(file, 'utf8'),
  writeFile: (file, text) => writeFileSync(file, text),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

// Command line entry: `<sbom.json> <platform> [binaries.lock]`, rewriting
// the SBOM in place. Returns the process exit code.
export function main(
  args: readonly string[],
  io: LockedBinariesSbomIo = processIo,
): number {
  const [sbomPath, platform, lockPath = defaultLockPath] = args;
  try {
    if (sbomPath === undefined || platform === undefined)
      throw new Error(
        'Usage: LockedBinariesSbom.ts <sbom.json> <platform> [binaries.lock]',
      );
    const components = lockComponents(
      parseLock(io.readFile(lockPath)),
      platform,
    );
    const sbom = addComponents(JSON.parse(io.readFile(sbomPath)), components);
    io.writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
    io.log(
      `Added ${components.map((component) => `${component.name}@${component.version}`).join(', ')} to ${sbomPath}.`,
    );
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
