// Builds the Action image and runs it offline the way GitHub runs a
// container action: as root, with GITHUB_OUTPUT and GITHUB_STEP_SUMMARY on a
// mount the unprivileged user cannot write. Every container runs with
// `--network none`, so the image must start without installing anything.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockedVersion, readBinariesLock } from '../../support/binariesLock.ts';
import { parseGitHubOutput } from '../../support/githubOutput.ts';
import { listTar } from './tar.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const runtimeId = 10001;
const suffix = randomUUID().slice(0, 8);
const presetImage = process.env.PRISMATIC_SMOKE_IMAGE;
const image = presetImage ?? `prismatic-smoke:${suffix}`;
const volume = `prismatic-smoke-${suffix}`;
const container = `prismatic-smoke-${suffix}`;
const commands = '/github/file_commands';
const outputPath = `${commands}/set_output`;
const summaryPath = `${commands}/step_summary`;
// A made-up credential, so the test can check it never reaches an output.
const fakeToken = `ghs_${'A1b2C3d4'.repeat(5)}`;

interface Result {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

function docker(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Result {
  const result = spawnSync('docker', args, {
    cwd: root,
    env: environment,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr.toString('utf8'),
  };
}

function succeed(args: readonly string[]): string {
  const result = docker(args);
  if (result.status !== 0)
    throw new Error(
      `docker ${args.join(' ')} exited with ${String(result.status)}: ${result.stderr}`,
    );
  return result.stdout.toString('utf8');
}

// Runs one command in a throwaway container from the image.
function inImage(
  entrypoint: string,
  args: readonly string[],
  options: readonly string[] = [],
): Result {
  return docker([
    'run',
    '--rm',
    '--network',
    'none',
    ...options,
    '--entrypoint',
    entrypoint,
    image,
    ...args,
  ]);
}

const lock = readBinariesLock();

beforeAll(() => {
  // BuildKit supplies TARGETOS and TARGETARCH, and older Docker clients
  // only use it when asked.
  if (presetImage === undefined) {
    const build = docker(['build', '--tag', image, '.'], {
      ...process.env,
      DOCKER_BUILDKIT: '1',
    });
    expect(build.status, build.stderr).toBe(0);
  }
  succeed(['volume', 'create', volume]);
  // The runner creates both files before the step starts. Here they belong
  // to root, in a directory only root may enter.
  const prepared = inImage(
    '/bin/sh',
    [
      '-c',
      `: > ${outputPath} && : > ${summaryPath} && chmod 600 ${outputPath} ${summaryPath} && chmod 700 ${commands}`,
    ],
    ['--volume', `${volume}:${commands}`],
  );
  expect(prepared.status, prepared.stderr).toBe(0);
});

afterAll(() => {
  docker(['rm', '--force', container]);
  docker(['volume', 'rm', '--force', volume]);
  if (presetImage === undefined) docker(['image', 'rm', '--force', image]);
});

describe('the Action image', () => {
  it('starts as root and enters through the entrypoint script', () => {
    const [config] = JSON.parse(succeed(['image', 'inspect', image])) as Array<{
      Config: { User: string; Entrypoint: string[] };
    }>;
    expect(config?.Config.User).toBe('');
    expect(config?.Config.Entrypoint).toEqual([
      '/usr/local/bin/node',
      '/opt/prismatic/apps/action/main.js',
    ]);
  });

  it('ships the Git and ast-grep versions from docker/binaries.lock', () => {
    const git = inImage('/usr/local/bin/git', ['--version']);
    expect(git.stdout.toString().trim()).toBe(
      `git version ${lockedVersion(lock, 'git')}`,
    );
    const astGrep = inImage('/usr/local/bin/ast-grep', ['--version']);
    expect(astGrep.stdout.toString().trim()).toBe(
      `ast-grep ${lockedVersion(lock, 'ast-grep')}`,
    );
    const https = inImage('/usr/bin/test', [
      '-x',
      '/usr/local/libexec/git-core/git-remote-https',
    ]);
    expect(https.status).toBe(0);
  });

  it('has no package manager to install anything at run time', () => {
    const found = inImage('/bin/sh', [
      '-c',
      'for tool in npm npx corepack yarn; do command -v "$tool"; done; true',
    ]);
    expect(found.status).toBe(0);
    expect(found.stdout.toString()).toBe('');
  });

  it('has the unprivileged user the entrypoint drops to', () => {
    for (const flag of ['-u', '-g'])
      expect(
        inImage('/usr/bin/id', [flag, 'prismatic']).stdout.toString(),
      ).toBe(`${runtimeId}\n`);
  });
});

describe('the entrypoint', () => {
  it('cannot rely on the unprivileged user to write the Action files', () => {
    const attempt = inImage(
      '/bin/sh',
      ['-c', `echo injected=1 >> ${outputPath}`],
      [
        '--user',
        `${runtimeId}:${runtimeId}`,
        '--volume',
        `${volume}:${commands}`,
      ],
    );
    expect(attempt.status).not.toBe(0);
  });

  it('drops root before the first git process and still writes outputs', () => {
    const run = docker([
      'run',
      '--name',
      container,
      '--network',
      'none',
      '--workdir',
      '/github/workspace',
      '--volume',
      `${volume}:${commands}`,
      '--env',
      `GITHUB_OUTPUT=${outputPath}`,
      '--env',
      `GITHUB_STEP_SUMMARY=${summaryPath}`,
      '--env',
      `INPUT_GITHUB-TOKEN=${fakeToken}`,
      // Host mounts on a real runner. The workspace must not go there.
      '--env',
      `TMPDIR=${commands}`,
      '--env',
      `RUNNER_TEMP=${commands}`,
      image,
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.toString()).not.toContain('::error::');

    const read = (target: string) =>
      inImage(
        '/bin/cat',
        [target],
        ['--volume', `${volume}:${commands}`],
      ).stdout.toString();
    const outputs = read(outputPath);
    expect(parseGitHubOutput(outputs)).toEqual(
      new Map([
        ['result', 'skipped'],
        ['skip-reason', 'unsupported-event'],
      ]),
    );
    expect(outputs).not.toContain(fakeToken);
    expect(read(summaryPath)).toContain('Prismatic skipped');
    const commandFiles = inImage(
      '/bin/ls',
      ['-A', commands],
      ['--volume', `${volume}:${commands}`],
    );
    expect(commandFiles.stdout.toString().split('\n').filter(Boolean)).toEqual([
      'set_output',
      'step_summary',
    ]);

    // The container's /tmp after the run. git created objects.git, so its
    // owner is the effective user of the first git process.
    const entries = listTar(docker(['cp', `${container}:/tmp`, '-']).stdout);
    const workspaces = entries.filter((entry) =>
      /^tmp\/prismatic-[^/]+$/.test(entry.path),
    );
    expect(workspaces).toHaveLength(1);
    const workspace = workspaces[0]?.path ?? '';
    const owned = (path: string) => {
      const entry = entries.find((candidate) => candidate.path === path);
      expect(entry, path).toBeDefined();
      return [entry?.uid, entry?.gid];
    };
    expect(owned(workspace)).toEqual([runtimeId, runtimeId]);
    expect((workspaces[0]?.mode ?? 0) & 0o777).toBe(0o700);
    expect(owned(`${workspace}/objects.git`)).toEqual([runtimeId, runtimeId]);
    expect(owned(`${workspace}/objects.git/HEAD`)).toEqual([
      runtimeId,
      runtimeId,
    ]);
    const createdByGit = entries.filter((entry) =>
      entry.path.startsWith(`${workspace}/objects.git`),
    );
    expect(createdByGit.length).toBeGreaterThan(1);
    expect(createdByGit.filter((entry) => entry.uid === 0)).toEqual([]);
  });
});
