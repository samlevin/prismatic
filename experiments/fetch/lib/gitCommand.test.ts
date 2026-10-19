import { describe, expect, it } from 'vitest';
import {
  GitCommandError,
  GitRunner,
  defaultGitMaxOutputBytes,
  defaultGitTimeoutMs,
  fileProtocolConfig,
  gitArguments,
  gitEnvironment,
  normativeConfig,
} from './gitCommand.ts';
import type { ProcessResult, SpawnOptions, Spawner } from './processRunner.ts';

describe('gitEnvironment', () => {
  it('sets the §5.3 variables and disables lazy fetch by default', () => {
    expect(gitEnvironment({ home: '/tmp/home' })).toEqual({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      HOME: '/tmp/home',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LC_ALL: 'C',
    });
  });

  it('re-enables lazy fetch only when a process asks for it', () => {
    expect(
      gitEnvironment({ home: '/h', lazyFetch: 'enabled-for-this-process' })
        .GIT_NO_LAZY_FETCH,
    ).toBe('0');
    expect(
      gitEnvironment({ home: '/h', lazyFetch: 'disabled' }).GIT_NO_LAZY_FETCH,
    ).toBe('1');
  });
});

describe('gitArguments', () => {
  it('puts every normative option before the subcommand', () => {
    const args = gitArguments(['fetch', 'origin'], false);
    expect(args.slice(-2)).toEqual(['fetch', 'origin']);
    expect(args.slice(0, -2)).toEqual(
      normativeConfig.flatMap((entry) => ['-c', entry]),
    );
    expect(args).not.toContain(fileProtocolConfig);
  });

  it('adds the file protocol only for fixture remotes', () => {
    const args = gitArguments(['fetch'], true);
    expect(args).toContain(fileProtocolConfig);
    expect(args.indexOf(fileProtocolConfig)).toBeLessThan(
      args.indexOf('fetch'),
    );
  });
});

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    status: 0,
    signal: null,
    stdout: Buffer.from('out'),
    stderr: '',
    elapsedMs: 12.5,
    truncated: false,
    timedOut: false,
    ...overrides,
  };
}

function recordingSpawner(reply: ProcessResult): {
  spawner: Spawner;
  calls: { file: string; args: readonly string[]; options: SpawnOptions }[];
} {
  const calls: {
    file: string;
    args: readonly string[];
    options: SpawnOptions;
  }[] = [];
  return {
    calls,
    spawner: (file, args, options) => {
      calls.push({ file, args, options });
      return Promise.resolve(reply);
    },
  };
}

describe('GitRunner', () => {
  const base = {
    gitPath: '/usr/local/bin/git',
    home: '/work/home',
    allowFileProtocol: false,
    redactText: (text: string) => text.replaceAll('ghs_secret', '[REDACTED]'),
  };

  it('runs git with the normative arguments and environment', async () => {
    const { spawner, calls } = recordingSpawner(result());
    const runner = new GitRunner({ ...base, spawner });
    await runner.run('/repo', ['status']);
    const call = calls[0];
    expect(call?.file).toBe('/usr/local/bin/git');
    expect(call?.args).toEqual(gitArguments(['status'], false));
    expect(call?.options.cwd).toBe('/repo');
    expect(call?.options.env.GIT_NO_LAZY_FETCH).toBe('1');
    expect(call?.options.timeoutMs).toBe(defaultGitTimeoutMs);
    expect(call?.options.maxOutputBytes).toBe(defaultGitMaxOutputBytes);
    expect(call?.options).not.toHaveProperty('input');
  });

  it('passes input, limits and the lazy-fetch switch through', async () => {
    const { spawner, calls } = recordingSpawner(result());
    const runner = new GitRunner({
      ...base,
      spawner,
      timeoutMs: 5,
      maxOutputBytes: 6,
    });
    await runner.run('/repo', ['backfill'], {
      input: 'x',
      lazyFetch: 'enabled-for-this-process',
    });
    await runner.run('/repo', ['fetch'], { timeoutMs: 7, maxOutputBytes: 8 });
    expect(calls[0]?.options).toMatchObject({
      input: 'x',
      timeoutMs: 5,
      maxOutputBytes: 6,
    });
    expect(calls[0]?.options.env.GIT_NO_LAZY_FETCH).toBe('0');
    expect(calls[1]?.options).toMatchObject({
      timeoutMs: 7,
      maxOutputBytes: 8,
    });
    expect(runner.log.map((entry) => entry.lazyFetch)).toEqual([
      'enabled-for-this-process',
      'disabled',
    ]);
  });

  it('redacts stderr before returning or logging it', async () => {
    const { spawner } = recordingSpawner(
      result({ status: 1, stderr: 'auth ghs_secret failed' }),
    );
    const runner = new GitRunner({ ...base, spawner });
    const outcome = await runner.run('/repo', ['fetch']);
    expect(outcome.stderr).toBe('auth [REDACTED] failed');
    expect(runner.log).toEqual([
      {
        cwd: '/repo',
        args: ['fetch'],
        lazyFetch: 'disabled',
        status: 1,
        elapsedMs: 12.5,
      },
    ]);
    const error = await runner.ok('/repo', ['fetch']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitCommandError);
    expect(String((error as Error).message)).not.toContain('ghs_secret');
    expect((error as GitCommandError).status).toBe(1);
  });

  it('treats truncated output as a failure', async () => {
    const { spawner } = recordingSpawner(result({ truncated: true }));
    const runner = new GitRunner({ ...base, spawner });
    await expect(runner.ok('/repo', ['cat-file'])).rejects.toThrow(
      GitCommandError,
    );
  });

  it('returns the result of a successful command', async () => {
    const { spawner } = recordingSpawner(result());
    const runner = new GitRunner({ ...base, spawner });
    const outcome = await runner.ok('/repo', ['status']);
    expect(outcome.stdout.toString()).toBe('out');
  });
});
