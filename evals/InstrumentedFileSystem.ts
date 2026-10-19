// An in-memory, read-only POSIX filesystem that records every access, so a
// security test can show which paths a reviewer touched and which file
// contents it actually read. Symlinks resolve the way the kernel resolves
// them, including chains, loops, and targets outside the repository, so a
// test sees where a careless read would land.
import type { FixtureEntry, FixtureTree } from './fixtures/security/types.ts';

export type FileSystemOperation =
  'readFile' | 'lstat' | 'stat' | 'readlink' | 'readdir' | 'realpath';

export interface FileSystemAccess {
  readonly operation: FileSystemOperation;
  // The path as the caller passed it.
  readonly path: string;
  // The absolute path it reached after following symlinks, or null when the
  // call failed.
  readonly resolved: string | null;
  // True for operations that return file contents. The others read only
  // metadata.
  readonly content: boolean;
}

export interface FileStats {
  readonly type: 'file' | 'directory' | 'symlink';
  readonly size: number;
  readonly executable: boolean;
}

export type FileSystemErrorCode =
  'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'ELOOP' | 'EINVAL';

export class FileSystemError extends Error {
  readonly code: FileSystemErrorCode;

  constructor(code: FileSystemErrorCode, operation: string, path: string) {
    super(`${code}: ${operation} ${JSON.stringify(path)}`);
    this.name = 'FileSystemError';
    this.code = code;
  }
}

type Node =
  | {
      readonly type: 'file';
      readonly content: Uint8Array;
      readonly executable: boolean;
    }
  | { readonly type: 'symlink'; readonly target: string }
  | { readonly type: 'directory'; readonly entries: Map<string, Node> };

// Linux gives up after 40 symlinks in one lookup.
export const maxSymlinkHops = 40;

const segmentsOf = (path: string): string[] =>
  path.split('/').filter((segment) => segment !== '' && segment !== '.');

// Collapses `.` and `..` without consulting the filesystem.
export function lexicalPath(path: string, cwd = '/'): string {
  const absolute = path.startsWith('/') ? path : `${cwd}/${path}`;
  const result: string[] = [];
  for (const segment of segmentsOf(absolute)) {
    if (segment === '..') result.pop();
    else result.push(segment);
  }
  return `/${result.join('/')}`;
}

function toNode(entry: FixtureEntry): Node {
  switch (entry.kind) {
    case 'file':
      return {
        type: 'file',
        content:
          typeof entry.content === 'string'
            ? new TextEncoder().encode(entry.content)
            : entry.content,
        executable: entry.executable ?? false,
      };
    case 'symlink':
      return { type: 'symlink', target: entry.target };
    case 'submodule':
      // A checkout leaves an empty directory where a submodule goes.
      return { type: 'directory', entries: new Map() };
  }
}

export interface MountOptions {
  // Absolute directory the tree is mounted at, and the working directory
  // for relative paths. Default `/repo`.
  readonly root?: string;
  // Absolute paths outside the repository with their contents, such as
  // host files a symlink may point at.
  readonly hostFiles?: Readonly<Record<string, string>>;
}

