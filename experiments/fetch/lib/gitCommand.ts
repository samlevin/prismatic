// The normative Git environment and `-c` options from spec §5.3, and a
// runner that applies them to every Git process the spike starts. The spike
// proves fetch behavior under exactly these settings, so nothing here may
// relax them; the two switches below exist only to measure what the policy
// costs, and every scenario that uses one says so in its record.
import type { ProcessResult, Spawner, SpawnInput } from './processRunner.ts';

export const normativeConfig: readonly string[] = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'diff.external=',
  'protocol.allow=never',
  'protocol.https.allow=always',
  'submodule.recurse=false',
  'credential.helper=',
];

// Local fixture remotes are file:// URLs, which `protocol.allow=never`
// refuses. The P1.1 runner exposes the same option only to its test harness.
export const fileProtocolConfig = 'protocol.file.allow=always';

export type LazyFetch = 'disabled' | 'enabled-for-this-process';

export interface GitEnvironmentOptions {
  readonly home: string;
  readonly lazyFetch?: LazyFetch;
}

export function gitEnvironment(
  options: GitEnvironmentOptions,
): Readonly<Record<string, string>> {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    HOME: options.home,
    GIT_TERMINAL_PROMPT: '0',
    // Git reads the variable as a boolean, so `0` turns lazy fetching back
    // on for the one process that asks for it.
    GIT_NO_LAZY_FETCH:
      options.lazyFetch === 'enabled-for-this-process' ? '0' : '1',
    // A fixed search path and locale, so output parsing never depends on the
    // caller's environment.
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LC_ALL: 'C',
  };
}

export function gitArguments(
  args: readonly string[],
  allowFileProtocol: boolean,
): string[] {
  const config = allowFileProtocol
    ? [...normativeConfig, fileProtocolConfig]
    : normativeConfig;
  return [...config.flatMap((entry) => ['-c', entry]), ...args];
}

export interface GitRunnerOptions {
  readonly gitPath: string;
  readonly home: string;
  readonly spawner: Spawner;
  readonly allowFileProtocol: boolean;
  readonly redactText: (text: string) => string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface GitRunOptions {
  readonly input?: SpawnInput;
  readonly lazyFetch?: LazyFetch;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

// One line per Git process, for the scenario record. The `-c` prefix is the
// same on every line, so the log keeps only the subcommand and its options.
export interface GitLogEntry {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly lazyFetch: LazyFetch;
  readonly status: number | null;
  readonly elapsedMs: number;
}

export class GitCommandError extends Error {
  readonly status: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], status: number | null, stderr: string) {
    super(
      `git ${args.join(' ')} exited with ${String(status)}: ${stderr.trim()}`,
    );
    this.name = 'GitCommandError';
    this.status = status;
    this.stderr = stderr;
  }
}

export const defaultGitTimeoutMs = 10 * 60 * 1000;
export const defaultGitMaxOutputBytes = 64 * 1024 * 1024;

export class GitRunner {
  readonly #options: GitRunnerOptions;
  readonly #log: GitLogEntry[] = [];

  constructor(options: GitRunnerOptions) {
    this.#options = options;
  }

  get log(): readonly GitLogEntry[] {
    return this.#log;
  }

  // Runs git and returns the result whatever the exit status. Stderr is
  // redacted before anything else can see it.
  async run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<ProcessResult> {
    const lazyFetch = options.lazyFetch ?? 'disabled';
    const result = await this.#options.spawner(
      this.#options.gitPath,
      gitArguments(args, this.#options.allowFileProtocol),
      {
        cwd,
        env: gitEnvironment({ home: this.#options.home, lazyFetch }),
        timeoutMs:
          options.timeoutMs ?? this.#options.timeoutMs ?? defaultGitTimeoutMs,
        maxOutputBytes:
          options.maxOutputBytes ??
          this.#options.maxOutputBytes ??
          defaultGitMaxOutputBytes,
        ...(options.input === undefined ? {} : { input: options.input }),
      },
    );
    const redacted = {
      ...result,
      stderr: this.#options.redactText(result.stderr),
    };
    this.#log.push({
      cwd,
      args: [...args],
      lazyFetch,
      status: result.status,
      elapsedMs: result.elapsedMs,
    });
    return redacted;
  }

  // Runs git and throws GitCommandError unless it exits with status 0.
  async ok(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<ProcessResult> {
    const result = await this.run(cwd, args, options);
    if (result.status !== 0 || result.truncated)
      throw new GitCommandError(args, result.status, result.stderr);
    return result;
  }
}
