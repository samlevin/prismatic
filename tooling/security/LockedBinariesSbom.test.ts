import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  addComponents,
  defaultLockPath,
  lockComponents,
  main,
  parseLock,
} from './LockedBinariesSbom.ts';

const gitSha = 'a'.repeat(64);
const amdSha = 'b'.repeat(64);
const armSha = 'c'.repeat(64);
const lock = `# comment

git 2.56.0 source ${gitSha} https://example.test/git-2.56.0.tar.xz
ast-grep 0.51.0 linux/amd64 ${amdSha} https://example.test/amd64.zip
ast-grep 0.51.0 linux/arm64 ${armSha} https://example.test/arm64.zip
`;

describe('parseLock', () => {
  test('reads entries and skips comments and blank lines', () => {
    expect(parseLock(lock)).toEqual([
      {
        name: 'git',
        version: '2.56.0',
        platform: 'source',
        sha256: gitSha,
        url: 'https://example.test/git-2.56.0.tar.xz',
      },
      {
        name: 'ast-grep',
        version: '0.51.0',
        platform: 'linux/amd64',
        sha256: amdSha,
        url: 'https://example.test/amd64.zip',
      },
      {
        name: 'ast-grep',
        version: '0.51.0',
        platform: 'linux/arm64',
        sha256: armSha,
        url: 'https://example.test/arm64.zip',
      },
    ]);
  });

  test.each([
    'git 2.56.0 source',
    `git 2.56.0 source ${gitSha} https://example.test/x extra`,
    `git 2.56.0 source ${'A'.repeat(64)} https://example.test/x`,
    `git 2.56.0 source ${gitSha} http://example.test/x`,
  ])('refuses %s', (line) => {
    expect(() => parseLock(line)).toThrow('Malformed lock line');
  });

  test('reads the repository lock', () => {
    const entries = parseLock(readFileSync(defaultLockPath, 'utf8'));
    expect(
      lockComponents(entries, 'linux/amd64').map(({ name }) => name),
    ).toEqual(['git', 'ast-grep']);
  });
});

describe('lockComponents', () => {
  test('uses the source entry or the entry for the image platform', () => {
    const components = lockComponents(parseLock(lock), 'linux/amd64');
    expect(components).toEqual([
      {
        type: 'application',
        'bom-ref': 'pkg:generic/git@2.56.0',
        name: 'git',
        version: '2.56.0',
        purl: 'pkg:generic/git@2.56.0?download_url=https%3A%2F%2Fexample.test%2Fgit-2.56.0.tar.xz',
        externalReferences: [
          {
            type: 'distribution',
            url: 'https://example.test/git-2.56.0.tar.xz',
            hashes: [{ alg: 'SHA-256', content: gitSha }],
          },
        ],
      },
      expect.objectContaining({
        'bom-ref': 'pkg:generic/ast-grep@0.51.0',
        externalReferences: [
          expect.objectContaining({
            url: 'https://example.test/amd64.zip',
            hashes: [{ alg: 'SHA-256', content: amdSha }],
          }),
        ],
      }),
    ]);
  });

  test('refuses a platform the lock does not cover or an ambiguous entry', () => {
    expect(() => lockComponents(parseLock(lock), 'linux/s390x')).toThrow(
      'Expected one ast-grep entry for source or linux/s390x, found 0',
    );
    const twice = parseLock(
      `${lock}git 2.56.0 linux/amd64 ${gitSha} https://example.test/git`,
    );
    expect(() => lockComponents(twice, 'linux/amd64')).toThrow(
      'Expected one git entry for source or linux/amd64, found 2',
    );
  });
});

describe('addComponents', () => {
  const [git] = lockComponents(parseLock(lock), 'linux/amd64');

  test('appends components and keeps the rest of the document', () => {
    expect(
      addComponents(
        {
          bomFormat: 'CycloneDX',
          specVersion: '1.6',
          components: [{ name: 'x' }],
        },
        [git!],
      ),
    ).toEqual({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      components: [{ name: 'x' }, git],
    });
  });

  test('creates the component list and skips a component already present', () => {
    expect(addComponents({ bomFormat: 'CycloneDX' }, [git!])).toEqual({
      bomFormat: 'CycloneDX',
      components: [git],
    });
    expect(
      addComponents({ bomFormat: 'CycloneDX', components: [git] }, [git!])[
        'components'
      ],
    ).toEqual([git]);
  });

  test('refuses a document that is not CycloneDX', () => {
    expect(() => addComponents({ spdxVersion: 'SPDX-2.3' }, [])).toThrow(
      'not a CycloneDX document',
    );
    expect(() => addComponents(null, [])).toThrow('not a CycloneDX document');
    expect(() =>
      addComponents({ bomFormat: 'CycloneDX', components: {} }, []),
    ).toThrow('components are not a list');
  });
});

describe('main', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  const files = () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'locked-sbom-'));
    directories.push(directory);
    const sbom = path.join(directory, 'image.cdx.json');
    const lockPath = path.join(directory, 'binaries.lock');
    writeFileSync(
      sbom,
      JSON.stringify({ bomFormat: 'CycloneDX', components: [] }),
    );
    writeFileSync(lockPath, lock);
    return { sbom, lockPath };
  };

  test('rewrites the SBOM in place with the console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { sbom, lockPath } = files();
    expect(main([sbom, 'linux/arm64', lockPath])).toBe(0);
    const written = JSON.parse(readFileSync(sbom, 'utf8'));
    expect(
      written.components.map(({ purl }: { purl: string }) => purl),
    ).toEqual([
      'pkg:generic/git@2.56.0?download_url=https%3A%2F%2Fexample.test%2Fgit-2.56.0.tar.xz',
      'pkg:generic/ast-grep@0.51.0?download_url=https%3A%2F%2Fexample.test%2Farm64.zip',
    ]);
    expect(log).toHaveBeenCalledWith(
      `Added git@2.56.0, ast-grep@0.51.0 to ${sbom}.`,
    );
  });

  test('reads docker/binaries.lock unless told otherwise', () => {
    const readFile = vi.fn((file: string) =>
      file === defaultLockPath ? lock : '{"bomFormat":"CycloneDX"}',
    );
    const writeFile = vi.fn<(file: string, text: string) => void>();
    const io = { readFile, writeFile, log: vi.fn(), error: vi.fn() };
    expect(main(['sbom.json', 'linux/amd64'], io)).toBe(0);
    expect(readFile).toHaveBeenCalledWith(defaultLockPath);
    expect(writeFile).toHaveBeenCalledWith(
      'sbom.json',
      expect.stringMatching(/\n$/),
    );
  });

  test('fails without both arguments or on a bad input', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main([])).toBe(1);
    expect(error).toHaveBeenCalledWith(
      'Usage: LockedBinariesSbom.ts <sbom.json> <platform> [binaries.lock]',
    );
    const { sbom, lockPath } = files();
    expect(main([sbom, 'linux/s390x', lockPath])).toBe(1);
    expect(error).toHaveBeenLastCalledWith(
      'Expected one ast-grep entry for source or linux/s390x, found 0',
    );
    const thrower = {
      readFile: () => {
        throw 'unreadable';
      },
      writeFile: vi.fn(),
      log: vi.fn(),
      error: vi.fn(),
    };
    expect(main(['a', 'b'], thrower)).toBe(1);
    expect(thrower.error).toHaveBeenCalledWith('unreadable');
  });
});
