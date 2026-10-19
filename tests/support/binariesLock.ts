// Reads docker/binaries.lock: one artifact per line, as `name version
// platform sha256 url`, with `#` comments and blank lines ignored.
import { readFileSync } from 'node:fs';

export interface LockEntry {
  readonly name: string;
  readonly version: string;
  readonly platform: string;
  readonly sha256: string;
  readonly url: string;
}

export const binariesLockUrl = new URL(
  '../../docker/binaries.lock',
  import.meta.url,
);

export function parseBinariesLock(text: string): LockEntry[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const fields = line.split(/\s+/);
      const [name, version, platform, sha256, url] = fields;
      if (
        fields.length !== 5 ||
        name === undefined ||
        version === undefined ||
        platform === undefined ||
        sha256 === undefined ||
        url === undefined
      )
        throw new Error(`Malformed lock line ${JSON.stringify(line)}.`);
      return { name, version, platform, sha256, url };
    });
}

export function readBinariesLock(): LockEntry[] {
  return parseBinariesLock(readFileSync(binariesLockUrl, 'utf8'));
}

// The single version the lock pins for a binary.
export function lockedVersion(entries: readonly LockEntry[], name: string) {
  const versions = new Set(
    entries
      .filter((entry) => entry.name === name)
      .map((entry) => entry.version),
  );
  const [version] = versions;
  if (versions.size !== 1 || version === undefined)
    throw new Error(`Expected one locked version of ${name}.`);
  return version;
}
