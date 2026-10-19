// Encodes a fixture history as Git objects without running Git. Objects are
// encoded byte for byte as Git stores them, with a fixed author, committer,
// and clock, so the same history always gets the same object IDs. Building
// objects directly also lets a fixture hold trees Git itself would refuse to
// create, such as an entry named `..` or `.git`, which is exactly what a
// hostile repository can push. tooling/scripts/fixtureRepository.ts writes
// the result to disk.
import { createHash } from 'node:crypto';
import { resolveTrees } from './history.ts';
import type { FixtureEntry, FixtureRepository, FixtureTree } from './types.ts';

export const fixtureIdentity =
  'Prismatic Fixtures <fixtures@prismatic.invalid>';
// 2026-01-01T00:00:00Z; commit n is n minutes later.
export const fixtureEpoch = 1_767_225_600;

export type ObjectType = 'blob' | 'tree' | 'commit';

export interface GitObject {
  readonly id: string;
  // The object as Git hashes it: header, NUL, body.
  readonly bytes: Buffer;
}

export function encodeObject(type: ObjectType, body: Uint8Array): GitObject {
  const bytes = Buffer.concat([
    Buffer.from(`${type} ${body.byteLength}\0`),
    body,
  ]);
  return { id: createHash('sha1').update(bytes).digest('hex'), bytes };
}

interface TreeNode {
  readonly entries: Map<string, TreeNode | FixtureEntry>;
}

const isTreeNode = (value: TreeNode | FixtureEntry): value is TreeNode =>
  'entries' in value;

function nest(tree: FixtureTree): TreeNode {
  const top: TreeNode = { entries: new Map() };
  for (const [fullPath, entry] of Object.entries(tree)) {
    const segments = fullPath.split('/');
    if (segments.some((segment) => segment === '' || segment.includes('\0'))) {
      throw new Error(
        `Git cannot store the path ${JSON.stringify(fullPath)}: empty segment or NUL byte.`,
      );
    }
    let node = top;
    for (const [index, segment] of segments.entries()) {
      const existing = node.entries.get(segment);
      if (index === segments.length - 1) {
        if (existing !== undefined) conflict(fullPath);
        node.entries.set(segment, entry);
      } else if (existing === undefined) {
        const child: TreeNode = { entries: new Map() };
        node.entries.set(segment, child);
        node = child;
      } else if (isTreeNode(existing)) {
        node = existing;
      } else {
        conflict(fullPath);
      }
    }
  }
  return top;
}

function conflict(fullPath: string): never {
  throw new Error(
    `The path ${JSON.stringify(fullPath)} is both a file and a directory.`,
  );
}

const modes = {
  tree: '40000',
  file: '100644',
  executable: '100755',
  symlink: '120000',
  submodule: '160000',
} as const;

// Called with each object a tree stores and the path it sits at.
type ObjectRecorder = (id: string, type: 'blob' | 'tree', path: string) => void;

// Stores every object a tree needs and returns the tree's ID.
function writeTree(
  node: TreeNode,
  store: Map<string, Buffer>,
  record?: ObjectRecorder,
  prefix = '',
): string {
  const rows: { sortKey: Buffer; row: Buffer }[] = [];
  for (const [name, child] of node.entries) {
    let mode: string;
    let id: string;
    const path = `${prefix}${name}`;
    if (isTreeNode(child)) {
      mode = modes.tree;
      id = writeTree(child, store, record, `${path}/`);
    } else if (child.kind === 'submodule') {
      mode = modes.submodule;
      id = child.commit;
    } else {
      mode =
        child.kind === 'symlink'
          ? modes.symlink
          : child.executable === true
            ? modes.executable
            : modes.file;
      const body = child.kind === 'symlink' ? child.target : child.content;
      id = put(store, encodeObject('blob', Buffer.from(body)));
      record?.(id, 'blob', path);
    }
    if (!/^[0-9a-f]{40}$/.test(id)) {
      throw new Error(
        `The object ID for ${JSON.stringify(name)} is not SHA-1.`,
      );
    }
    // Git orders entries by name bytes, comparing a tree as if its name
    // ended in `/`.
    rows.push({
      sortKey: Buffer.from(isTreeNode(child) ? `${name}/` : name),
      row: Buffer.concat([
        Buffer.from(`${mode} ${name}\0`),
        Buffer.from(id, 'hex'),
      ]),
    });
  }
  rows.sort((a, b) => Buffer.compare(a.sortKey, b.sortKey));
  const id = put(
    store,
    encodeObject('tree', Buffer.concat(rows.map((item) => item.row))),
  );
  record?.(id, 'tree', prefix.slice(0, -1));
  return id;
}

export interface TreeObject {
  readonly type: 'blob' | 'tree';
  // Every path that holds the object; equal files share one blob. The root
  // tree's path is empty.
  readonly paths: readonly string[];
}

// The blobs and trees of one tree, by object ID, so a check can tell which
// paths an object ID names.
export function treeObjects(
  tree: FixtureTree,
): ReadonlyMap<string, TreeObject> {
  const objects = new Map<string, { type: 'blob' | 'tree'; paths: string[] }>();
  writeTree(nest(tree), new Map(), (id, type, path) => {
    const existing = objects.get(id);
    if (existing === undefined) objects.set(id, { type, paths: [path] });
    else existing.paths.push(path);
  });
  return objects;
}

function put(store: Map<string, Buffer>, object: GitObject): string {
  store.set(object.id, object.bytes);
  return object.id;
}

export interface BuiltRepository {
  readonly defaultBranch: string;
  // Object ID to the object's uncompressed bytes.
  readonly objects: ReadonlyMap<string, Buffer>;
  // Commit label to commit ID.
  readonly commits: Readonly<Record<string, string>>;
  // Full ref name to commit ID.
  readonly refs: Readonly<Record<string, string>>;
}

export function buildRepository(
  repository: FixtureRepository,
): BuiltRepository {
  const trees = resolveTrees(repository);
  const store = new Map<string, Buffer>();
  const commits: Record<string, string> = {};
  for (const [index, commit] of repository.commits.entries()) {
    const treeId = writeTree(nest(trees.get(commit.label) ?? {}), store);
    const stamp = `${fixtureIdentity} ${fixtureEpoch + index * 60} +0000`;
    const lines = [
      `tree ${treeId}`,
      ...commit.parents.map((parent) => `parent ${commits[parent]}`),
      `author ${stamp}`,
      `committer ${stamp}`,
      '',
      commit.message,
      '',
    ];
    commits[commit.label] = put(
      store,
      encodeObject('commit', Buffer.from(lines.join('\n'))),
    );
  }
  const refs: Record<string, string> = {};
  for (const [ref, label] of Object.entries(repository.refs)) {
    const id = commits[label];
    if (
      id === undefined ||
      !/^refs\/[^\0\s]+$/.test(ref) ||
      ref.includes('..')
    ) {
      throw new Error(
        `Ref ${JSON.stringify(ref)} is invalid or names an unknown commit.`,
      );
    }
    refs[ref] = id;
  }
  if (refs[`refs/heads/${repository.defaultBranch}`] === undefined) {
    throw new Error(
      `The default branch ${repository.defaultBranch} has no ref.`,
    );
  }
  return {
    defaultBranch: repository.defaultBranch,
    objects: store,
    commits,
    refs,
  };
}
