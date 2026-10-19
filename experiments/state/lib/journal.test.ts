import { describe, expect, test } from 'vitest';
import type { FakeGitHub } from './github.ts';
import {
  cursorFor,
  dedupe,
  JournalWriter,
  prefixDigest,
  readJournal,
  shardBody,
} from './journal.ts';
import type { JournalRecord } from './journal.ts';
import { encodeMarker } from './marker.ts';
import {
  accounts,
  filler,
  identity,
  publisherFor,
  pullRequest,
} from './testing.ts';

const publisher = publisherFor(accounts.actions);

function record(index: number, chars = 40): JournalRecord {
  return {
    key: `suppression:${index}`,
    type: 'suppression',
    data: {
      findingId: String(index),
      byLogin: 'maya',
      note: filler(index, chars),
    },
  };
}

function read(github: FakeGitHub, cursor?: Parameters<typeof readJournal>[3]) {
  return readJournal(github.comments('issue'), publisher, identity, cursor);
}

async function writeShards(
  count: number,
): Promise<{ github: FakeGitHub; writer: JournalWriter }> {
  const github = pullRequest();
  const writer = new JournalWriter(
    github.client('github-actions[bot]', 'installation'),
    publisher,
    identity,
    { chain: [], records: [] },
  );
  let index = 0;
  while ((writer.tip?.seq ?? -1) < count - 1) {
    await writer.append([record(index, 6_000)]);
    index += 1;
  }
  return { github, writer };
}

describe('JournalWriter', () => {
  test('grows the newest shard, then opens a linked one under the cap', async () => {
    const { github, writer } = await writeShards(3);
    const comments = github.comments('issue');
    expect(comments).toHaveLength(3);
    for (const comment of comments)
      expect(comment.body.length).toBeLessThanOrEqual(40_000);
    const view = read(github);
    expect(view.issues).toEqual([]);
    expect(view.chain.map((shard) => shard.seq)).toEqual([0, 1, 2]);
    expect(view.chain[1]?.prev).toEqual({
      commentId: view.chain[0]?.commentId,
      digest: view.chain[0]?.digest,
    });
    expect(view.records).toEqual(writer.records);
    expect(view.chain[0]?.records.length).toBeGreaterThan(1);
  });

  test('skips a record it already holds and refuses a conflicting one', async () => {
    const { github, writer } = await writeShards(1);
    const writes = github.writes;
    await writer.append([record(0, 6_000)]);
    expect(github.writes).toBe(writes);
    await expect(
      writer.append([{ ...record(0), data: { other: true } }]),
    ).rejects.toThrow('already holds a different record');
  });

  test('stops when GitHub reports another author for its write', async () => {
    const github = pullRequest();
    const writer = new JournalWriter(
      github.client('mallory', 'personal'),
      publisher,
      identity,
      {
        chain: [],
        records: [],
      },
    );
    await expect(writer.append([record(0)])).rejects.toMatchObject({
      code: 'author-mismatch',
    });
  });

  test('refuses a reset that is not a reset record', async () => {
    const { writer } = await writeShards(1);
    await expect(writer.reset(record(1), writer.tip)).rejects.toThrow(
      'Not a reset record.',
    );
  });

  test('refuses a single batch that cannot fit one shard', async () => {
    const { writer } = await writeShards(1);
    await expect(writer.append([record(9, 60_000)])).rejects.toThrow();
  });
});

