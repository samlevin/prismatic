// Runs code under test against one adversarial scenario, through an
// instrumented fake filesystem and process runner, and then checks what it
// did. The subject runs once, on the first assertion; a subject that rejects
// hostile input by throwing is allowed, and the assertions still judge what
// it touched before it stopped.
import { resolveTrees } from './fixtures/security/history.ts';
import { buildRepository } from './fixtures/security/repositoryObjects.ts';
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
import { executionProblems, gitReadPaths } from './processChecks.ts';

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
  // Commit ID of the mounted revision, for subjects that read through Git.
  readonly revision: string;
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

const quote = (value: string): string => JSON.stringify(value);

export class SecurityScenarioRunner {
  readonly #scenario: SecurityScenario;
  readonly #subject: ScenarioSubject;
  readonly #revision: string;
  // Every name Git accepts for the mounted revision: its label, commit ID,
  // the refs that point at it, and HEAD when the default branch does.
  readonly #revisionNames: ReadonlySet<string>;
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
    const label = options.revision ?? scenario.pullRequest.head;
    const tree = resolveTrees(scenario.repository).get(label);
    if (tree === undefined) {
      throw new Error(
        `Scenario ${scenario.id} has no commit labeled ${label}.`,
      );
    }
    const built = buildRepository(scenario.repository);
    this.#revision = built.commits[label] ?? '';
    const names = new Set([label, this.#revision]);
    for (const [ref, id] of Object.entries(built.refs)) {
      if (id !== this.#revision) continue;
      names.add(ref);
      names.add(ref.replace(/^refs\/(?:heads\/)?/, ''));
      if (ref === `refs/heads/${built.defaultBranch}`) names.add('HEAD');
    }
    this.#revisionNames = names;
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

  // Fails when the subject read the contents of any of these paths, or tried
  // to: through the filesystem, directly or through a symlink, or through
  // Git at the mounted revision, as a `<rev>:<path>` argument or input line
  // or a pathspec of a content command such as `git diff` or `git grep`.
  // Repository paths are relative to the mounted revision; absolute paths
  // name host files. A directory covers everything below it, and a Git
  // pathspec covers everything below it. Metadata calls such as lstat, and
  // Git commands limited to names, are not reads.
  async assertNeverReads(paths: string[]): Promise<void> {
    const forbidden = paths.map((path) => {
      if (path.length === 0) throw new Error('A forbidden path is empty.');
      return lexicalPath(path, repositoryRoot);
    });
    const below = (path: string, directory: string): boolean =>
      path === directory ||
      path.startsWith(directory === '/' ? '/' : `${directory}/`);
    const covered = (path: string | null): string | undefined =>
      path === null ? undefined : forbidden.find((item) => below(path, item));
    const { accesses, requests } = await this.run();
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
    for (const request of requests) {
      for (const path of gitReadPaths(request, this.#revisionNames)) {
        const absolute = lexicalPath(path, repositoryRoot);
        const hit =
          covered(absolute) ?? forbidden.find((item) => below(item, absolute));
        if (hit === undefined) continue;
        violations.push(
          `${quote(request.command)} ${quote(request.args.join(' '))} reads forbidden ${quote(hit)} at the mounted revision`,
        );
      }
    }
    this.#throwIf(violations);
  }

  // Fails when the subject asked for anything that could run code the
  // repository controls: a shell, an executable outside the trusted list, a
  // working directory, Git directory, or configuration location inside the
  // repository tree, a repository name that Git would parse as an option, a
  // Git option or setting that names a program or loads configuration, or a
  // planted canary command outside a path argument.
  async assertNeverExecutes(): Promise<void> {
    const { requests } = await this.run();
    const context = {
      root: repositoryRoot,
      trustedExecutables: this.#trustedExecutables,
      repositoryPaths: this.#repositoryPaths(),
      canaries: this.#scenario.expectations.executionCanaries,
    };
    const violations = requests.flatMap((request) =>
      executionProblems(request, context).map(
        (problem) =>
          `${quote(request.command)} ${quote(request.args.join(' '))}: ${problem}`,
      ),
    );
    this.#throwIf(violations);
  }

  async #execute(): Promise<ScenarioRun> {
    let error: unknown;
    try {
      await this.#subject({
        scenario: this.#scenario,
        root: repositoryRoot,
        revision: this.#revision,
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
