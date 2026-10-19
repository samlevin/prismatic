// Resolves a fixture history into one full tree per commit, and compares two
// trees the way a review range does.
import type {
  FixtureEntry,
  FixtureRepository,
  FixtureTree,
  SecurityScenario,
} from './types.ts';

export function resolveTrees(
  repository: FixtureRepository,
): ReadonlyMap<string, FixtureTree> {
  const trees = new Map<string, FixtureTree>();
  for (const commit of repository.commits) {
    if (trees.has(commit.label)) {
      throw new Error(`Commit label ${commit.label} is used twice.`);
    }
    const [first] = commit.parents;
    for (const parent of commit.parents) {
      if (!trees.has(parent)) {
        throw new Error(
          `Commit ${commit.label} names unknown parent ${parent}.`,
        );
      }
    }
    const tree: Record<string, FixtureEntry> = {
      ...(first === undefined ? {} : trees.get(first)),
    };
    for (const [path, entry] of Object.entries(commit.changes)) {
      if (entry === null) delete tree[path];
      else tree[path] = entry;
    }
    trees.set(commit.label, tree);
  }
  return trees;
}

export function treeAt(
  repository: FixtureRepository,
  label: string,
): FixtureTree {
  const tree = resolveTrees(repository).get(label);
  if (tree === undefined) throw new Error(`Unknown commit label ${label}.`);
  return tree;
}

function sameEntry(a: FixtureEntry, b: FixtureEntry): boolean {
  if (a.kind === 'file' && b.kind === 'file') {
    return (
      (a.executable ?? false) === (b.executable ?? false) &&
      Buffer.from(a.content).equals(Buffer.from(b.content))
    );
  }
  if (a.kind === 'symlink' && b.kind === 'symlink') {
    return a.target === b.target;
  }
  if (a.kind === 'submodule' && b.kind === 'submodule') {
    return a.commit === b.commit;
  }
  return false;
}

export type ChangeStatus = 'added' | 'modified' | 'removed';

// Paths that differ between two trees, in code unit order.
export function diffTrees(
  from: FixtureTree,
  to: FixtureTree,
): readonly { readonly path: string; readonly status: ChangeStatus }[] {
  const paths = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
  const changes: { path: string; status: ChangeStatus }[] = [];
  for (const path of paths) {
    const before = from[path];
    const after = to[path];
    if (before === undefined) changes.push({ path, status: 'added' });
    else if (after === undefined) changes.push({ path, status: 'removed' });
    else if (!sameEntry(before, after))
      changes.push({ path, status: 'modified' });
  }
  return changes;
}

// The pull request's changes as a three-dot comparison: merge-base to head.
export function pullRequestChanges(
  scenario: SecurityScenario,
): ReturnType<typeof diffTrees> {
  const trees = resolveTrees(scenario.repository);
  const { mergeBase, head } = scenario.pullRequest;
  return diffTrees(
    trees.get(mergeBase) ?? missing(mergeBase),
    trees.get(head) ?? missing(head),
  );
}

function missing(label: string): never {
  throw new Error(`Unknown commit label ${label}.`);
}
