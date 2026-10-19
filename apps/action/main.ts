// The Docker Action entrypoint. GitHub starts container actions as root, so
// this file does the few things that need root, then gives root up for good
// before any child process starts (docker/runtime-policy.md):
//
// 1. It reads the Action inputs from the environment.
// 2. It opens GITHUB_OUTPUT and GITHUB_STEP_SUMMARY for appending. They live
//    on a runner-owned mount that the unprivileged user may not be allowed to
//    write, so the run keeps these descriptors and never reopens the paths.
// 3. It drops to the image's unprivileged user and checks that root cannot be
//    restored.
//
// The review pipeline does not exist yet. Until ActionBootstrap replaces it,
// a stub creates the run's private workspace under the container's /tmp,
// starts the first git process there, and reports the run as skipped.
//
// eslint.config.mjs allows this file, and no other outside the adapters, to
// import node:fs for the descriptor work and node:child_process for the stub.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeError } from '../../src/shared/errors.ts';
import {
  createSecretRedactor,
  patternSecretRedactor,
  type SecretRedactor,
} from '../../src/shared/redaction.ts';

// The unprivileged user the Dockerfile creates.
export const runtimeUser = 'prismatic';

export const gitBinary = '/usr/local/bin/git';

// The run's workspace lives under the container's own /tmp. TMPDIR and
// RUNNER_TEMP are ignored on purpose: on a runner they can name host mounts
// that belong to root.
export const workspaceParent = '/tmp';

// Inputs whose values are credentials. Their values are masked in anything
// this file logs or writes.
export const secretInputs = ['github-token', 'openai-api-key'] as const;

// The environment and options every git process gets, as
// docker/runtime-policy.md lists them: no system or global configuration, no prompts, no lazy fetches, and no
// hooks, external diff programs, credential helpers, submodules, or
// transports other than HTTPS.
export function gitEnvironment(home: string): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    HOME: home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
  };
}

export const gitSafetyOptions: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.external=',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'submodule.recurse=false',
  '-c',
  'credential.helper=',
];

export type Environment = Readonly<Record<string, string | undefined>>;

// Action inputs by name. GitHub passes each `with:` value as an
// INPUT_<NAME> environment variable with the name in upper case.
export type ActionInputs = ReadonlyMap<string, string>;

// Descriptors opened as root. Undefined when the variable is unset, as in a
// local run outside GitHub Actions.
export interface OutputChannels {
  readonly output: number | undefined;
  readonly summary: number | undefined;
}

export interface ActionInvocation {
  readonly inputs: ActionInputs;
  readonly channels: OutputChannels;
  readonly redactor: SecretRedactor;
}

// The user and group calls the privilege drop needs, so tests can run it
// without root.
export interface ProcessIdentity {
  getuid(): number;
  geteuid(): number;
  getgid(): number;
  getegid(): number;
  getgroups(): number[];
  setgroups(groups: readonly number[]): void;
  setgid(id: number | string): void;
  setuid(id: number | string): void;
}

export interface FileSystem {
  open(target: string, flags: number): number;
  isRegularFile(descriptor: number): boolean;
  // Writes bytes from `offset` to the end and returns how many were written.
  write(descriptor: number, bytes: Uint8Array, offset: number): number;
  close(descriptor: number): void;
  // Creates a new directory, readable only by its owner, whose name starts
  // with `prefix`, and returns its path.
  makeTempDirectory(prefix: string): string;
  makeDirectory(target: string, mode: number): void;
}

export interface ProcessResult {
  readonly status: number | null;
  readonly error?: Error;
  readonly stderr: string;
}

// Runs a program without a shell, with exactly the given environment.
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
) => ProcessResult;

export interface EntrypointSystem {
  readonly environment: Environment;
  readonly identity: ProcessIdentity;
  readonly files: FileSystem;
  readonly run: ProcessRunner;
  // Writes one line to standard output, where the runner reads workflow
  // commands such as `::error::`.
  readonly log: (line: string) => void;
}

export type Bootstrap = (
  invocation: ActionInvocation,
  system: EntrypointSystem,
) => void;

