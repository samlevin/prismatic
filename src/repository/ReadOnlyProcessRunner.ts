// How the review starts a native process: one of the pinned binaries in the
// Action image, by absolute path, through `spawn` with `shell: false` and an
// argument array. The Action entrypoint's bootstrap stub, which runs
// `git init` before the review exists, is the one other caller of `spawn`
// until ActionBootstrap replaces it. Every run has a deadline and caps on
// captured stdout and stderr, and a breach kills the process group. A child
// never inherits this process's environment. Every `git` process gets exactly
// the normative environment and `-c` options of spec §5.3, and stderr is
// redacted before a caller can log it or put it in an error.
//
// Local fixture remotes need the file transport, which the normative options
// refuse. The switch that allows it belongs to the test harness, outside the
// directories production code may import, and nothing here can turn it on.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import type { SecretRedactor } from '../shared/redaction.ts';

// The pinned binaries the Dockerfile installs, from docker/binaries.lock.
// Nothing else is ever executed.
export const approvedBinaryPaths = Object.freeze({
  git: '/usr/local/bin/git',
  'ast-grep': '/usr/local/bin/ast-grep',
});

export type ApprovedBinary = keyof typeof approvedBinaryPaths;

// Spec §5.3: no hooks, no fsmonitor, no external diff program, no transport
// other than HTTPS, no submodule recursion, and no credential helper.
export const normativeGitConfig: readonly string[] = Object.freeze([
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'diff.external=',
  'protocol.allow=never',
  'protocol.https.allow=always',
  'submodule.recurse=false',
  'credential.helper=',
]);

// The options in front of every git subcommand, in order.
export const normativeGitArguments: readonly string[] = Object.freeze(
  normativeGitConfig.flatMap((entry) => ['-c', entry]),
);

// Spec §5.3: no system or global configuration, a HOME that holds nothing,
// no prompts, and no lazy fetch of a missing promisor object (Git 2.45 and
// later), so a read outside the backfilled scope fails instead of reaching
// the network. Nothing else, including PATH, reaches a git process.
export function gitEnvironment(home: string): Readonly<Record<string, string>> {
  return Object.freeze({
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    HOME: home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
  });
}

// ast-grep reads nothing from its environment that the run needs.
const astGrepEnvironment: Readonly<Record<string, string>> = Object.freeze({});

// Hard maxima. A caller may ask for less, never more, and must always say how
// much. The deadline matches the 22-minute application deadline (§5.4).
export const maxProcessTimeoutMs = 22 * 60 * 1000;
export const maxProcessOutputBytes = 64 * 1024 * 1024;
export const maxProcessInputBytes = 64 * 1024 * 1024;

// The limits and working directory of one run.
export interface ProcessLimits {
  // Absolute directory the process starts in.
  readonly cwd: string;
  // The process group is killed this long after the start.
  readonly timeoutMs: number;
  // Captured output beyond either cap kills the process group; the result
  // holds the bytes up to the cap.
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  // Written to the process's standard input, which is then closed, such as
  // the object names `git cat-file --batch` reads. Without it, standard
  // input is closed at once.
  readonly stdin?: string | Buffer;
}

// How a run ended. `exited` covers every end the runner did not cause,
// including a signal from elsewhere; the others name the limit that made the
// runner kill the process group.
export type ProcessTermination =
  'exited' | 'deadline' | 'stdout-limit' | 'stderr-limit';

export interface BinaryResult {
  readonly binary: ApprovedBinary;
  // Null when the process ended on a signal.
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly termination: ProcessTermination;
  readonly stdout: Buffer;
  // Decoded as UTF-8 and redacted.
  readonly stderr: string;
}

export type ProcessRunnerErrorCode =
  | 'unapproved-binary'
  | 'invalid-arguments'
  | 'invalid-limits'
  | 'invalid-configuration'
  | 'process-start-failed';

// Thrown for a request the runner refuses before anything starts, and for a
// process that could not start. The message never echoes the arguments.
export class ProcessRunnerError extends Error {
  readonly code: ProcessRunnerErrorCode;
  // The operating system's code, such as `ENOENT`, when a start failed.
  readonly systemCode?: string;

  constructor(
    code: ProcessRunnerErrorCode,
    message: string,
    systemCode?: string,
  ) {
    super(message);
    this.name = 'ProcessRunnerError';
    this.code = code;
    if (systemCode !== undefined) this.systemCode = systemCode;
  }
}

// One process start, after the runner has applied its policy. The spawner is
// the seam for tests; production uses nodeProcessSpawner.
export interface SpawnRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly stdin?: string | Buffer;
}

export interface SpawnOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly termination: ProcessTermination;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type ProcessSpawner = (request: SpawnRequest) => Promise<SpawnOutcome>;

