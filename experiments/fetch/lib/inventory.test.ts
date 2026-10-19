import { describe, expect, it } from 'vitest';
import {
  decodeRepoPath,
  parseLsTree,
  parseRawDiff,
  unionManifest,
} from './inventory.ts';
import type { ChangedPath } from './inventory.ts';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const zero = '0'.repeat(40);

const nul = (...fields: (string | Buffer)[]): Buffer =>
  Buffer.concat(
    fields.flatMap((field) => [
      typeof field === 'string' ? Buffer.from(field) : field,
      Buffer.from([0]),
    ]),
  );

describe('decodeRepoPath', () => {
  it('returns a valid path unchanged', () => {
    expect(decodeRepoPath(Buffer.from('src/café.ts'))).toEqual({
      ok: true,
      path: 'src/café.ts',
    });
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(decodeRepoPath(Buffer.from([0x73, 0xff]))).toEqual({
      ok: false,
      reason: 'invalid-utf8',
    });
  });

  it('refuses a name that fails the path rules', () => {
    expect(decodeRepoPath(Buffer.from('src/a\nb.ts'))).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
  });
});

describe('parseLsTree', () => {
  it('parses entries with and without sizes', () => {
    const listing = parseLsTree(
      nul(
        `100644 blob ${a}\tsrc/a.ts`,
        `100644 blob ${b}     123\tsrc/b.ts`,
        `100644 blob ${b}     BAD\tsrc/missing.ts`,
        `160000 commit ${a}       -\tvendor/sub`,
        `040000 tree ${a}\tsrc`,
      ),
    );
    expect(listing.rejected).toEqual([]);
    expect(listing.entries).toEqual([
      { path: 'src/a.ts', mode: '100644', type: 'blob', oid: a },
      { path: 'src/b.ts', mode: '100644', type: 'blob', oid: b, size: 123 },
      { path: 'src/missing.ts', mode: '100644', type: 'blob', oid: b },
      { path: 'vendor/sub', mode: '160000', type: 'commit', oid: a },
      { path: 'src', mode: '040000', type: 'tree', oid: a },
    ]);
  });

  it('reports hostile names by length and hex prefix only', () => {
    const name = Buffer.from('src/new\nline.ts');
    const listing = parseLsTree(
      nul(Buffer.concat([Buffer.from(`100644 blob ${a}\t`), name])),
    );
    expect(listing.entries).toEqual([]);
    expect(listing.rejected).toEqual([
      {
        reason: 'invalid-path',
        byteLength: name.length,
        hexPrefix: name.subarray(0, 16).toString('hex'),
      },
    ]);
  });

  it.each([
    ['a record without a tab', nul(`100644 blob ${a} src/a.ts`)],
    ['an unknown object type', nul(`100644 bloob ${a}\tsrc/a.ts`)],
    ['output without a final NUL', Buffer.from(`100644 blob ${a}\tsrc/a.ts`)],
  ])('rejects %s', (_label, output) => {
    expect(() => parseLsTree(output)).toThrow();
  });
});

describe('parseRawDiff', () => {
  it('parses every status --no-renames can produce', () => {
    const diff = parseRawDiff(
      nul(
        `:000000 100644 ${zero} ${a} A`,
        'src/new.ts',
        `:100644 000000 ${a} ${zero} D`,
        'src/old.ts',
        `:100644 100755 ${a} ${b} M`,
        'src/mod.ts',
        `:100644 120000 ${a} ${b} T`,
        'src/link.ts',
      ),
    );
    expect(diff.rejected).toEqual([]);
    expect(diff.changes.map((change) => [change.path, change.status])).toEqual([
      ['src/new.ts', 'A'],
      ['src/old.ts', 'D'],
      ['src/mod.ts', 'M'],
      ['src/link.ts', 'T'],
    ]);
    expect(diff.changes[2]).toEqual({
      path: 'src/mod.ts',
      status: 'M',
      oldMode: '100644',
      newMode: '100755',
      oldOid: a,
      newOid: b,
    });
  });

  it('keeps going past a rejected name', () => {
    const diff = parseRawDiff(
      nul(
        `:100644 100644 ${a} ${b} M`,
        Buffer.from([0x73, 0xfe]),
        `:100644 100644 ${a} ${b} M`,
        'src/ok.ts',
      ),
    );
    expect(diff.changes.map((change) => change.path)).toEqual(['src/ok.ts']);
    expect(diff.rejected).toEqual([
      { reason: 'invalid-utf8', byteLength: 2, hexPrefix: '73fe' },
    ]);
  });

  it('refuses rename records', () => {
    expect(() =>
      parseRawDiff(nul(`:100644 100644 ${a} ${b} R100`, 'a.ts', 'b.ts')),
    ).toThrow(/renames must be off/);
  });

  it('refuses a header without a path', () => {
    expect(() => parseRawDiff(nul(`:100644 100644 ${a} ${b} M`))).toThrow(
      /no path/,
    );
  });
});

describe('unionManifest', () => {
  const change = (
    path: string,
    status: ChangedPath['status'],
  ): ChangedPath => ({
    path,
    status,
    oldMode: '100644',
    newMode: '100644',
    oldOid: a,
    newOid: b,
  });

  it('keeps a file reverted to merge-base content through its incremental change', () => {
    const manifest = unionManifest(
      [change('src/b.ts', 'M'), change('src/a.ts', 'M')],
      [change('src/a.ts', 'M'), change('src/reverted.ts', 'M')],
    );
    expect(manifest.map((entry) => entry.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/reverted.ts',
    ]);
    expect(manifest[0]?.cumulative).toBeDefined();
    expect(manifest[0]?.incremental).toBeDefined();
    expect(manifest[2]?.cumulative).toBeUndefined();
  });

  it('is the cumulative diff when there is no frontier', () => {
    expect(unionManifest([change('x.ts', 'A')]).map((e) => e.path)).toEqual([
      'x.ts',
    ]);
  });

  it('orders paths by bytes, as Git does', () => {
    const manifest = unionManifest([
      change('b.ts', 'M'),
      change('B.ts', 'M'),
      change('é.ts', 'M'),
    ]);
    expect(manifest.map((entry) => entry.path)).toEqual([
      'B.ts',
      'b.ts',
      'é.ts',
    ]);
  });
});