export function readActionInputs(environment: Environment): ActionInputs {
  const inputs = new Map<string, string>();
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith('INPUT_') && value !== undefined)
      inputs.set(key.slice('INPUT_'.length).toLowerCase(), value);
  }
  return inputs;
}

// O_NOFOLLOW refuses a symbolic link and O_NONBLOCK keeps a FIFO from
// blocking the open. There is no O_CREAT: the runner creates both files, and
// a file this process created on a host mount would belong to root.
const appendFlags =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

export function openAppendChannel(
  files: FileSystem,
  environment: Environment,
  variable: string,
): number | undefined {
  const target = environment[variable];
  if (target === undefined || target === '') return undefined;
  if (!path.isAbsolute(target))
    throw new Error(`${variable} must be an absolute path.`);
  const descriptor = files.open(target, appendFlags);
  try {
    if (!files.isRegularFile(descriptor))
      throw new Error(`${variable} must name a regular file.`);
  } catch (error) {
    files.close(descriptor);
    throw error;
  }
  return descriptor;
}

export function openChannels(
  files: FileSystem,
  environment: Environment,
): OutputChannels {
  const output = openAppendChannel(files, environment, 'GITHUB_OUTPUT');
  try {
    const summary = openAppendChannel(
      files,
      environment,
      'GITHUB_STEP_SUMMARY',
    );
    return { output, summary };
  } catch (error) {
    if (output !== undefined) files.close(output);
    throw error;
  }
}

export function closeChannels(
  files: FileSystem,
  channels: OutputChannels,
): void {
  for (const descriptor of [channels.output, channels.summary])
    if (descriptor !== undefined) files.close(descriptor);
}

// Drops from root to `user` and proves the drop. A process that started
// without root keeps its identity, as long as no user or group ID it holds is
// root. Throws when any ID is still 0 afterwards or when root can be restored.
export function dropPrivileges(
  identity: ProcessIdentity,
  user: string = runtimeUser,
): void {
  if (identity.geteuid() === 0) {
    // Supplementary groups first, then the group, then the user: once the
    // user ID changes, the process can no longer change its groups.
    identity.setgroups([]);
    identity.setgid(user);
    identity.setuid(user);
  }
  const ids = [
    identity.getuid(),
    identity.geteuid(),
    identity.getgid(),
    identity.getegid(),
    ...identity.getgroups(),
  ];
  if (ids.includes(0))
    throw new Error('The entrypoint still holds a root user or group ID.');
  for (const restore of [identity.setgid, identity.setuid]) {
    let restored = true;
    try {
      restore.call(identity, 0);
    } catch {
      restored = false;
    }
    if (restored)
      throw new Error('The entrypoint could restore root after dropping it.');
  }
}

const outputName = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// One Action output in the runner's multi-line form. The random delimiter
// means a value cannot end its own entry early and add another output.
export function formatOutput(
  name: string,
  value: string,
  delimiter: string = `ghadelimiter_${randomUUID()}`,
): string {
  if (!outputName.test(name))
    throw new Error(`Invalid Action output name ${JSON.stringify(name)}.`);
  if (name.includes(delimiter) || value.includes(delimiter))
    throw new Error(`The value of ${name} contains its delimiter.`);
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

export function appendText(
  files: FileSystem,
  descriptor: number,
  text: string,
): void {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = files.write(descriptor, bytes, offset);
    if (written <= 0) throw new Error('A write to an Action file stalled.');
    offset += written;
  }
}

export function writeOutput(
  files: FileSystem,
  channels: OutputChannels,
  name: string,
  value: string,
): void {
  if (channels.output !== undefined)
    appendText(files, channels.output, formatOutput(name, value));
}

export function writeSummary(
  files: FileSystem,
  channels: OutputChannels,
  markdown: string,
): void {
  if (channels.summary !== undefined)
    appendText(files, channels.summary, markdown);
}

