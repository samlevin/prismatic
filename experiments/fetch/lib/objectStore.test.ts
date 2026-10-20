import { describe, expect, it } from 'vitest';
import {
  absentFrom,
  acquiredBetween,
  parseObjectInventory,
  summarizeObjects,
  verifyAcquisition,
} from './objectStore.ts';

const oid = (digit: string): string => digit.repeat(40);

describe('parseObjectInventory', () => {
  it('parses the batch-check lines', () => {
    const inventory = parseObjectInventory(
      `${oid('a')} blob 10 8\n${oid('b')} tree 33 30\n${oid('c')} commit 200 150\n${oid('d')} tag 90 80\n`,
    );
    expect(inventory.size).toBe(4);
    expect(inventory.get(oid('a'))).toEqual({
      oid: oid('a'),
      type: 'blob',
      size: 10,
      diskSize: 8,
    });
  });

  it('accepts SHA-256 object names', () => {
    const long = 'e'.repeat(64);
    expect(parseObjectInventory(`${long} blob 1 1\n`).has(long)).toBe(true);
  });

  it.each([
    'zz blob 1 1',
    `${oid('a')} gitlink 1 1`,
    `${oid('a')} blob -1 1`,
    `${oid('a')} blob 1`,
    `${oid('a')} blob 1 1 extra`,
    `${oid('a')}`,
    `${oid('a')} blob`,
    `${oid('a')} blob 1 x`,
  ])('rejects %j', (line) => {
    expect(() => parseObjectInventory(`${line}\n`)).toThrow(
      /Unexpected object inventory line/,
    );
  });
});

describe('acquiredBetween', () => {
  it('lists only the new objects, sorted, with totals by type', () => {
    const before = parseObjectInventory(`${oid('b')} tree 33 30\n`);
    const after = parseObjectInventory(
      `${oid('b')} tree 33 30\n${oid('c')} blob 5 4\n${oid('a')} blob 7 6\n${oid('d')} commit 100 90\n`,
    );
    const acquired = acquiredBetween(before, after);
    expect(acquired.objects.map((object) => object.oid)).toEqual([
      oid('a'),
      oid('c'),
      oid('d'),
    ]);
    expect(acquired.byType.blob).toEqual({
      count: 2,
      bytes: 12,
      diskBytes: 10,
    });
    expect(acquired.byType.commit).toEqual({
      count: 1,
      bytes: 100,
      diskBytes: 90,
    });
    expect(acquired.byType.tree.count).toBe(0);
    expect(acquired.bytes).toBe(112);
    expect(acquired.diskBytes).toBe(100);
  });

  it('refuses an inventory that lost an object', () => {
    const before = parseObjectInventory(`${oid('a')} blob 1 1\n`);
    expect(() => acquiredBetween(before, new Map())).toThrow(/disappeared/);
  });
});

describe('absentFrom', () => {
  it('keeps only planned blobs the store lacks, once each', () => {
    const store = parseObjectInventory(`${oid('a')} blob 1 1\n`);
    expect(absentFrom(store, [oid('a'), oid('b'), oid('b')])).toEqual([
      oid('b'),
    ]);
  });
});

describe('verifyAcquisition', () => {
  const blob = (digit: string) => ({
    oid: oid(digit),
    type: 'blob' as const,
    size: 1,
    diskSize: 1,
  });

  it('accepts a planned blob that was already in the store', () => {
    const store = parseObjectInventory(
      `${oid('a')} blob 1 1\n${oid('b')} blob 1 1\n${oid('f')} tree 1 1\n`,
    );
    const acquired = summarizeObjects([
      blob('b'),
      { oid: oid('f'), type: 'tree', size: 1, diskSize: 1 },
    ]);
    expect(verifyAcquisition([oid('a'), oid('b')], store, acquired)).toEqual({
      exact: true,
      missing: [],
      unexpected: [],
    });
  });

  it('names planned blobs still absent and blobs nobody planned', () => {
    const store = parseObjectInventory(
      `${oid('c')} blob 1 1\n${oid('d')} tree 1 1\n`,
    );
    const acquired = summarizeObjects([blob('c')]);
    expect(verifyAcquisition([oid('a'), oid('d')], store, acquired)).toEqual({
      exact: false,
      missing: [oid('a'), oid('d')],
      unexpected: [oid('c')],
    });
  });
});
