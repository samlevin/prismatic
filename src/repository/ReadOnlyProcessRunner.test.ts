import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { credentialExamples } from '../../tests/support/credentials.ts';
import {
  createSecretRedactor,
  patternSecretRedactor,
} from '../shared/redaction.ts';
import {
  approvedBinaryPaths,
  gitEnvironment,
  maxProcessInputBytes,
  maxProcessOutputBytes,
  maxProcessTimeoutMs,
  nodeProcessSpawner,
  normativeGitArguments,
  type ProcessLimits,
  ProcessRunnerError,
  type ProcessSpawner,
  ReadOnlyProcessRunner,
  type SpawnOutcome,
  type SpawnRequest,
} from './ReadOnlyProcessRunner.ts';

// The real spawn, wrapped so a test can read the options it was given.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const home = '/tmp/prismatic-test/home';
const cwd = '/tmp/prismatic-test/objects.git';
const limits: ProcessLimits = {
  cwd,
  timeoutMs: 5_000,
  maxStdoutBytes: 1024,
  maxStderrBytes: 1024,
};

const exited: SpawnOutcome = {
  exitCode: 0,
  signal: null,
  termination: 'exited',
  stdout: Buffer.from('out'),
  stderr: Buffer.from(''),
};

function recordingRunner(outcome: SpawnOutcome = exited): {
  runner: ReadOnlyProcessRunner;
  requests: SpawnRequest[];
} {
  const requests: SpawnRequest[] = [];
  const spawner: ProcessSpawner = (request) => {
    requests.push(request);
    return Promise.resolve(outcome);
  };
  return {
    runner: new ReadOnlyProcessRunner({
      home,
      redactor: patternSecretRedactor,
      spawner,
    }),
    requests,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject.');
}

describe('ReadOnlyProcessRunner', () => {
  it('runs git at its image path with exactly the normative arguments and environment', async () => {
    const { runner, requests } = recordingRunner();
    await runner.runBinary('git', ['cat-file', '--batch'], limits);
    expect(requests).toHaveLength(1);
    const [request] = requests as [SpawnRequest];
    expect(request.file).toBe('/usr/local/bin/git');
    expect(request.args).toMatchInlineSnapshot(`
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "diff.external=",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "submodule.recurse=false",
        "-c",
        "credential.helper=",
        "cat-file",
        "--batch",
      ]
    `);
    expect(Object.keys(request.env).sort()).toMatchInlineSnapshot(`
      [
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_NO_LAZY_FETCH",
        "GIT_TERMINAL_PROMPT",
        "HOME",
      ]
    `);
    expect(request.env).toEqual({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      HOME: home,
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
    });
    expect(request.args.join(' ')).not.toContain('protocol.file');
  });

  it('gives every git run the same prefix and environment', async () => {
    const { runner, requests } = recordingRunner();
    await runner.runBinary('git', ['diff', '--no-ext-diff'], limits);
    await runner.runBinary('git', ['grep', '-F', '-e', 'x'], limits);
    for (const request of requests) {
      expect(request.args.slice(0, normativeGitArguments.length)).toEqual(
        normativeGitArguments,
      );
      expect(request.env).toEqual(gitEnvironment(home));
    }
  });

  it('runs ast-grep at its image path with its arguments alone and an empty environment', async () => {
    const { runner, requests } = recordingRunner();
    await runner.runBinary('ast-grep', ['scan', '--json'], limits);
    const [request] = requests as [SpawnRequest];
    expect(request.file).toBe('/usr/local/bin/ast-grep');
    expect(request.args).toEqual(['scan', '--json']);
    expect(request.env).toEqual({});
  });

  it('passes the limits, working directory, and input to the spawner', async () => {
    const { runner, requests } = recordingRunner();
    await runner.runBinary('git', ['cat-file', '--batch'], {
      ...limits,
      stdin: 'abc\n',
    });
    await runner.runBinary('git', ['cat-file', '--batch'], limits);
    expect(requests[0]).toMatchObject({
      cwd,
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      stdin: 'abc\n',
    });
    expect(requests[1]).not.toHaveProperty('stdin');
  });

  it('copies the arguments, so a later change by the caller cannot alter a run', async () => {
    const { runner, requests } = recordingRunner();
    const args = ['scan', '--json'];
    await runner.runBinary('ast-grep', args, limits);
    args.push('--injected');
    expect(requests[0]?.args).toEqual(['scan', '--json']);
  });

  it('returns the outcome with stderr decoded and redacted', async () => {
    const token = credentialExamples['github-token'] as string;
    const outcome: SpawnOutcome = {
      exitCode: 128,
      signal: null,
      termination: 'stderr-limit',
      stdout: Buffer.from('partial'),
      stderr: Buffer.from(`fatal: could not read ${token} or held-secret\n`),
    };
    // The run's redactor knows the secrets it holds; the pattern-only one
    // masks just the token shape.
    const { runner } = recordingRunner(outcome);
    const result = await new ReadOnlyProcessRunner({
      home,
      redactor: createSecretRedactor(['held-secret']),
      spawner: () => Promise.resolve(outcome),
    }).runBinary('git', ['fetch'], limits);
    expect(result).toEqual({
      binary: 'git',
      exitCode: 128,
      signal: null,
      termination: 'stderr-limit',
      stdout: Buffer.from('partial'),
      stderr:
        'fatal: could not read [REDACTED:github-token] or [REDACTED:secret]\n',
    });
    expect((await runner.runBinary('git', ['fetch'], limits)).stderr).toBe(
      'fatal: could not read [REDACTED:github-token] or held-secret\n',
    );
  });

  it.each(['stderr-limit', 'deadline', 'stdout-limit'] as const)(
    'drops the cut last stderr line of a run ended by %s, so a cut secret never shows',
    async (termination) => {
      const token = credentialExamples['github-token'] as string;
      const cut = token.slice(0, 20);
      const runner = new ReadOnlyProcessRunner({
        home,
        redactor: patternSecretRedactor,
        spawner: () =>
          Promise.resolve({
            ...exited,
            exitCode: null,
            signal: 'SIGKILL',
            termination,
            stderr: Buffer.from(`warning: first\nfatal: token ${cut}`),
          }),
      });
      const result = await runner.runBinary('git', ['fetch'], limits);
      expect(result.stderr).toBe('warning: first\n');
      expect(result.stderr).not.toContain(cut);
    },
  );

  it('drops all of a killed run stderr that holds no complete line', async () => {
    const runner = new ReadOnlyProcessRunner({
      home,
      redactor: patternSecretRedactor,
      spawner: () =>
        Promise.resolve({
          ...exited,
          termination: 'stderr-limit',
          stderr: Buffer.from('ghp_partial'),
        }),
    });
    expect((await runner.runBinary('git', ['fetch'], limits)).stderr).toBe('');
  });

  it('keeps the last stderr line of a run that exited by itself', async () => {
    const runner = new ReadOnlyProcessRunner({
      home,
      redactor: patternSecretRedactor,
      spawner: () =>
        Promise.resolve({ ...exited, stderr: Buffer.from('a\nfatal: b') }),
    });
    expect((await runner.runBinary('git', ['fetch'], limits)).stderr).toBe(
      'a\nfatal: b',
    );
  });

  it.each([
    ['a shell', 'sh'],
    ['an absolute path', '/bin/sh'],
    ['a prototype key', 'constructor'],
    ['a prototype key', '__proto__'],
    ['a non-string', 42],
  ])('refuses %s as the binary and starts nothing', async (_, binary) => {
    const { runner, requests } = recordingRunner();
    const error = await rejection(
      runner.runBinary(binary as 'git', ['status'], limits),
    );
    expect(error).toBeInstanceOf(ProcessRunnerError);
    expect(error).toMatchObject({ code: 'unapproved-binary' });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['no arguments', []],
    ['a non-array', 'status'],
    ['a non-string argument', ['status', 1]],
    ['a NUL byte', ['diff', '--', 'a\0b']],
    ['configuration with no subcommand', ['-c', 'alias.x=!sh']],
    ['configuration the runner does not allow', ['-c', 'alias.x=!sh', 'fetch']],
    [
      'a protocol override',
      ['-c', 'protocol.file.allow=always', 'fetch', 'origin'],
    ],
    [
      'the noop negotiator on another subcommand',
      ['-c', 'fetch.negotiationAlgorithm=noop', 'diff'],
    ],
    [
      'an allowed entry next to a refused one',
      [
        '-c',
        'fetch.negotiationAlgorithm=noop',
        '-c',
        'core.hooksPath=hooks',
        'fetch',
      ],
    ],
    ['a dangling configuration switch', ['-c']],
    ['a prototype key as the subcommand', ['-c', 'x', 'constructor']],
    ['an exec path before the subcommand', ['--exec-path=/tmp', 'status']],
    ['a directory switch before the subcommand', ['-C', '/', 'status']],
    ['an uppercase subcommand', ['Status']],
    ['an empty subcommand', ['']],
  ])('refuses %s and starts nothing', async (_, args) => {
    const { runner, requests } = recordingRunner();
    const error = await rejection(
      runner.runBinary('git', args as string[], limits),
    );
    expect(error).toMatchObject({
      name: 'ProcessRunnerError',
      code: 'invalid-arguments',
    });
    expect(requests).toHaveLength(0);
  });

  it('allows the noop negotiator on a fetch, after the normative options', async () => {
    const { runner, requests } = recordingRunner();
    const args = [
      '-c',
      'fetch.negotiationAlgorithm=noop',
      'fetch',
      '--no-tags',
      '--stdin',
      'origin',
    ];
    await runner.runBinary('git', args, limits);
    expect(requests[0]?.args).toEqual([...normativeGitArguments, ...args]);
  });

  it('refuses configuration in front of an ast-grep subcommand', async () => {
    const { runner, requests } = recordingRunner();
    const error = await rejection(
      runner.runBinary(
        'ast-grep',
        ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch'],
        limits,
      ),
    );
    expect(error).toMatchObject({ code: 'invalid-arguments' });
    expect(requests).toHaveLength(0);
  });

  it('never echoes a refused argument', async () => {
    const { runner } = recordingRunner();
    const error = await rejection(
      runner.runBinary('git', ['--secret-value-here'], limits),
    );
    expect((error as Error).message).not.toContain('secret-value-here');
  });

  it.each([
    ['no limits', undefined],
    ['null limits', null],
    ['a relative working directory', { ...limits, cwd: 'objects.git' }],
    ['a NUL in the working directory', { ...limits, cwd: '/tmp/a\0b' }],
    ['no deadline', { ...limits, timeoutMs: undefined }],
    ['a zero deadline', { ...limits, timeoutMs: 0 }],
    ['a negative deadline', { ...limits, timeoutMs: -1 }],
    ['a fractional deadline', { ...limits, timeoutMs: 1.5 }],
    ['an infinite deadline', { ...limits, timeoutMs: Infinity }],
    ['a NaN deadline', { ...limits, timeoutMs: NaN }],
    ['a string deadline', { ...limits, timeoutMs: '1000' }],
    [
      'a deadline over the maximum',
      { ...limits, timeoutMs: maxProcessTimeoutMs + 1 },
    ],
    ['no stdout cap', { ...limits, maxStdoutBytes: undefined }],
    [
      'a stdout cap over the maximum',
      { ...limits, maxStdoutBytes: maxProcessOutputBytes + 1 },
    ],
    ['no stderr cap', { ...limits, maxStderrBytes: undefined }],
    ['a zero stderr cap', { ...limits, maxStderrBytes: 0 }],
    ['input of another type', { ...limits, stdin: ['a'] }],
    [
      'input over the maximum',
      { ...limits, stdin: Buffer.alloc(maxProcessInputBytes + 1) },
    ],
  ])('refuses %s and starts nothing', async (_, opts) => {
    const { runner, requests } = recordingRunner();
    const error = await rejection(
      runner.runBinary('git', ['status'], opts as ProcessLimits),
    );
    expect(error).toMatchObject({
      name: 'ProcessRunnerError',
      code: 'invalid-limits',
    });
    expect(requests).toHaveLength(0);
  });

  it('accepts limits at the maximum', async () => {
    const { runner, requests } = recordingRunner();
    await runner.runBinary('git', ['status'], {
      cwd,
      timeoutMs: maxProcessTimeoutMs,
      maxStdoutBytes: maxProcessOutputBytes,
      maxStderrBytes: maxProcessOutputBytes,
      stdin: Buffer.alloc(maxProcessInputBytes),
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    ['a relative home', 'home'],
    ['a NUL in the home', '/tmp/a\0b'],
    ['a non-string home', undefined],
  ])('refuses %s at construction', (_, value) => {
    expect(
      () =>
        new ReadOnlyProcessRunner({
          home: value as string,
          redactor: patternSecretRedactor,
        }),
    ).toThrow(
      expect.objectContaining({ code: 'invalid-configuration' }) as Error,
    );
  });

  it('defaults to the node spawner, which runs only the image paths', async () => {
    const runner = new ReadOnlyProcessRunner({
      home,
      redactor: patternSecretRedactor,
    });
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    // The image path may or may not exist where the tests run; either way
    // the call goes to the pinned path.
    await runner
      .runBinary('ast-grep', ['help'], { ...limits, cwd: tmpdir() })
      .catch(() => undefined);
    expect(spawn.mock.calls[0]?.[0]).toBe(approvedBinaryPaths['ast-grep']);
  });
});

describe('nodeProcessSpawner', () => {
  const node = process.execPath;
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'prismatic-spawner-'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const request = (
    script: string,
    overrides: Partial<SpawnRequest> = {},
  ): SpawnRequest => ({
    file: node,
    args: ['-e', script],
    cwd: directory,
    env: {},
    timeoutMs: 10_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
    ...overrides,
  });

  it('starts the process without a shell, in its own process group', async () => {
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    await nodeProcessSpawner(request('0'));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe(node);
    expect(spawn.mock.calls[0]?.[1]).toEqual(['-e', '0']);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: directory,
      env: {},
      shell: false,
      detached: true,
    });
  });

  it('passes every argument literally', async () => {
    const args = ['$(touch canary)', '`id`', 'a; b', "it's", '*', '|', '>out'];
    const result = await nodeProcessSpawner(
      request('process.stdout.write(JSON.stringify(process.argv.slice(1)))', {
        args: [
          '-e',
          'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
          ...args,
        ],
      }),
    );
    expect(JSON.parse(result.stdout.toString('utf8'))).toEqual(args);
  });

  it('gives the child only the environment it is handed', async () => {
    process.env.PRISMATIC_PARENT_ONLY = 'parent';
    try {
      const result = await nodeProcessSpawner(
        request(
          'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith("PRISMATIC"))))',
          { env: { PRISMATIC_GIVEN: '1' } },
        ),
      );
      expect(JSON.parse(result.stdout.toString('utf8'))).toEqual([
        'PRISMATIC_GIVEN',
      ]);
    } finally {
      delete process.env.PRISMATIC_PARENT_ONLY;
    }
  });

  it('reports the exit code and captured output', async () => {
    const result = await nodeProcessSpawner(
      request(
        'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3',
      ),
    );
    expect(result).toEqual({
      exitCode: 3,
      signal: null,
      termination: 'exited',
      stdout: Buffer.from('out'),
      stderr: Buffer.from('err'),
    });
  });

  it('writes string and buffer input, then closes standard input', async () => {
    const echo =
      'const c = []; process.stdin.on("data", (d) => c.push(d)); process.stdin.on("end", () => process.stdout.write(Buffer.concat(c)))';
    const fromString = await nodeProcessSpawner(
      request(echo, { stdin: 'abc' }),
    );
    const fromBuffer = await nodeProcessSpawner(
      request(echo, { stdin: Buffer.from([0, 1, 2]) }),
    );
    const none = await nodeProcessSpawner(request(echo));
    expect(fromString.stdout.toString('utf8')).toBe('abc');
    expect(fromBuffer.stdout).toEqual(Buffer.from([0, 1, 2]));
    expect(none.stdout).toEqual(Buffer.alloc(0));
  });

  it('keeps the exit status when the process leaves its input unread', async () => {
    const result = await nodeProcessSpawner(
      request('process.exit(5)', { stdin: Buffer.alloc(4 * 1024 * 1024) }),
    );
    expect(result.exitCode).toBe(5);
    expect(result.termination).toBe('exited');
  });

  it('kills the process at the deadline', async () => {
    const result = await nodeProcessSpawner(
      request('process.stdout.write("started"); setInterval(() => {}, 1000)', {
        timeoutMs: 300,
      }),
    );
    expect(result.termination).toBe('deadline');
    expect(result.signal).toBe('SIGKILL');
    expect(result.exitCode).toBeNull();
  });

  it('kills the process when stdout passes its cap and keeps the bytes up to it', async () => {
    const result = await nodeProcessSpawner(
      request(
        'process.stdout.write("x".repeat(1 << 20)); setInterval(() => {}, 1000)',
        { maxStdoutBytes: 1000 },
      ),
    );
    expect(result.termination).toBe('stdout-limit');
    expect(result.signal).toBe('SIGKILL');
    expect(result.stdout).toEqual(Buffer.from('x'.repeat(1000)));
  });

  it('kills the process when stderr passes its cap', async () => {
    const result = await nodeProcessSpawner(
      request(
        'process.stderr.write("e".repeat(1 << 20)); setInterval(() => {}, 1000)',
        { maxStderrBytes: 10 },
      ),
    );
    expect(result.termination).toBe('stderr-limit');
    expect(result.stderr).toEqual(Buffer.from('e'.repeat(10)));
  });

  it('accepts output exactly at the cap', async () => {
    const result = await nodeProcessSpawner(
      request('process.stdout.write("x".repeat(100))', {
        maxStdoutBytes: 100,
      }),
    );
    expect(result.termination).toBe('exited');
    expect(result.stdout).toHaveLength(100);
  });

  it('kills the helper processes a run started, not only the run', async () => {
    // The child starts a grandchild that holds the output pipes open and
    // prints its process id, then both wait forever.
    const script = [
      'const { spawn } = require("node:child_process");',
      'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });',
      'process.stdout.write(String(g.pid) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const result = await nodeProcessSpawner(
      request(script, { timeoutMs: 1000 }),
    );
    expect(result.termination).toBe('deadline');
    const grandchild = Number(result.stdout.toString('utf8').trim());
    expect(Number.isSafeInteger(grandchild)).toBe(true);
    expect(await gone(grandchild)).toBe(true);
  });

  it('falls back to killing the process alone when the group cannot be signalled', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('no group'), { code: 'ESRCH' });
    });
    try {
      const result = await nodeProcessSpawner(
        request('setInterval(() => {}, 1000)', { timeoutMs: 200 }),
      );
      expect(result.termination).toBe('deadline');
      expect(result.signal).toBe('SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });

  it('rejects with the system code when the process cannot start', async () => {
    const error = await rejection(
      nodeProcessSpawner({
        ...request('0'),
        file: path.join(directory, 'missing-binary'),
      }),
    );
    expect(error).toBeInstanceOf(ProcessRunnerError);
    expect(error).toMatchObject({
      code: 'process-start-failed',
      systemCode: 'ENOENT',
    });
    expect((error as Error).message).not.toContain('missing-binary');
  });

  it('rejects with a runner error when spawn throws at once', async () => {
    const file = path.join(directory, 'not-a-directory');
    writeFileSync(file, '');
    const error = await rejection(
      nodeProcessSpawner(request('0', { cwd: file })),
    );
    expect(error).toBeInstanceOf(ProcessRunnerError);
    expect(error).toMatchObject({ code: 'process-start-failed' });
  });

  it('keeps only the system code of a thrown start error', async () => {
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn E2BIG with secret args'), {
        code: 'E2BIG',
      });
    });
    const coded = await rejection(nodeProcessSpawner(request('0')));
    spawn.mockImplementationOnce(() => {
      throw 'not an error';
    });
    const uncoded = await rejection(nodeProcessSpawner(request('0')));
    spawn.mockImplementationOnce(() => {
      throw Object.assign(new Error('odd'), { code: 7 });
    });
    const numeric = await rejection(nodeProcessSpawner(request('0')));
    expect(coded).toMatchObject({
      code: 'process-start-failed',
      systemCode: 'E2BIG',
      message: 'The process could not start.',
    });
    expect(uncoded).toMatchObject({ code: 'process-start-failed' });
    expect((uncoded as ProcessRunnerError).systemCode).toBeUndefined();
    expect((numeric as ProcessRunnerError).systemCode).toBeUndefined();
  });

  it('rejects, and swallows the later error, when the child has no pipes', async () => {
    // What Node returns when it runs out of file descriptors.
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: null,
      stdout: null,
      stderr: null,
      kill: vi.fn(() => true),
    });
    vi.mocked(childProcess.spawn).mockImplementationOnce(
      () => child as unknown as ReturnType<typeof childProcess.spawn>,
    );
    const error = await rejection(nodeProcessSpawner(request('0')));
    expect(error).toMatchObject({ code: 'process-start-failed' });
    expect(child.kill).not.toHaveBeenCalled();
    // The deferred error finds a listener and settles nothing twice.
    expect(() =>
      child.emit(
        'error',
        Object.assign(new Error('EMFILE'), { code: 'EMFILE' }),
      ),
    ).not.toThrow();
  });
});

// True once the process no longer exists, polling for up to two seconds so a
// killed process has time to be reaped.
async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
