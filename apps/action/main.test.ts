import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGitHubOutput } from '../../tests/support/githubOutput.ts';
import { thrown } from '../../tests/support/thrown.ts';
import {
  appendText,
  closeChannels,
  dropPrivileges,
  escapeCommandData,
  formatOutput,
  gitBinary,
  gitEnvironment,
  gitSafetyOptions,
  nodeFiles,
  nodeSystem,
  openAppendChannel,
  openChannels,
  readActionInputs,
  runEntrypoint,
  runProcess,
  runStub,
  runtimeUser,
  type EntrypointSystem,
  type FileSystem,
  type ProcessIdentity,
  type ProcessResult,
  type ProcessRunner,
} from './main.ts';

const runtimeId = 10001;

function permissionError(): Error {
  return Object.assign(new Error('Operation not permitted'), {
    code: 'EPERM',
  });
}

// A process identity with POSIX rules: root may set any ID, and a process
// without root may only switch to its real or saved ID. `prismatic` resolves
// to 10001. The flags model a broken drop.
class FakeIdentity implements ProcessIdentity {
  readonly calls: string[] = [];
  uid: number;
  euid: number;
  savedUid: number;
  gid: number;
  egid: number;
  savedGid: number;
  groups: number[];
  readonly flaws: { ignoreSetuid?: boolean; keepSavedUid?: boolean };

  constructor(
    start: { uid?: number; euid?: number; gid?: number; groups?: number[] },
    flaws: { ignoreSetuid?: boolean; keepSavedUid?: boolean } = {},
  ) {
    this.flaws = flaws;
    this.uid = start.uid ?? 0;
    this.euid = start.euid ?? this.uid;
    this.savedUid = this.euid;
    this.gid = start.gid ?? this.uid;
    this.egid = this.gid;
    this.savedGid = this.gid;
    this.groups = start.groups ?? [this.gid];
  }

  getuid = (): number => this.uid;
  geteuid = (): number => this.euid;
  getgid = (): number => this.gid;
  getegid = (): number => this.egid;
  getgroups = (): number[] => [...this.groups];

  setgroups(groups: readonly number[]): void {
    this.calls.push(`setgroups ${groups.join(',')}`);
    if (this.euid !== 0) throw permissionError();
    this.groups = [...groups];
  }

  setgid(id: number | string): void {
    this.calls.push(`setgid ${String(id)}`);
    const gid = resolve(id);
    if (this.euid === 0) {
      this.gid = this.egid = this.savedGid = gid;
    } else if (gid === this.gid || gid === this.savedGid) {
      this.egid = gid;
    } else throw permissionError();
  }

  setuid(id: number | string): void {
    this.calls.push(`setuid ${String(id)}`);
    const uid = resolve(id);
    if (this.euid === 0) {
      if (this.flaws.ignoreSetuid) return;
      this.uid = this.euid = uid;
      if (!this.flaws.keepSavedUid) this.savedUid = uid;
    } else if (uid === this.uid || uid === this.savedUid) {
      this.euid = uid;
    } else throw permissionError();
  }
}

function resolve(id: number | string): number {
  if (typeof id === 'number') return id;
  if (id === runtimeUser) return runtimeId;
  throw new Error(`Unknown user or group ${id}.`);
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'prismatic-main-test-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// Real file operations, except that temporary directories are created inside
// the test's scratch directory and every prefix asked for is recorded.
function scratchFiles(): FileSystem & {
  prefixes: string[];
  opened: number[];
  closed: number[];
} {
  const prefixes: string[] = [];
  const opened: number[] = [];
  const closed: number[] = [];
  return {
    ...nodeFiles,
    prefixes,
    opened,
    closed,
    open: (target, flags) => {
      const descriptor = nodeFiles.open(target, flags);
      opened.push(descriptor);
      return descriptor;
    },
    close: (descriptor) => {
      closed.push(descriptor);
      nodeFiles.close(descriptor);
    },
    makeTempDirectory: (prefix) => {
      prefixes.push(prefix);
      return mkdtempSync(path.join(scratch, 'workspace-'));
    },
  };
}

interface Recorded {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly euid: number;
}

function recordingRunner(
  identity: FakeIdentity,
  result: ProcessResult = { status: 0, stderr: '' },
): ProcessRunner & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const run: ProcessRunner = (command, args, environment) => {
    calls.push({ command, args, environment, euid: identity.geteuid() });
    return result;
  };
  return Object.assign(run, { calls });
}

