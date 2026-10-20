// The spike's workbench: fixture servers, blobless clients, and the Git
// steps the scenarios compose, each measured by the objects it added to the
// local store. Runs only inside the pinned Action image (run-in-image.sh);
// the unit tests cover the library under ../lib instead.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCatFileBatch } from '../lib/catFile.ts';
import { GitRunner } from '../lib/gitCommand.ts';
import type { LazyFetch } from '../lib/gitCommand.ts';
import {
  acquiredBetween,
  inventoryFormat,
  parseObjectInventory,
} from '../lib/objectStore.ts';
import type { ObjectInventory } from '../lib/objectStore.ts';
import { historyCompleteFrom } from '../lib/ancestry.ts';
import { parseLsTree, parseRawDiff } from '../lib/inventory.ts';
import type { RawDiff, TreeListing } from '../lib/inventory.ts';
import { fastImportStream } from '../lib/fixtures.ts';
import type { FixtureCommit } from '../lib/fixtures.ts';
import { nodeSpawner } from '../lib/processRunner.ts';
import type { ProcessResult } from '../lib/processRunner.ts';
import type { StepRecord } from '../lib/scenarioRecord.ts';
import { patternSecretRedactor } from '../../../src/shared/redaction.ts';

export interface Server {
  readonly dir: string;
  readonly url: string;
  // fast-import mark -> commit ID.
  readonly commits: ReadonlyMap<number, string>;
}

export interface Client {
  readonly dir: string;
  readonly url: string;
}

export interface Measured<T> {
  readonly value: T;
  readonly record: StepRecord;
}

export class Lab {
  readonly root: string;
  readonly git: GitRunner;
  #counter = 0;

  private constructor(root: string, git: GitRunner) {
    this.root = root;
    this.git = git;
  }

  // allowFileProtocol adds `protocol.file.allow=always` for the fixture
  // remotes; the GitHub sandbox runs with the normative options only.
  static async create(
    root: string,
    gitPath: string,
    allowFileProtocol = true,
  ): Promise<Lab> {
    const home = path.join(root, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    const git = new GitRunner({
      gitPath,
      home,
      spawner: nodeSpawner,
      allowFileProtocol,
      redactText: (text) => patternSecretRedactor.redactText(text),
    });
    return new Lab(root, git);
  }

  #nextDir(name: string): string {
    this.#counter += 1;
    return path.join(
      this.root,
      `${String(this.#counter).padStart(3, '0')}-${name}`,
    );
  }

  // A bare fixture repository that serves partial clones and wants by
  // object ID, the way GitHub does.
  async createServer(
    name: string,
    commits: readonly FixtureCommit[],
  ): Promise<Server> {
    const dir = this.#nextDir(`${name}.server`);
    await this.git.ok(this.root, ['init', '--quiet', '--bare', dir]);
    const marks = path.join(dir, 'spike-marks');
    await this.git.ok(
      dir,
      ['fast-import', '--quiet', '--done', `--export-marks=${marks}`],
      { input: fastImportStream(commits) },
    );
    for (const [key, value] of [
      ['uploadpack.allowFilter', 'true'],
      ['uploadpack.allowAnySHA1InWant', 'true'],
      ['transfer.advertiseObjectInfo', 'true'],
    ] as const)
      await this.git.ok(dir, ['config', key, value]);
    const map = new Map<number, string>();
    for (const line of (await readFile(marks, 'utf8')).split('\n')) {
      const match = /^:(\d+) ([0-9a-f]{40})$/.exec(line);
      if (match) map.set(Number(match[1]), match[2] as string);
    }
    return { dir, url: `file://${dir}`, commits: map };
  }

  // An empty bare store with the server as its blobless promisor remote.
  // No refspec is configured: every fetch names its commits or objects.
  async createClient(name: string, url: string): Promise<Client> {
    const dir = this.#nextDir(`${name}.client`);
    await this.git.ok(this.root, ['init', '--quiet', '--bare', dir]);
    for (const [key, value] of [
      ['remote.origin.url', url],
      ['remote.origin.promisor', 'true'],
      ['remote.origin.partialclonefilter', 'blob:none'],
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      ['fetch.writeCommitGraph', 'false'],
    ] as const)
      await this.git.ok(dir, ['config', key, value]);
    return { dir, url };
  }

  async inventory(repo: string): Promise<ObjectInventory> {
    const result = await this.git.ok(repo, [
      'cat-file',
      '--batch-all-objects',
      `--batch-check=${inventoryFormat}`,
    ]);
    return parseObjectInventory(result.stdout.toString('utf8'));
  }

