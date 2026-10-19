// Runs code under test against one adversarial scenario, through an
// instrumented fake filesystem and process runner, and then checks what it
// did. The subject runs once, on the first assertion; a subject that rejects
// hostile input by throwing is allowed, and the assertions still judge what
// it touched before it stopped.
import { resolveTrees } from './fixtures/security/history.ts';
import {
  buildRepository,
  treeObjects,
  type BuiltRepository,
} from './fixtures/security/repositoryObjects.ts';
import type {
  FixtureTree,
  SecurityScenario,
} from './fixtures/security/types.ts';
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
import {
  executionProblems,
  gitReadPaths,
  type MountedObject,
  type RevisionView,
} from './processChecks.ts';

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

// Names Git resolves in a built fixture repository: commit labels, commit
// IDs, refs in full and short forms, HEAD, and the IDs of the blobs and
// trees in the mounted tree. Names of the mounted commit map to it; names
// of other commits map to nothing.
function revisionNames(
  built: BuiltRepository,
  mounted: string,
  tree: FixtureTree,
): ReadonlyMap<string, readonly MountedObject[]> {
  const names = new Map<string, readonly MountedObject[]>();
  const name = (key: string, id: string): void => {
    // A name that could mean the mounted commit keeps that meaning.
    if ((names.get(key)?.length ?? 0) > 0) return;
    names.set(key, id === mounted ? [{ type: 'commit', path: '' }] : []);
  };
  for (const [label, id] of Object.entries(built.commits)) {
    name(label, id);
    name(id, id);
  }
  for (const [ref, id] of Object.entries(built.refs)) {
    name(ref, id);
    name(ref.slice('refs/'.length), id);
    name(ref.replace(/^refs\/(?:heads|tags|remotes)\//, ''), id);
  }
  name('HEAD', built.refs[`refs/heads/${built.defaultBranch}`] ?? '');
  for (const [id, object] of treeObjects(tree)) {
    names.set(
      id,
      object.paths.map((path) => ({ type: object.type, path })),
    );
  }
  return names;
}

export class SecurityScenarioRunner {
  readonly #scenario: SecurityScenario;
  readonly #subject: ScenarioSubject;
  readonly #revision: string;
  // Every name Git accepts for a commit in the scenario, and every object
  // ID in the mounted tree, with what each names in the mounted revision.
  readonly #revisionView: RevisionView;
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
    this.#revisionView = {
      names: revisionNames(built, this.#revision, tree),
      paths: new Set(Object.keys(tree)),
    };
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
  // Git in the mounted revision. Git reads count under any name Git
  // resolves to the revision or an object in it, including abbreviated IDs,
  // suffixes such as `~0` or `^{tree}`, and blob IDs: a `<rev>:<path>`
  // argument or input line, and a content command such as `git diff`,
  // `git grep`, or `git log -p`, which reads what its pathspecs cover, or
  // the whole tree when it has no positive pathspec. Repository paths are
  // relative to the mounted revision; absolute paths name host files. A
  // directory covers everything below it, and so does a Git pathspec.
  // Metadata calls such as lstat, and Git commands limited to names, are
  // not reads.
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
      for (const read of gitReadPaths(request, this.#revisionView)) {
        const absolute = lexicalPath(read.path, repositoryRoot);
        const excluded = read.excludes.map((path) =>
          lexicalPath(path, repositoryRoot),
        );
        // The read and a forbidden path overlap below the deeper of the
        // two, unless an exclusion pathspec covers that.
        const hit = forbidden.find((item) => {
          const overlap = below(absolute, item)
            ? absolute
            : below(item, absolute)
              ? item
              : undefined;
          return (
            overlap !== undefined &&
            !excluded.some((path) => below(overlap, path))
          );
        });
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
