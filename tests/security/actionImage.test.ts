// Hostile conditions for the Action entrypoint, and the supply-chain rules
// for the image that runs it. The fixture corpus in #139 will add generated
// cases; until then the cases are listed here. tests/e2e/container-smoke/
// checks the built image itself.
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatOutput,
  nodeFiles,
  openAppendChannel,
  runEntrypoint,
  runStub,
  type EntrypointSystem,
  type ProcessIdentity,
} from '../../apps/action/main.ts';
import { readBinariesLock } from '../support/binariesLock.ts';
import { credentialExamples as credentials } from '../support/credentials.ts';
import { parseGitHubOutput } from '../support/githubOutput.ts';

const repository = new URL('../../', import.meta.url);
const readRepositoryFile = (name: string) =>
  readFileSync(new URL(name, repository), 'utf8');

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'prismatic-entrypoint-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// A process that is already unprivileged, so the drop has nothing to do.
const unprivileged: ProcessIdentity = {
  getuid: () => 10001,
  geteuid: () => 10001,
  getgid: () => 10001,
  getegid: () => 10001,
  getgroups: () => [10001],
  setgroups: () => {
    throw new Error('EPERM');
  },
  setgid: () => {
    throw new Error('EPERM');
  },
  setuid: () => {
    throw new Error('EPERM');
  },
};

interface Recorded {
  readonly prefixes: string[];
  readonly environments: Record<string, string>[];
}

const recorder = (): Recorded => ({ prefixes: [], environments: [] });

function entrypointSystem(
  environment: Record<string, string>,
  record: Recorded,
): EntrypointSystem & { lines: string[] } {
  const lines: string[] = [];
  return {
    environment,
    identity: unprivileged,
    files: {
      ...nodeFiles,
      makeTempDirectory: (prefix) => {
        record.prefixes.push(prefix);
        return mkdtempSync(path.join(scratch, 'workspace-'));
      },
    },
    run: (_command, _args, childEnvironment) => {
      record.environments.push({ ...childEnvironment });
      return { status: 0, stderr: '' };
    },
    log: (line) => lines.push(line),
    lines,
  };
}

describe('Action output files', () => {
  it.each([
    'x\nresult=completed',
    'x\r\nresult=completed',
    'x\nghadelimiter_00000000-0000-0000-0000-000000000000\nresult=completed',
    'x<<EOF\nresult=completed\nEOF',
  ])('a value cannot add another output: %j', (value) => {
    const outputs = parseGitHubOutput(formatOutput('skip-reason', value));
    expect([...outputs.keys()]).toEqual(['skip-reason']);
    expect(outputs.get('skip-reason')).toBe(value);
  });

  it('refuses a GITHUB_OUTPUT symbolic link and leaves its target alone', () => {
    const target = path.join(scratch, 'target');
    const link = path.join(scratch, 'set_output');
    writeFileSync(target, 'unchanged');
    symlinkSync(target, link);
    expect(() =>
      openAppendChannel(nodeFiles, { GITHUB_OUTPUT: link }, 'GITHUB_OUTPUT'),
    ).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('unchanged');
  });

  it('refuses a FIFO without waiting for a reader', () => {
    const fifo = path.join(scratch, 'fifo');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    expect(() =>
      openAppendChannel(nodeFiles, { GITHUB_OUTPUT: fifo }, 'GITHUB_OUTPUT'),
    ).toThrow();
  });

  it.each(['/dev/null', '/dev/stdout'])('refuses the device %s', (device) => {
    expect(() =>
      openAppendChannel(
        nodeFiles,
        { GITHUB_STEP_SUMMARY: device },
        'GITHUB_STEP_SUMMARY',
      ),
    ).toThrow();
  });
});

describe('the run workspace and child processes', () => {
  it('ignores TMPDIR and RUNNER_TEMP and keeps secrets out of git', () => {
    const record = recorder();
    const environment = {
      TMPDIR: '/github/workspace',
      RUNNER_TEMP: '/home/runner/work/_temp',
      'INPUT_GITHUB-TOKEN': credentials['github-token'] ?? '',
      'INPUT_OPENAI-API-KEY': credentials['openai-key'] ?? '',
      GITHUB_TOKEN: credentials['github-fine-grained-token'] ?? '',
      GIT_DIR: '/github/workspace/.git',
      GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/github/workspace/hooks'",
      LD_PRELOAD: '/github/workspace/evil.so',
    };
    const system = entrypointSystem(environment, record);
    expect(runEntrypoint(system, runStub)).toBe(0);
    expect(record.prefixes).toEqual(['/tmp/prismatic-']);
    expect(record.environments).toHaveLength(1);
    const [child] = record.environments;
    expect(Object.keys(child ?? {}).sort()).toEqual([
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_NO_LAZY_FETCH',
      'GIT_TERMINAL_PROMPT',
      'HOME',
    ]);
    expect(child?.HOME?.startsWith(scratch)).toBe(true);
  });
});