function outputFiles(): { output: string; summary: string } {
  const output = path.join(scratch, 'set_output');
  const summary = path.join(scratch, 'step_summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  return { output, summary };
}

function system(
  overrides: Partial<EntrypointSystem> & { identity?: FakeIdentity } = {},
): EntrypointSystem & { lines: string[] } {
  const identity = overrides.identity ?? new FakeIdentity({});
  const lines: string[] = [];
  return {
    environment: {},
    files: scratchFiles(),
    run: recordingRunner(identity),
    log: (line) => lines.push(line),
    ...overrides,
    identity,
    lines,
  };
}

describe('readActionInputs', () => {
  it('maps INPUT_ variables to lower-case input names', () => {
    const inputs = readActionInputs({
      'INPUT_GITHUB-TOKEN': 'token',
      INPUT_MODEL: 'gpt',
      INPUT_EMPTY: '',
      INPUT_UNSET: undefined,
      GITHUB_OUTPUT: '/github/file_commands/set_output',
    });
    expect([...inputs]).toEqual([
      ['github-token', 'token'],
      ['model', 'gpt'],
      ['empty', ''],
    ]);
  });
});

describe('openAppendChannel', () => {
  it('returns undefined when the variable is unset or empty', () => {
    expect(openAppendChannel(nodeFiles, {}, 'GITHUB_OUTPUT')).toBeUndefined();
    expect(
      openAppendChannel(nodeFiles, { GITHUB_OUTPUT: '' }, 'GITHUB_OUTPUT'),
    ).toBeUndefined();
  });

  it('appends to an existing regular file', () => {
    const target = path.join(scratch, 'out');
    writeFileSync(target, 'before\n');
    const descriptor = openAppendChannel(
      nodeFiles,
      { GITHUB_OUTPUT: target },
      'GITHUB_OUTPUT',
    );
    expect(descriptor).toBeTypeOf('number');
    appendText(nodeFiles, descriptor as number, 'after\n');
    nodeFiles.close(descriptor as number);
    expect(readFileSync(target, 'utf8')).toBe('before\nafter\n');
  });

  it('refuses a relative path', () => {
    expect(() =>
      openAppendChannel(
        nodeFiles,
        { GITHUB_OUTPUT: 'set_output' },
        'GITHUB_OUTPUT',
      ),
    ).toThrow('GITHUB_OUTPUT must be an absolute path.');
  });

  it('does not create a missing file', () => {
    const target = path.join(scratch, 'missing');
    expect(
      thrown(() =>
        openAppendChannel(
          nodeFiles,
          { GITHUB_OUTPUT: target },
          'GITHUB_OUTPUT',
        ),
      ),
    ).toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symbolic link', () => {
    const target = path.join(scratch, 'real');
    const link = path.join(scratch, 'link');
    writeFileSync(target, '');
    symlinkSync(target, link);
    expect(
      thrown(() =>
        openAppendChannel(nodeFiles, { GITHUB_OUTPUT: link }, 'GITHUB_OUTPUT'),
      ),
    ).toMatchObject({ code: 'ELOOP' });
  });

  it('refuses a directory', () => {
    expect(
      thrown(() =>
        openAppendChannel(
          nodeFiles,
          { GITHUB_OUTPUT: scratch },
          'GITHUB_OUTPUT',
        ),
      ),
    ).toMatchObject({ code: 'EISDIR' });
  });

  it('closes and refuses a descriptor that is not a regular file', () => {
    const files = { ...scratchFiles(), isRegularFile: () => false };
    const target = path.join(scratch, 'out');
    writeFileSync(target, '');
    expect(() =>
      openAppendChannel(files, { GITHUB_OUTPUT: target }, 'GITHUB_OUTPUT'),
    ).toThrow('GITHUB_OUTPUT must name a regular file.');
    expect(files.closed).toEqual(files.opened);
  });
});

describe('openChannels', () => {
  it('opens both files', () => {
    const { output, summary } = outputFiles();
    const files = scratchFiles();
    const channels = openChannels(files, {
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    });
    expect([channels.output, channels.summary]).toEqual(files.opened);
    closeChannels(files, channels);
    expect(files.closed).toEqual(files.opened);
  });

  it('closes GITHUB_OUTPUT when GITHUB_STEP_SUMMARY cannot be opened', () => {
    const { output } = outputFiles();
    const files = scratchFiles();
    expect(() =>
      openChannels(files, {
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: 'relative',
      }),
    ).toThrow('GITHUB_STEP_SUMMARY must be an absolute path.');
    expect(files.opened).toHaveLength(1);
    expect(files.closed).toEqual(files.opened);
  });

  it('leaves nothing open when GITHUB_STEP_SUMMARY fails alone', () => {
    const files = scratchFiles();
    expect(() =>
      openChannels(files, { GITHUB_STEP_SUMMARY: 'relative' }),
    ).toThrow();
    expect(files.closed).toEqual([]);
  });
});

describe('dropPrivileges', () => {
  it('drops root to the runtime user in a safe order', () => {
    const identity = new FakeIdentity({ groups: [0, 1, 2] });
    dropPrivileges(identity);
    expect(identity.calls).toEqual([
      'setgroups ',
      `setgid ${runtimeUser}`,
      `setuid ${runtimeUser}`,
      'setgid 0',
      'setuid 0',
    ]);
    expect([identity.uid, identity.euid, identity.gid, identity.egid]).toEqual([
      runtimeId,
      runtimeId,
      runtimeId,
      runtimeId,
    ]);
    expect(identity.groups).toEqual([]);
  });

  it('keeps an identity that started without root', () => {
    const identity = new FakeIdentity({ uid: 1000, gid: 1000 });
    dropPrivileges(identity);
    expect(identity.calls).toEqual(['setgid 0', 'setuid 0']);
    expect(identity.euid).toBe(1000);
  });

  it('fails when a user ID is still root', () => {
    const identity = new FakeIdentity({}, { ignoreSetuid: true });
    expect(() => dropPrivileges(identity)).toThrow(
      'The entrypoint still holds a root user or group ID.',
    );
  });

  it('fails when the real user is root and only the effective one is not', () => {
    const identity = new FakeIdentity({ uid: 0, euid: 1000, gid: 1000 });
    expect(() => dropPrivileges(identity)).toThrow(
      'The entrypoint still holds a root user or group ID.',
    );
  });

  it('fails when a supplementary group is root', () => {
    const identity = new FakeIdentity({ uid: 1000, gid: 1000, groups: [0] });
    expect(() => dropPrivileges(identity)).toThrow(
      'The entrypoint still holds a root user or group ID.',
    );
  });

  it('fails when root can be restored', () => {
    const identity = new FakeIdentity({}, { keepSavedUid: true });
    expect(() => dropPrivileges(identity)).toThrow(
      'The entrypoint could restore root after dropping it.',
    );
  });
});

describe('formatOutput', () => {
  it('writes the multi-line form with the given delimiter', () => {
    expect(formatOutput('result', 'skipped', 'EOF_1')).toBe(
      'result<<EOF_1\nskipped\nEOF_1\n',
    );
  });

  it('uses a fresh random delimiter by default', () => {
    const first = formatOutput('result', 'a\nb');
    const second = formatOutput('result', 'a\nb');
    expect(first).not.toBe(second);
    expect(parseGitHubOutput(first).get('result')).toBe('a\nb');
  });

  it.each(['', '1name', 'name=x', 'na me', 'name<<x', 'name\nother'])(
    'refuses the output name %j',
    (name) => {
      expect(() => formatOutput(name, 'value', 'EOF')).toThrow(
        'Invalid Action output name',
      );
    },
  );

  it('refuses a value that contains its delimiter', () => {
    expect(() => formatOutput('result', 'x\nEOF\ny', 'EOF')).toThrow(
      'The value of result contains its delimiter.',
    );
  });

  it('refuses a name that contains its delimiter', () => {
    expect(() => formatOutput('result', 'x', 'sul')).toThrow(
      'The value of result contains its delimiter.',
    );
  });
});

describe('appendText', () => {
  it('keeps writing until every byte is written', () => {
    const chunks: Buffer[] = [];
    const files: FileSystem = {
      ...nodeFiles,
      write: (_descriptor, bytes, offset) => {
        const end = Math.min(offset + 2, bytes.length);
        chunks.push(Buffer.from(bytes.subarray(offset, end)));
        return end - offset;
      },
    };
    appendText(files, 3, 'héllo');
    expect(Buffer.concat(chunks).toString('utf8')).toBe('héllo');
    expect(chunks).toHaveLength(3);
  });

  it('fails when a write makes no progress', () => {
    const files: FileSystem = { ...nodeFiles, write: () => 0 };
    expect(() => appendText(files, 3, 'x')).toThrow(
      'A write to an Action file stalled.',
    );
  });
});

describe('escapeCommandData', () => {
  it('escapes percent signs and line breaks', () => {
    expect(escapeCommandData('50%\r\n::error::x')).toBe(
      '50%25%0D%0A::error::x',
    );
  });
});

describe('runStub', () => {
  it('starts git in a private workspace under /tmp and reports a skip', () => {
    const { output, summary } = outputFiles();
    const identity = new FakeIdentity({ uid: runtimeId });
    const run = recordingRunner(identity);
    const files = scratchFiles();
    const channels = openChannels(files, {
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    });
    runStub(
      {
        inputs: new Map(),
        channels,
        redactor: { redact: (value) => value, redactText: (text) => text },
      },
      { ...system({ identity }), files, run },
    );
    closeChannels(files, channels);

    expect(files.prefixes).toEqual(['/tmp/prismatic-']);
    expect(run.calls).toHaveLength(1);
    const [call] = run.calls;
    const workspace = path.dirname(call?.environment.HOME ?? '');
    expect(call?.command).toBe(gitBinary);
    expect(call?.args).toEqual([
      ...gitSafetyOptions,
      'init',
      '--quiet',
      '--bare',
      '--template=',
      path.join(workspace, 'objects.git'),
    ]);
    expect(call?.environment).toEqual(
      gitEnvironment(path.join(workspace, 'home')),
    );
    expect(parseGitHubOutput(readFileSync(output, 'utf8'))).toEqual(
      new Map([
        ['result', 'skipped'],
        ['skip-reason', 'unsupported-event'],
      ]),
    );
    expect(readFileSync(summary, 'utf8')).toContain('Prismatic skipped');
  });

  it('writes nothing when no Action files are open', () => {
    const identity = new FakeIdentity({ uid: runtimeId });
    const run = recordingRunner(identity);
    expect(() =>
      runStub(
        {
          inputs: new Map(),
          channels: { output: undefined, summary: undefined },
          redactor: { redact: (value) => value, redactText: (text) => text },
        },
        { ...system({ identity }), run },
      ),
    ).not.toThrow();
    expect(run.calls).toHaveLength(1);
  });

  it('fails when git cannot start', () => {
    const identity = new FakeIdentity({ uid: runtimeId });
    const error = Object.assign(new Error('spawn git ENOENT'), {
      code: 'ENOENT',
    });
    const run = recordingRunner(identity, { status: null, error, stderr: '' });
    expect(
      thrown(() =>
        runStub(
          {
            inputs: new Map(),
            channels: { output: undefined, summary: undefined },
            redactor: { redact: (value) => value, redactText: (text) => text },
          },
          { ...system({ identity }), run },
        ),
      ),
    ).toMatchObject({ message: 'git could not start.', cause: error });
  });

  it('fails when git exits with an error', () => {
    const identity = new FakeIdentity({ uid: runtimeId });
    const run = recordingRunner(identity, { status: 128, stderr: 'fatal' });
    expect(() =>
      runStub(
        {
          inputs: new Map(),
          channels: { output: undefined, summary: undefined },
          redactor: { redact: (value) => value, redactText: (text) => text },
        },
        { ...system({ identity }), run },
      ),
    ).toThrow('git init exited with status 128: fatal');
  });
});

describe('runEntrypoint', () => {
  it('opens the Action files as root, then drops root before the bootstrap', () => {
    const { output, summary } = outputFiles();
    const identity = new FakeIdentity({});
    const events: string[] = [];
    const base = system({
      identity,
      environment: {
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        INPUT_MODEL: 'gpt',
      },
    });
    const files: FileSystem = {
      ...base.files,
      open: (target, flags) => {
        events.push(`open as ${identity.geteuid()}`);
        return base.files.open(target, flags);
      },
    };
    const code = runEntrypoint({ ...base, files }, (invocation, current) => {
      events.push(`bootstrap as ${identity.geteuid()}`);
      expect(invocation.inputs.get('model')).toBe('gpt');
      runStub(invocation, current);
    });

    expect(code).toBe(0);
    expect(events).toEqual([
      'open as 0',
      'open as 0',
      `bootstrap as ${runtimeId}`,
    ]);
    const run = base.run as ReturnType<typeof recordingRunner>;
    expect(run.calls.map((call) => call.euid)).toEqual([runtimeId]);
    expect(parseGitHubOutput(readFileSync(output, 'utf8')).get('result')).toBe(
      'skipped',
    );
    expect(base.lines).toEqual([]);
  });

  it('closes the Action files after the run', () => {
    const { output, summary } = outputFiles();
    const base = system({
      environment: { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    });
    expect(runEntrypoint(base, () => undefined)).toBe(0);
    const files = base.files as ReturnType<typeof scratchFiles>;
    expect(files.closed).toEqual(files.opened);
  });

  it('runs the stub by default', () => {
    const base = system();
    expect(runEntrypoint(base)).toBe(0);
    expect((base.run as ReturnType<typeof recordingRunner>).calls).toHaveLength(
      1,
    );
  });

  it('never runs the bootstrap when the drop fails', () => {
    const { output } = outputFiles();
    const identity = new FakeIdentity({}, { ignoreSetuid: true });
    const base = system({ identity, environment: { GITHUB_OUTPUT: output } });
    let ran = false;
    const code = runEntrypoint(base, () => {
      ran = true;
    });
    expect(code).toBe(1);
    expect(ran).toBe(false);
    expect(base.lines).toEqual([
      '::error::The entrypoint still holds a root user or group ID.',
    ]);
    expect(parseGitHubOutput(readFileSync(output, 'utf8'))).toEqual(
      new Map([
        ['result', 'failed'],
        ['failure-reason', 'internal'],
      ]),
    );
  });

  it('reports a failure to open the Action files', () => {
    const base = system({ environment: { GITHUB_OUTPUT: 'relative' } });
    expect(runEntrypoint(base, () => undefined)).toBe(1);
    expect(base.lines).toEqual([
      '::error::GITHUB_OUTPUT must be an absolute path.',
    ]);
  });

  it('masks secret inputs in the error line', () => {
    const token = 'not-a-real-token-value-1234';
    const base = system({ environment: { 'INPUT_GITHUB-TOKEN': token } });
    const code = runEntrypoint(base, () => {
      throw new Error(`request failed with ${token}`);
    });
    expect(code).toBe(1);
    expect(base.lines.join('\n')).not.toContain(token);
    expect(base.lines[0]).toMatch(/^::error::request failed with /);
  });

  it('still exits with 1 when the failure outputs cannot be written', () => {
    const { output } = outputFiles();
    const base = system({ environment: { GITHUB_OUTPUT: output } });
    const files: FileSystem = { ...base.files, write: () => 0 };
    const code = runEntrypoint({ ...base, files }, () => {
      throw new Error('boom');
    });
    expect(code).toBe(1);
    expect(base.lines).toEqual(['::error::boom']);
  });
});

describe('the Node.js system', () => {
  it('reads the identity of the current process', () => {
    const { identity } = nodeSystem();
    expect(identity.getuid()).toBe(process.getuid?.());
    expect(identity.geteuid()).toBe(process.geteuid?.());
    expect(identity.getgid()).toBe(process.getgid?.());
    expect(identity.getegid()).toBe(process.getegid?.());
    expect(identity.getgroups()).toEqual(process.getgroups?.());
  });

  it.runIf(process.geteuid?.() !== 0)(
    'cannot take root without privileges',
    () => {
      const { identity } = nodeSystem();
      expect(() => identity.setuid(0)).toThrow();
      expect(() => identity.setgid(0)).toThrow();
      expect(() => identity.setgroups([0])).toThrow();
    },
  );

  it('creates directories only their owner can use', () => {
    const directory = nodeFiles.makeTempDirectory(
      path.join(scratch, 'private-'),
    );
    const child = path.join(directory, 'home');
    nodeFiles.makeDirectory(child, 0o700);
    expect(path.basename(directory)).toMatch(/^private-/);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(child).mode & 0o777).toBe(0o700);
  });

  it('logs one line to standard output', () => {
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      nodeSystem().log('hello');
    } finally {
      process.stdout.write = write;
    }
    expect(lines).toEqual(['hello\n']);
  });

  it('runs a program with exactly the given environment and no shell', () => {
    const result = runProcess(
      process.execPath,
      [
        '-e',
        'process.stderr.write(JSON.stringify([process.env, process.argv[1]]))',
        '$(echo injected); echo injected',
      ],
      { ONLY: 'this' },
    );
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    const [environment, argument] = JSON.parse(result.stderr) as [
      Record<string, string>,
      string,
    ];
    expect(environment.ONLY).toBe('this');
    expect(environment).not.toHaveProperty('HOME');
    expect(argument).toBe('$(echo injected); echo injected');
  });

  it('reports a program that cannot start', () => {
    const result = runProcess(path.join(scratch, 'missing'), [], {});
    expect(result.status).toBeNull();
    expect(result.error).toMatchObject({ code: 'ENOENT' });
    expect(result.stderr).toBe('');
  });
});