export class InstrumentedFileSystem {
  readonly root: string;
  // Tree paths no real filesystem can hold (`.` or `..` segments, empty
  // segments, NUL bytes), so they were not mounted.
  readonly unmounted: readonly string[];
  readonly #top: Node & { type: 'directory' } = {
    type: 'directory',
    entries: new Map(),
  };
  readonly #accesses: FileSystemAccess[] = [];

  constructor(tree: FixtureTree, options: MountOptions = {}) {
    this.root = lexicalPath(options.root ?? '/repo');
    const unmounted: string[] = [];
    for (const [path, entry] of Object.entries(tree)) {
      const segments = path.split('/');
      if (
        path.includes('\0') ||
        segments.some((s) => s === '' || s === '.' || s === '..')
      ) {
        unmounted.push(path);
        continue;
      }
      this.#mount([...segmentsOf(this.root), ...segments], toNode(entry));
    }
    for (const [path, content] of Object.entries(options.hostFiles ?? {})) {
      this.#mount(
        segmentsOf(lexicalPath(path)),
        toNode({ kind: 'file', content }),
      );
    }
    this.unmounted = unmounted.sort();
  }

  get accesses(): readonly FileSystemAccess[] {
    return [...this.#accesses];
  }

  async readFile(
    path: string,
    options: { readonly noFollow?: boolean } = {},
  ): Promise<Uint8Array> {
    const found = this.#lookup('readFile', path, !(options.noFollow ?? false));
    if (found.node.type === 'symlink') {
      this.#fail('readFile', path, 'ELOOP');
    }
    if (found.node.type === 'directory') this.#fail('readFile', path, 'EISDIR');
    this.#record('readFile', path, found.path);
    return found.node.content.slice();
  }

  async lstat(path: string): Promise<FileStats> {
    return this.#stats('lstat', path, false);
  }

  async stat(path: string): Promise<FileStats> {
    return this.#stats('stat', path, true);
  }

  async readlink(path: string): Promise<string> {
    const found = this.#lookup('readlink', path, false);
    if (found.node.type !== 'symlink') this.#fail('readlink', path, 'EINVAL');
    this.#record('readlink', path, found.path);
    return found.node.target;
  }

  async readdir(path: string): Promise<string[]> {
    const found = this.#lookup('readdir', path, true);
    if (found.node.type !== 'directory') this.#fail('readdir', path, 'ENOTDIR');
    this.#record('readdir', path, found.path);
    return [...found.node.entries.keys()].sort();
  }

  async realpath(path: string): Promise<string> {
    const found = this.#lookup('realpath', path, true);
    this.#record('realpath', path, found.path);
    return found.path;
  }

  #stats(operation: FileSystemOperation, path: string, follow: boolean) {
    const { node, path: resolved } = this.#lookup(operation, path, follow);
    this.#record(operation, path, resolved);
    const size =
      node.type === 'file'
        ? node.content.byteLength
        : node.type === 'symlink'
          ? Buffer.byteLength(node.target)
          : 0;
    return {
      type: node.type,
      size,
      executable: node.type === 'file' && node.executable,
    };
  }

  #mount(segments: readonly string[], node: Node): void {
    let directory = this.#top;
    for (const [index, segment] of segments.entries()) {
      if (index === segments.length - 1) {
        directory.entries.set(segment, node);
        return;
      }
      let next = directory.entries.get(segment);
      if (next === undefined) {
        next = { type: 'directory', entries: new Map() };
        directory.entries.set(segment, next);
      }
      if (next.type !== 'directory') {
        throw new Error(`Cannot mount below the file /${segments.join('/')}.`);
      }
      directory = next;
    }
  }

  // Walks the path one segment at a time, splicing in symlink targets as
  // the kernel does. The final symlink is followed only when `followLast`.
  #lookup(
    operation: FileSystemOperation,
    path: string,
    followLast: boolean,
  ): { node: Node; path: string } {
    if (path.length === 0 || path.includes('\0')) {
      this.#fail(operation, path, path.length === 0 ? 'ENOENT' : 'EINVAL');
    }
    const pending = segmentsOf(
      path.startsWith('/') ? path : `${this.root}/${path}`,
    );
    const current: { name: string; node: Node }[] = [];
    let hops = 0;
    for (;;) {
      const segment = pending.shift();
      const parent = current.at(-1)?.node ?? this.#top;
      if (segment === undefined) {
        return {
          node: parent,
          path: `/${current.map((item) => item.name).join('/')}`,
        };
      }
      if (segment === '..') {
        current.pop();
        continue;
      }
      if (parent.type !== 'directory') this.#fail(operation, path, 'ENOTDIR');
      const node = parent.entries.get(segment);
      if (node === undefined) this.#fail(operation, path, 'ENOENT');
      if (node.type === 'symlink' && (pending.length > 0 || followLast)) {
        hops += 1;
        if (hops > maxSymlinkHops) this.#fail(operation, path, 'ELOOP');
        if (node.target.startsWith('/')) current.length = 0;
        pending.unshift(...segmentsOf(node.target));
        continue;
      }
      current.push({ name: segment, node });
    }
  }

  #record(
    operation: FileSystemOperation,
    path: string,
    resolved: string | null,
  ): void {
    this.#accesses.push({
      operation,
      path,
      resolved,
      content: operation === 'readFile',
    });
  }

  #fail(
    operation: FileSystemOperation,
    path: string,
    code: FileSystemErrorCode,
  ): never {
    this.#record(operation, path, null);
    throw new FileSystemError(code, operation, path);
  }
}