export interface ReadOnlyProcessRunnerDependencies {
  // An empty directory that only this run uses, given to git as HOME.
  readonly home: string;
  // The run's redactor, built at bootstrap with every secret it holds.
  readonly redactor: SecretRedactor;
  readonly spawner?: ProcessSpawner;
}

export class ReadOnlyProcessRunner {
  readonly #home: string;
  readonly #redactor: SecretRedactor;
  readonly #spawner: ProcessSpawner;

  constructor(dependencies: ReadOnlyProcessRunnerDependencies) {
    if (!isAbsoluteDirectory(dependencies.home))
      throw new ProcessRunnerError(
        'invalid-configuration',
        'The git home directory must be an absolute path without NUL bytes.',
      );
    this.#home = dependencies.home;
    this.#redactor = dependencies.redactor;
    this.#spawner = dependencies.spawner ?? nodeProcessSpawner;
  }

  // Runs an approved binary. `args` starts with the subcommand, such as
  // `cat-file` or `scan`. Options in front of it are refused, so a caller
  // cannot add configuration of its own, except the `-c` entries that
  // callerGitConfig allows for that git subcommand. Every argument reaches
  // the process exactly as given: no shell sees it, so `$(...)`, quotes,
  // globs, and `;` are plain characters. Callers still put paths after `--`
  // so that git never reads one as an option.
  async runBinary(
    binary: ApprovedBinary,
    args: readonly string[],
    opts: ProcessLimits,
  ): Promise<BinaryResult> {
    if (
      typeof binary !== 'string' ||
      !Object.hasOwn(approvedBinaryPaths, binary)
    )
      throw new ProcessRunnerError(
        'unapproved-binary',
        'Only git and ast-grep may run.',
      );
    checkArguments(binary, args);
    checkLimits(opts);
    const git = binary === 'git';
    const outcome = await this.#spawner({
      file: approvedBinaryPaths[binary],
      args: git ? [...normativeGitArguments, ...args] : [...args],
      cwd: opts.cwd,
      env: git ? gitEnvironment(this.#home) : astGrepEnvironment,
      timeoutMs: opts.timeoutMs,
      maxStdoutBytes: opts.maxStdoutBytes,
      maxStderrBytes: opts.maxStderrBytes,
      ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
    });
    return {
      binary,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      termination: outcome.termination,
      stdout: outcome.stdout,
      stderr: this.#redactor.redactText(
        completeLines(outcome.stderr.toString('utf8'), outcome.termination),
      ),
    };
  }
}

// A run the runner killed may end its stderr partway through a line, and a
// secret cut short there no longer matches the redactor's patterns. Such a
// run keeps only its complete lines; a private key block stays masked from
// its first line on.
function completeLines(text: string, termination: ProcessTermination): string {
  if (termination === 'exited') return text;
  return text.slice(0, text.lastIndexOf('\n') + 1);
}

// The only `-c` entries a caller may put in front of a git subcommand, keyed
// by that subcommand. A blob-ID fetch needs the noop negotiator: once a
// local ref names a commit, the default one makes the server leave out the
// blobs reachable from it (docs/adr/0004-blobless-fetch.md).
export const callerGitConfig: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    fetch: Object.freeze(['fetch.negotiationAlgorithm=noop']),
  });

const subcommand = /^[a-z][a-z0-9-]{0,63}$/;

function checkArguments(binary: ApprovedBinary, args: readonly string[]): void {
  if (!Array.isArray(args) || args.length === 0)
    throw new ProcessRunnerError(
      'invalid-arguments',
      'Arguments must be a non-empty array that starts with a subcommand.',
    );
  for (const arg of args as readonly unknown[]) {
    if (typeof arg !== 'string' || arg.includes('\0'))
      throw new ProcessRunnerError(
        'invalid-arguments',
        'Every argument must be a string without NUL bytes.',
      );
  }
  let index = 0;
  const config: string[] = [];
  while (binary === 'git' && args[index] === '-c') {
    config.push(args[index + 1] ?? '');
    index += 2;
  }
  const name = args[index];
  if (name === undefined || !subcommand.test(name))
    throw new ProcessRunnerError(
      'invalid-arguments',
      'The arguments must start with a subcommand name, not an option.',
    );
  const allowed = Object.hasOwn(callerGitConfig, name)
    ? callerGitConfig[name]
    : undefined;
  if (config.some((entry) => allowed?.includes(entry) !== true))
    throw new ProcessRunnerError(
      'invalid-arguments',
      'Only the git configuration the runner allows for this subcommand may be added.',
    );
}