describe('failure reports', () => {
  it.each(Object.values(credentials))(
    'masks the credential in an error line: %#',
    (credential) => {
      const system = entrypointSystem(
        { 'INPUT_GITHUB-TOKEN': credential },
        recorder(),
      );
      runEntrypoint(system, () => {
        throw new Error(
          `fetch failed for ${credential} and ${btoa(credential)}`,
        );
      });
      const log = system.lines.join('\n');
      expect(log).not.toContain(credential);
      expect(log).not.toContain(btoa(credential));
    },
  );

  it.each([
    'line one\n::add-mask::x',
    'line one\r::set-output name=result::completed',
    'line one%0A::warning::x',
    'line one ::warning::x',
  ])('cannot start another workflow command: %j', (message) => {
    const system = entrypointSystem({}, recorder());
    runEntrypoint(system, () => {
      throw new Error(message);
    });
    expect(system.lines).toHaveLength(1);
    const [line] = system.lines;
    expect(line).toMatch(/^::error::/);
    expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(line).not.toContain('%0A::');
  });
});

describe('the image supply chain', () => {
  const dockerfile = readRepositoryFile('Dockerfile');
  const instructions = dockerfile
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const lock = readBinariesLock();

  it('starts every stage from a digest-pinned image or an earlier stage', () => {
    const stages = new Set<string>();
    for (const line of instructions.filter((entry) => /^FROM\s/i.test(entry))) {
      const match = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
      expect(match, line).not.toBeNull();
      const [, source = '', name] = match ?? [];
      if (!stages.has(source))
        expect(source, line).toMatch(/^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/);
      if (name !== undefined) stages.add(name);
    }
    expect(stages.size).toBeGreaterThan(1);
  });

  it('has no USER instruction', () => {
    expect(instructions.filter((line) => /^USER\s/i.test(line))).toEqual([]);
  });

  it('downloads only through the lock-checked fetch script', () => {
    expect(instructions.filter((line) => /^ADD\s/i.test(line))).toEqual([]);
    expect(dockerfile).not.toMatch(/https?:\/\//);
    expect(dockerfile).not.toMatch(/\bwget\b/);
    const fetched = [
      ...dockerfile.matchAll(
        /fetch-pinned\.sh \/pinned\/binaries\.lock (\S+) (\S+)/g,
      ),
    ].map(([, name]) => name);
    expect(new Set(fetched)).toEqual(new Set(['git', 'ast-grep']));
    for (const name of fetched)
      expect(lock.some((entry) => entry.name === name)).toBe(true);
  });

  it('pins every lock entry by version and SHA-256 over HTTPS', () => {
    const keys = new Set<string>();
    for (const entry of lock) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.url).toContain(entry.version);
      const key = `${entry.name} ${entry.platform}`;
      expect(keys.has(key), key).toBe(false);
      keys.add(key);
    }
    expect([...keys].sort()).toEqual([
      'ast-grep linux/amd64',
      'ast-grep linux/arm64',
      'git source',
    ]);
  });

  it('runs the compiled entrypoint with an absolute interpreter path', () => {
    expect(instructions.filter((line) => /^ENTRYPOINT\s/i.test(line))).toEqual([
      'ENTRYPOINT ["/usr/local/bin/node", "/opt/prismatic/apps/action/main.js"]',
    ]);
  });

  it('builds from an allowlisted context', () => {
    const ignore = readRepositoryFile('.dockerignore')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(ignore[0]).toBe('*');
    expect(ignore.filter((line) => line.startsWith('!')).sort()).toEqual([
      '!.npmrc',
      '!apps',
      '!docker/binaries.lock',
      '!docker/fetch-pinned.sh',
      '!package-lock.json',
      '!package.json',
      '!src',
      '!tsconfig.build.json',
      '!tsconfig.json',
    ]);
  });
});