// Escapes text for a workflow command, so a message cannot end the command
// line and start another one.
export function escapeCommandData(text: string): string {
  return text
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

// The placeholder bootstrap. It runs after the privilege drop: it creates
// the run's workspace, starts git there with the normative environment, and
// reports the run as skipped, because no event is supported yet.
export const runStub: Bootstrap = ({ channels }, { files, run }) => {
  const workspace = files.makeTempDirectory(
    path.join(workspaceParent, 'prismatic-'),
  );
  const home = path.join(workspace, 'home');
  files.makeDirectory(home, 0o700);
  const result = run(
    gitBinary,
    [
      ...gitSafetyOptions,
      'init',
      '--quiet',
      '--bare',
      '--template=',
      path.join(workspace, 'objects.git'),
    ],
    gitEnvironment(home),
  );
  if (result.error !== undefined)
    throw new Error('git could not start.', { cause: result.error });
  if (result.status !== 0)
    throw new Error(
      `git init exited with status ${String(result.status)}: ${result.stderr}`,
    );
  writeOutput(files, channels, 'result', 'skipped');
  writeOutput(files, channels, 'skip-reason', 'unsupported-event');
  writeSummary(
    files,
    channels,
    'Prismatic skipped this run: the review pipeline is not built yet.\n',
  );
};

// Runs the entrypoint and returns the process exit code: 0 after the
// bootstrap finishes, 1 after any failure. A failure is reported as one
// `::error::` line with secrets masked and, when GITHUB_OUTPUT is open, as
// `result: failed`.
export function runEntrypoint(
  system: EntrypointSystem,
  bootstrap: Bootstrap = runStub,
): number {
  let redactor: SecretRedactor = patternSecretRedactor;
  let channels: OutputChannels = { output: undefined, summary: undefined };
  try {
    const inputs = readActionInputs(system.environment);
    redactor = createSecretRedactor(
      secretInputs.flatMap((name) => inputs.get(name) ?? []),
    );
    channels = openChannels(system.files, system.environment);
    dropPrivileges(system.identity);
    bootstrap({ inputs, channels, redactor }, system);
    return 0;
  } catch (error) {
    const failure = normalizeError(error, redactor);
    system.log(`::error::${escapeCommandData(failure.message)}`);
    try {
      writeOutput(system.files, channels, 'result', 'failed');
      writeOutput(system.files, channels, 'failure-reason', 'internal');
    } catch {
      // The error line above already reports the failure.
    }
    return 1;
  } finally {
    closeChannels(system.files, channels);
  }
}

function posixIdentity(): ProcessIdentity {
  const {
    getuid,
    geteuid,
    getgid,
    getegid,
    getgroups,
    setgroups,
    setgid,
    setuid,
  } = process;
  if (
    !getuid ||
    !geteuid ||
    !getgid ||
    !getegid ||
    !getgroups ||
    !setgroups ||
    !setgid ||
    !setuid
  )
    throw new Error('The Action entrypoint needs POSIX user and group IDs.');
  return {
    getuid: () => getuid.call(process),
    geteuid: () => geteuid.call(process),
    getgid: () => getgid.call(process),
    getegid: () => getegid.call(process),
    getgroups: () => getgroups.call(process),
    setgroups: (groups) => setgroups.call(process, groups),
    setgid: (id) => setgid.call(process, id),
    setuid: (id) => setuid.call(process, id),
  };
}

export const nodeFiles: FileSystem = {
  open: (target, flags) => openSync(target, flags),
  isRegularFile: (descriptor) => fstatSync(descriptor).isFile(),
  write: (descriptor, bytes, offset) =>
    writeSync(descriptor, bytes, offset, bytes.length - offset),
  close: (descriptor) => closeSync(descriptor),
  makeTempDirectory: (prefix) => mkdtempSync(prefix),
  makeDirectory: (target, mode) => mkdirSync(target, { mode }),
};

const processTimeoutMs = 30_000;
const maxProcessOutputBytes = 64 * 1024;

export const runProcess: ProcessRunner = (command, args, environment) => {
  const result = spawnSync(command, args, {
    env: environment,
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: processTimeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: maxProcessOutputBytes,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    // Null when the process could not start.
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

export function nodeSystem(): EntrypointSystem {
  return {
    environment: process.env,
    identity: posixIdentity(),
    files: nodeFiles,
    run: runProcess,
    log: (line) => process.stdout.write(`${line}\n`),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = runEntrypoint(nodeSystem());