function checkLimits(opts: ProcessLimits): void {
  if (typeof opts !== 'object' || opts === null)
    throw new ProcessRunnerError('invalid-limits', 'Limits are required.');
  if (!isAbsoluteDirectory(opts.cwd))
    throw new ProcessRunnerError(
      'invalid-limits',
      'The working directory must be an absolute path without NUL bytes.',
    );
  checkBound('timeoutMs', opts.timeoutMs, maxProcessTimeoutMs);
  checkBound('maxStdoutBytes', opts.maxStdoutBytes, maxProcessOutputBytes);
  checkBound('maxStderrBytes', opts.maxStderrBytes, maxProcessOutputBytes);
  const { stdin } = opts;
  if (stdin === undefined) return;
  if (typeof stdin !== 'string' && !Buffer.isBuffer(stdin))
    throw new ProcessRunnerError(
      'invalid-limits',
      'Standard input must be a string or a buffer.',
    );
  if (Buffer.byteLength(stdin) > maxProcessInputBytes)
    throw new ProcessRunnerError(
      'invalid-limits',
      `Standard input may hold at most ${String(maxProcessInputBytes)} bytes.`,
    );
}

function checkBound(name: string, value: unknown, maximum: number): void {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  )
    throw new ProcessRunnerError(
      'invalid-limits',
      `${name} must be a whole number from 1 to ${String(maximum)}.`,
    );
}

function isAbsoluteDirectory(value: unknown): value is string {
  return (
    typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
  );
}

// Keeps the first `limit` bytes and reports whether more arrived.
class Capture {
  readonly #chunks: Buffer[] = [];
  readonly #limit: number;
  #bytes = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  // False once the cap is passed.
  add(chunk: Buffer): boolean {
    const room = this.#limit - this.#bytes;
    if (chunk.length > room) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#bytes = this.#limit;
      return false;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    return true;
  }

  value(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

// Starts the process as the leader of its own process group, so a breach can
// kill it together with any helper it started, such as the transport and
// pack processes of `git fetch`. After the kill, the runner stops reading,
// so a descendant that left the group cannot hold the run open.
//
// Every way a start can fail ends as a ProcessRunnerError: an error `spawn`
// throws at once (such as ENOTDIR or E2BIG), one it emits on the next tick
// (such as ENOENT), and a child left without pipes (EMFILE or ENFILE). The
// raw error, which lists the arguments, never reaches the caller.
export const nodeProcessSpawner: ProcessSpawner = (request) =>
  new Promise<SpawnOutcome>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(request.file, [...request.args], {
        cwd: request.cwd,
        env: { ...request.env },
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(startFailure(error));
      return;
    }
    const {
      stdin,
      stdout: out,
      stderr: err,
    } = child as Partial<
      Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr'>
    >;
    if (stdin == null || out == null || err == null) {
      // Node returns a child without pipes when it runs out of descriptors
      // and reports the error on the next tick. This listener catches it, so
      // it cannot become an uncaught exception.
      child.on('error', () => undefined);
      child.kill('SIGKILL');
      reject(startFailure(undefined));
      return;
    }
    const stdout = new Capture(request.maxStdoutBytes);
    const stderr = new Capture(request.maxStderrBytes);
    let termination: ProcessTermination = 'exited';
    let settled = false;

    const stop = (reason: Exclude<ProcessTermination, 'exited'>): void => {
      if (termination !== 'exited') return;
      termination = reason;
      killGroup(child.pid as number, () => child.kill('SIGKILL'));
      out.destroy();
      err.destroy();
    };

    const timer = setTimeout(() => stop('deadline'), request.timeoutMs);
    // Listening in the same tick as the spawn, so an error Node reports on
    // the next tick (such as ENOENT) is always caught.
    child.on('error', (error) => {
      // After a start, an error here can only come from signalling a
      // process that has already gone; `close` still reports the result.
      if (settled || child.pid !== undefined) return;
      settled = true;
      clearTimeout(timer);
      reject(startFailure(error));
    });
    out.on('data', (chunk: Buffer) => {
      if (!stdout.add(chunk)) stop('stdout-limit');
    });
    err.on('data', (chunk: Buffer) => {
      if (!stderr.add(chunk)) stop('stderr-limit');
    });
    // A process that exits before reading all of its input closes the pipe;
    // its exit, not the write error, is the result.
    stdin.on('error', () => undefined);
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        termination,
        stdout: stdout.value(),
        stderr: stderr.value(),
      });
    });
    stdin.end(request.stdin);
  });

function startFailure(error: unknown): ProcessRunnerError {
  const code: unknown =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return new ProcessRunnerError(
    'process-start-failed',
    'The process could not start.',
    typeof code === 'string' ? code : undefined,
  );
}

// Kills the whole process group, falling back to the process alone when the
// group cannot be signalled. `stop` runs only after a start, so the process
// has an id.
function killGroup(pid: number, fallback: () => void): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}
