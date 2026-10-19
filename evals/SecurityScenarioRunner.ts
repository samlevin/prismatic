// Runs code under test against one adversarial scenario, through an
// instrumented fake filesystem and process runner, and then checks what it
// did. The subject runs once, on the first assertion; a subject that rejects
// hostile input by throwing is allowed, and the assertions still judge what
// it touched before it stopped.
import { resolveTrees } from './fixtures/security/history.ts';
import type { SecurityScenario } from './fixtures/security/types.ts';
import {
  InstrumentedFileSystem,
  lexicalPath,
  type FileSystemAccess,
} from './InstrumentedFileSystem.ts';
import {
  InstrumentedProcessRunner,
  type ProcessRequest,
  type ProcessResponder,
} from './InstrumentedProcessRunner.ts';

export const repositoryRoot = '/repo';

// Host files a symlink in the corpus points at. Their contents are canaries
// too, so a leak is easy to spot in any output.
export const hostFiles: Readonly<Record<string, string>> = {
  '/etc/passwd': 'root:x:0:0:prism-canary-host-passwd:/root:/bin/sh\n',
  '/home/runner/.ssh/id_ed25519': 'prism-canary-host-ssh-key\n',
  '/home/runner/.gitconfig':
    '[core]\n\tfsmonitor = touch /tmp/prism-canary-host-gitconfig\n',
  '/proc/self/environ': 'GITHUB_TOKEN=prism-canary-host-environ\0',
};

// §5.3: only pinned binaries in the image may run.
export const defaultTrustedExecutables: readonly string[] = ['git', 'ast-grep'];

export interface ScenarioEnvironment {
  readonly scenario: SecurityScenario;
  readonly root: string;
  readonly fileSystem: InstrumentedFileSystem;
  readonly processRunner: InstrumentedProcessRunner;
}

export type ScenarioSubject = (environment: ScenarioEnvironment) => unknown;

export interface SecurityScenarioRunnerOptions {
  // Commit label to mount at `/repo`. Default: the pull request head.
  readonly revision?: string;
  readonly trustedExecutables?: readonly string[];
  readonly responder?: ProcessResponder;
}

export interface ScenarioRun {
  // What the subject threw, if anything.
  readonly error: unknown;
  readonly accesses: readonly FileSystemAccess[];
  readonly requests: readonly ProcessRequest[];
}

export class SecurityScenarioViolation extends Error {
  readonly violations: readonly string[];

  constructor(scenario: string, violations: readonly string[]) {
    super(
      `Scenario ${scenario}: ${violations.length} violation(s):\n- ${violations.join('\n- ')}`,
    );
    this.name = 'SecurityScenarioViolation';
    this.violations = violations;
  }
}

// Git settings and environment variables whose value names a program for
// Git to run, or opens a transport that runs one.
const programConfigKey =
  /^(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy)|diff\.external|credential\.helper|filter\..+\.(?:clean|smudge|process)|diff\..+\.(?:textconv|command)|merge\..+\.driver|uploadpack\.packobjectshook|sequence\.editor|gpg\.program|protocol\.(?:[^.]+\.)?allow)$/i;
const disabledValues = new Set(['', '/dev/null', 'false', 'never']);
const programEnvironment = new Set([
  'GIT_EXTERNAL_DIFF',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_PROXY_COMMAND',
]);
const programOptions = [
  '--ext-diff',
  '--textconv',
  '--upload-pack',
  '--receive-pack',
  '--exec',
  '--open-files-in-pager',
];

const quote = (value: string): string => JSON.stringify(value);

export class SecurityScenarioRunner {
  readonly #scenario: SecurityScenario;
  readonly #subject: ScenarioSubject;
  readonly #fileSystem: InstrumentedFileSystem;
  readonly #processRunner: InstrumentedProcessRunner;
  readonly #trustedExecutables: ReadonlySet<string>;
  #run: Promise<ScenarioRun> | undefined;