describe('readJournal', () => {
  test('ignores shards from any other author', async () => {
    const { github } = await writeShards(2);
    const forged = shardBody(identity, 2, null, [record(99)]);
    await github
      .client('mallory', 'personal')
      .createComment('issue', forged.body);
    const view = read(github);
    expect(view.issues).toEqual([]);
    expect(view.ignored).toBe(1);
    expect(view.records.some((item) => item.key === 'suppression:99')).toBe(
      false,
    );
  });

  test('a deleted sealed shard breaks the chain', async () => {
    const { github } = await writeShards(3);
    const middle = github.comments('issue')[1];
    github.delete(middle?.id as number);
    const view = read(github);
    expect(view.issues).toEqual(['missing-shard']);
    expect(view.authentic.map((shard) => shard.seq)).toEqual([0, 2]);
  });

  test('an edited sealed shard breaks the chain, even with a valid marker', async () => {
    const { github } = await writeShards(3);
    const view = read(github);
    const first = view.chain[0];
    if (first === undefined) throw new Error('No shard.');
    const rewritten = shardBody(identity, 0, null, [record(50)]);
    github.edit(first.commentId, rewritten.body);
    expect(read(github).issues).toEqual(['modified-shard']);
    // A later shard that claims to start the chain cannot hide the rest.
    github.edit(
      first.commentId,
      shardBody(identity, 5, null, first.records).body,
    );
    expect([...read(github).issues].sort()).toEqual([
      'corrupt-shard',
      'missing-shard',
    ]);
    // Nor can one that claims the wrong position on it.
    github.edit(
      first.commentId,
      shardBody(identity, 0, null, first.records).body,
    );
    expect(read(github).issues).toEqual([]);
    const second = view.chain[1];
    if (second === undefined) throw new Error('No shard.');
    github.edit(
      second.commentId,
      shardBody(identity, 4, second.prev, second.records).body,
    );
    expect(read(github).issues).toEqual(['modified-shard']);
  });

  test('an unreadable or foreign shard is corruption', async () => {
    const { github } = await writeShards(1);
    const tip = github.comments('issue')[0];
    github.edit(
      tip?.id as number,
      (tip?.body as string).replace(
        /:[0-9a-f]{64} -->/,
        `:${'0'.repeat(64)} -->`,
      ),
    );
    expect(read(github).issues).toEqual(['corrupt-shard']);
    const other = shardBody({ ...identity, prNumber: 43 }, 0, null, [
      record(1),
    ]);
    github.edit(tip?.id as number, other.body);
    expect(read(github).issues).toEqual(['corrupt-shard']);
    const twice = shardBody(identity, 0, null, [record(1)]);
    github.edit(tip?.id as number, `${twice.body}\n${twice.body}`);
    expect(read(github).issues).toEqual(['corrupt-shard']);
  });

  test.each([
    ['a bad record type', { key: 'k', type: 'other', data: {} }],
    ['an empty key', { key: '', type: 'receipt', data: {} }],
    ['array data', { key: 'k', type: 'receipt', data: [] }],
    ['null', null],
  ])('a shard holding %s is corruption', async (_, bad) => {
    const github = pullRequest();
    const { marker } = encodeMarker('journal', {
      kind: 'journal-shard',
      ...identity,
      seq: 0,
      prev: null,
      records: [bad],
    });
    await github
      .client('github-actions[bot]', 'installation')
      .createComment('issue', marker);
    expect(read(github).issues).toEqual(['corrupt-shard']);
  });

  test.each([
    ['a negative sequence', { seq: -1, prev: null }],
    ['a malformed link', { seq: 0, prev: { commentId: 'x', digest: 'y' } }],
    ['a missing link', { seq: 0 }],
  ])('a shard with %s is corruption', async (_, fields) => {
    const github = pullRequest();
    const { marker } = encodeMarker('journal', {
      kind: 'journal-shard',
      ...identity,
      records: [],
      ...fields,
    });
    await github
      .client('github-actions[bot]', 'installation')
      .createComment('issue', marker);
    expect(read(github).issues).toEqual(['corrupt-shard']);
  });

  test('two shards on one parent are a fork', async () => {
    const { github } = await writeShards(1);
    const view = read(github);
    const parent = view.chain[0];
    if (parent === undefined) throw new Error('No shard.');
    const link = { commentId: parent.commentId, digest: parent.digest };
    const client = github.client('github-actions[bot]', 'installation');
    await client.createComment(
      'issue',
      shardBody(identity, 1, link, [record(10)]).body,
    );
    await client.createComment(
      'issue',
      shardBody(identity, 1, link, [record(11)]).body,
    );
    expect(read(github).issues).toEqual(['forked-journal']);
  });

  test('a repeated key keeps the first copy, or flags conflicting content', () => {
    const issues = new Set<string>();
    expect(dedupe([record(1), record(1)], issues as never)).toEqual([
      record(1),
    ]);
    expect(issues.size).toBe(0);
    dedupe(
      [record(1), { ...record(1), data: { changed: true } }],
      issues as never,
    );
    expect([...issues]).toEqual(['conflicting-record']);
  });

  test('flags a conflicting key across shards', async () => {
    const github = pullRequest();
    const client = github.client('github-actions[bot]', 'installation');
    const first = shardBody(identity, 0, null, [record(1)]);
    const created = await client.createComment('issue', first.body);
    const changed = { ...record(1), data: { changed: true } };
    const link = { commentId: created.id, digest: first.digest };
    await client.createComment(
      'issue',
      shardBody(identity, 1, link, [changed]).body,
    );
    expect(read(github).issues).toEqual(['conflicting-record']);
  });

  test('checks the snapshot cursor against the chain', async () => {
    const { github, writer } = await writeShards(2);
    const tip = writer.tip;
    if (tip === undefined) throw new Error('No tip.');
    const cursor = cursorFor(tip);
    expect(read(github, cursor).issues).toEqual([]);
    // The newest shard may grow after the snapshot was written.
    await writer.append([record(70)]);
    expect(read(github, cursor).issues).toEqual([]);
    expect(
      read(github, { ...cursor, prefixDigest: prefixDigest([]) }).issues,
    ).toEqual(['cursor-mismatch']);
    expect(read(github, { ...cursor, recordCount: 999 }).issues).toEqual([
      'cursor-mismatch',
    ]);
    github.delete(tip.commentId);
    expect(read(github, cursor).issues).toEqual(['cursor-missing']);
  });

  test('a reset starts a new segment and acknowledges what it names', async () => {
    const { github, writer } = await writeShards(3);
    const comments = github.comments('issue');
    github.delete(comments[1]?.id as number);
    github.edit(
      comments[0]?.id as number,
      'garbled <!-- prra:journal:v2:AAAA:' + '0'.repeat(64) + ' -->',
    );
    const broken = read(github);
    expect([...broken.issues].sort()).toEqual([
      'corrupt-shard',
      'missing-shard',
    ]);
    await writer.reset(
      {
        key: 'reset:1',
        type: 'reset',
        data: { corruptCommentIds: broken.corrupt, carried: {} },
      },
      broken.authentic.at(-1),
    );
    const after = read(github);
    expect(after.issues).toEqual([]);
    expect(after.chain).toHaveLength(1);
    expect(after.records.map((item) => item.key)).toEqual(['reset:1']);
    // Corruption after the reset is not acknowledged.
    await github
      .client('github-actions[bot]', 'installation')
      .createComment(
        'issue',
        'x <!-- prra:journal:v2:AAAA:' + '1'.repeat(64) + ' -->',
      );
    expect(read(github).issues).toEqual(['corrupt-shard']);
  });
});
