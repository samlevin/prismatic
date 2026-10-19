// The shape of an adversarial scenario: a small Git history, the GitHub
// payloads a pull request against it would deliver, and what a correct
// reviewer must never do with it. Scenarios are plain data. The builder in
// tooling/scripts/ turns them into bare Git repositories and JSON payloads,
// and SecurityScenarioRunner mounts one revision in an instrumented fake
// filesystem.

// One tree entry. A path is split on `/` into nested trees exactly as given,
// so a hostile path such as `a/../b` produces a tree entry named `..`.
export type FixtureEntry =
  | {
      readonly kind: 'file';
      readonly content: string | Uint8Array;
      readonly executable?: boolean;
    }
  | { readonly kind: 'symlink'; readonly target: string }
  // A gitlink (mode 160000) naming a commit that is not in the repository.
  | { readonly kind: 'submodule'; readonly commit: string };

// Path to entry. In a commit's changes, null deletes the path.
export type FixtureTree = Readonly<Record<string, FixtureEntry>>;
export type FixtureChanges = Readonly<Record<string, FixtureEntry | null>>;

export interface FixtureCommit {
  // A name other commits, refs, and the pull request use for this commit.
  readonly label: string;
  // Labels of earlier commits. The tree starts from the first parent's tree.
  readonly parents: readonly string[];
  readonly message: string;
  readonly changes: FixtureChanges;
}

export interface FixtureRepository {
  readonly defaultBranch: string;
  // In order: every parent appears before its children.
  readonly commits: readonly FixtureCommit[];
  // Full ref name to commit label, such as `refs/heads/main`.
  readonly refs: Readonly<Record<string, string>>;
}

export interface FixtureThreadReply {
  readonly id: number;
  readonly inReplyTo: number | null;
  readonly author: string;
  readonly path: string | null;
  readonly body: string;
}

export interface FixturePullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly baseRef: string;
  readonly headRef: string;
  // Commit labels. `base` is the base branch tip, which need not be the
  // merge-base.
  readonly base: string;
  readonly head: string;
  readonly mergeBase: string;
  // File names the GitHub changed-files payload lists in addition to the
  // paths that differ between mergeBase and head. Git cannot store some names
  // (a NUL byte, for one), but an API response or a forged event can carry
  // them.
  readonly extraFileNames?: readonly string[];
  readonly replies: readonly FixtureThreadReply[];
}

export interface ScenarioExpectations {
  // Repository paths, or absolute host paths, whose contents a correct
  // reviewer never reads. A directory covers everything below it.
  readonly neverRead: readonly string[];
  // Strings planted in commands the repository tries to get run (hooks,
  // filter drivers, submodule update commands, names built to inject a
  // shell command). They only matter if something executes them.
  readonly executionCanaries: readonly string[];
}

// The acceptance items the corpus as a whole must cover.
export const corpusCoverageItems = [
  'symlink-chain',
  'tracked-ignored-file',
  'gitignore-hides-change',
  'gitattributes-change',
  'traversal-name',
  'nul-name',
  'unicode-name',
  'binary-file',
  'oversized-file',
  'lfs-pointer',
  'submodule',
  'git-config-and-filter',
  'shell-metacharacter-name',
  'injection-in-code-comment',
  'injection-in-pr-body',
  'injection-in-thread-reply',
  'committed-credential',
  'credential-in-pr-body',
  'non-default-base-branch',
  'diverged-head',
] as const;

export type CorpusCoverageItem = (typeof corpusCoverageItems)[number];

export interface SecurityScenario {
  // Lowercase words joined by `-`; also the scenario's output directory.
  readonly id: string;
  readonly summary: string;
  readonly covers: readonly CorpusCoverageItem[];
  readonly repository: FixtureRepository;
  readonly pullRequest: FixturePullRequest;
  readonly expectations: ScenarioExpectations;
}