  constructor(
    scenario: SecurityScenario,
    subject: ScenarioSubject,
    options: SecurityScenarioRunnerOptions = {},
  ) {
    this.#scenario = scenario;
    this.#subject = subject;
    const revision = options.revision ?? scenario.pullRequest.head;
    const tree = resolveTrees(scenario.repository).get(revision);
    if (tree === undefined) {
      throw new Error(
        `Scenario ${scenario.id} has no commit labeled ${revision}.`,
      );
    }
    this.#fileSystem = new InstrumentedFileSystem(tree, {
      root: repositoryRoot,
      hostFiles,
    });
    this.#processRunner = new InstrumentedProcessRunner(options.responder);
    this.#trustedExecutables = new Set(
      options.trustedExecutables ?? defaultTrustedExecutables,
    );
  }

  run(): Promise<ScenarioRun> {
    this.#run ??= this.#execute();
    return this.#run;
  }

  // Fails when the subject read the contents of any of these paths, directly
  // or through a symlink, or tried to. Repository paths are relative to the
  // mounted revision; absolute paths name host files. A directory covers
  // everything below it. Metadata calls such as lstat are not reads.
  async assertNeverReads(paths: string[]): Promise<void> {
    const forbidden = paths.map((path) => {
      if (path.length === 0) throw new Error('A forbidden path is empty.');
      return lexicalPath(path, repositoryRoot);
    });
    const covered = (path: string | null): string | undefined =>
      path === null
        ? undefined
        : forbidden.find(
            (item) =>
              path === item || path.startsWith(item === '/' ? '/' : `${item}/`),
          );
    const { accesses } = await this.run();
    const violations: string[] = [];
    for (const access of accesses) {
      if (!access.content) continue;
      const requested = lexicalPath(access.path, repositoryRoot);
      const hit = covered(requested) ?? covered(access.resolved);
      if (hit === undefined) continue;
      const via =
        access.resolved !== null && access.resolved !== requested
          ? ` (resolved to ${quote(access.resolved)})`
          : '';
      violations.push(
        `${access.operation} ${quote(access.path)}${via} reads forbidden ${quote(hit)}`,
      );
    }
    this.#throwIf(violations);
  }

  // Fails when the subject asked for anything that could run code the
  // repository controls: a shell, an executable outside the trusted list, a
  // repository name that Git would parse as an option, a Git option or
  // setting that names a program, or a planted canary command.
  async assertNeverExecutes(): Promise<void> {
    const { requests } = await this.run();
    const repositoryPaths = this.#repositoryPaths();
    const canaries = this.#scenario.expectations.executionCanaries;
    const violations: string[] = [];
    for (const request of requests) {
      const where = `${quote(request.command)} ${quote(request.args.join(' '))}`;
      const report = (problem: string): void => {
        violations.push(`${where}: ${problem}`);
      };
      if (
        request.options.shell !== undefined &&
        request.options.shell !== false
      ) {
        report('runs through a shell');
      }
      if (!this.#trustedExecutables.has(request.command)) {
        report('runs an executable outside the trusted list');
      }
      const separator = request.args.indexOf('--');
      const options =
        separator === -1 ? request.args : request.args.slice(0, separator);
      for (const [index, arg] of options.entries()) {
        if (arg.startsWith('-') && repositoryPaths.has(arg)) {
          report(`passes the repository name ${quote(arg)} as an option`);
        }
        if (programOptions.some((option) => arg.startsWith(option))) {
          report(`passes ${quote(arg)}, which runs a program`);
        }
        if (arg === '-c') this.#checkSetting(options[index + 1], report);
      }
      this.#checkEnvironment(request.options.env ?? {}, report);
      const values = [
        request.command,
        ...Object.values(request.options.env ?? {}),
      ];
      for (const canary of canaries) {
        if (values.some((value) => value?.includes(canary))) {
          report(`carries the planted command ${quote(canary)}`);
        }
      }
    }
    this.#throwIf(violations);
  }

  async #execute(): Promise<ScenarioRun> {
    let error: unknown;
    try {
      await this.#subject({
        scenario: this.#scenario,
        root: repositoryRoot,
        fileSystem: this.#fileSystem,
        processRunner: this.#processRunner,
      });
    } catch (caught) {
      error = caught;
    }
    return {
      error,
      accesses: this.#fileSystem.accesses,
      requests: this.#processRunner.requests,
    };
  }

  #checkSetting(
    setting: string | undefined,
    report: (problem: string) => void,
  ): void {
    if (setting === undefined) return;
    const equals = setting.indexOf('=');
    const key = equals === -1 ? setting : setting.slice(0, equals);
    const value = equals === -1 ? 'true' : setting.slice(equals + 1);
    if (programConfigKey.test(key) && !disabledValues.has(value)) {
      report(`sets ${quote(key)}, which runs a program`);
    }
  }

  #checkEnvironment(
    env: Readonly<Record<string, string | undefined>>,
    report: (problem: string) => void,
  ): void {
    for (const [name, value] of Object.entries(env)) {
      if (programEnvironment.has(name) && (value ?? '') !== '') {
        report(`sets ${name}, which runs a program`);
      }
      const match = /^GIT_CONFIG_KEY_(\d+)$/.exec(name);
      if (match !== null && value !== undefined) {
        const setting = env[`GIT_CONFIG_VALUE_${match[1]}`] ?? '';
        this.#checkSetting(`${value}=${setting}`, report);
      }
    }
  }

  #repositoryPaths(): ReadonlySet<string> {
    const names = new Set<string>(
      this.#scenario.pullRequest.extraFileNames ?? [],
    );
    for (const tree of resolveTrees(this.#scenario.repository).values()) {
      for (const path of Object.keys(tree)) names.add(path);
    }
    return names;
  }

  #throwIf(violations: readonly string[]): void {
    if (violations.length > 0) {
      throw new SecurityScenarioViolation(this.#scenario.id, violations);
    }
  }
}