  async packBytes(repo: string): Promise<number> {
    const packDir = path.join(repo, 'objects', 'pack');
    let total = 0;
    for (const name of await readdir(packDir).catch(() => [] as string[]))
      if (name.endsWith('.pack'))
        total += (await stat(path.join(packDir, name))).size;
    return total;
  }

  async step(
    repo: string,
    step: string,
    args: readonly string[],
    options: { input?: string | Buffer; lazyFetch?: LazyFetch } = {},
  ): Promise<Measured<ProcessResult>> {
    const before = await this.inventory(repo);
    const packBefore = await this.packBytes(repo);
    const result = await this.git.run(repo, args, options);
    const after = await this.inventory(repo);
    const record: StepRecord = {
      step,
      status: result.status,
      elapsedMs: Math.round(result.elapsedMs),
      acquired: acquiredBetween(before, after),
      packBytesAdded: (await this.packBytes(repo)) - packBefore,
      ...(result.status === 0
        ? {}
        : { stderr: result.stderr.trim().slice(0, 400) }),
    };
    return { value: result, record };
  }

  // Commits and trees only.
  fetchCommits(
    client: Client,
    step: string,
    commits: readonly string[],
    options: { depth?: number; deepen?: number } = {},
  ): Promise<Measured<ProcessResult>> {
    return this.step(client.dir, step, [
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--recurse-submodules=no',
      '--filter=blob:none',
      ...(options.depth === undefined ? [] : [`--depth=${options.depth}`]),
      ...(options.deepen === undefined ? [] : [`--deepen=${options.deepen}`]),
      'origin',
      ...commits,
    ]);
  }

  // The proposed acquisition primitive: an ordinary fetch of exactly the
  // planned blob IDs, the same request Git's own lazy fetch sends, with the
  // noop negotiator so the server does not assume the client has blobs
  // reachable from its commits. GIT_NO_LAZY_FETCH stays set.
  acquireBlobs(
    client: Client,
    step: string,
    oids: readonly string[],
    negotiation: 'noop' | 'default' = 'noop',
  ): Promise<Measured<ProcessResult>> {
    return this.step(
      client.dir,
      step,
      [
        ...(negotiation === 'noop'
          ? ['-c', 'fetch.negotiationAlgorithm=noop']
          : []),
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--recurse-submodules=no',
        '--filter=blob:none',
        '--stdin',
        'origin',
      ],
      { input: oids.map((oid) => `${oid}\n`).join('') },
    );
  }

  async lsTree(
    repo: string,
    commit: string,
    long = false,
  ): Promise<TreeListing> {
    const result = await this.git.ok(repo, [
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      ...(long ? ['-l'] : []),
      commit,
    ]);
    return parseLsTree(result.stdout);
  }

  // Blob sizes the remote advertises. For a fixture server this is its own
  // `ls-tree -l`; for GitHub it is the REST tree API (see github.ts).
  async advertisedSizes(
    server: Server,
    commit: string,
  ): Promise<Map<string, number>> {
    const listing = await this.lsTree(server.dir, commit, true);
    const sizes = new Map<string, number>();
    for (const entry of listing.entries)
      if (entry.size !== undefined) sizes.set(entry.oid, entry.size);
    return sizes;
  }

  async rawDiff(repo: string, from: string, to: string): Promise<RawDiff> {
    const result = await this.git.ok(repo, [
      'diff',
      '--raw',
      '--no-renames',
      '--no-abbrev',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      from,
      to,
    ]);
    return parseRawDiff(result.stdout);
  }

  // True when no shallow boundary is reachable from the given commits.
  async historyComplete(
    repo: string,
    commits: readonly string[],
  ): Promise<boolean> {
    const shallow = await readFile(path.join(repo, 'shallow'), 'utf8').catch(
      () => '',
    );
    const listed = await this.git.ok(repo, ['rev-list', ...commits]);
    return historyCompleteFrom(listed.stdout.toString('utf8'), shallow);
  }

  // Reads admitted blobs through one `cat-file --batch`, bounded by the
  // planned bytes.
  async readBlobs(
    repo: string,
    oids: readonly string[],
    maxBytes: number,
  ): Promise<Map<string, Buffer>> {
    const result = await this.git.ok(repo, ['cat-file', '--batch'], {
      input: oids.map((oid) => `${oid}\n`).join(''),
      maxOutputBytes: maxBytes + oids.length * 128 + 1,
    });
    return parseCatFileBatch(result.stdout);
  }

  async writeFile(file: string, content: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  scratchDir(name: string): string {
    return this.#nextDir(name);
  }
}
