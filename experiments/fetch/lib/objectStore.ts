// Object accounting. The spike lists every object in the local store before
// and after each step, with `git cat-file --batch-all-objects --batch-check`
// in the format below, and records the difference as what that step
// acquired. Under GIT_NO_LAZY_FETCH the listing itself can never fetch.

export const inventoryFormat =
  '%(objectname) %(objecttype) %(objectsize) %(objectsize:disk)';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface StoredObject {
  readonly oid: string;
  readonly type: ObjectType;
  // Uncompressed size.
  readonly size: number;
  // Bytes the object takes in its pack or loose file.
  readonly diskSize: number;
}

export type ObjectInventory = ReadonlyMap<string, StoredObject>;

const objectTypes: ReadonlySet<string> = new Set([
  'blob',
  'tree',
  'commit',
  'tag',
]);
const oidPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const countPattern = /^\d+$/;

export function parseObjectInventory(output: string): ObjectInventory {
  const inventory = new Map<string, StoredObject>();
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const [oid, type, size, diskSize, ...rest] = line.split(' ');
    if (
      rest.length > 0 ||
      oid === undefined ||
      !oidPattern.test(oid) ||
      type === undefined ||
      !objectTypes.has(type) ||
      size === undefined ||
      !countPattern.test(size) ||
      diskSize === undefined ||
      !countPattern.test(diskSize)
    )
      throw new Error(
        `Unexpected object inventory line: ${line.slice(0, 120)}`,
      );
    inventory.set(oid, {
      oid,
      type: type as ObjectType,
      size: Number(size),
      diskSize: Number(diskSize),
    });
  }
  return inventory;
}

export interface TypeTotals {
  readonly count: number;
  readonly bytes: number;
  readonly diskBytes: number;
}

export interface AcquiredObjects {
  readonly objects: readonly StoredObject[];
  readonly byType: Readonly<Record<ObjectType, TypeTotals>>;
  readonly bytes: number;
  readonly diskBytes: number;
}

function emptyTotals(): Record<ObjectType, TypeTotals> {
  const zero = { count: 0, bytes: 0, diskBytes: 0 };
  return { blob: zero, tree: zero, commit: zero, tag: zero };
}

export function summarizeObjects(
  objects: Iterable<StoredObject>,
): AcquiredObjects {
  const list = [...objects].sort((a, b) => a.oid.localeCompare(b.oid));
  const byType = emptyTotals();
  let bytes = 0;
  let diskBytes = 0;
  for (const object of list) {
    const totals = byType[object.type];
    byType[object.type] = {
      count: totals.count + 1,
      bytes: totals.bytes + object.size,
      diskBytes: totals.diskBytes + object.diskSize,
    };
    bytes += object.size;
    diskBytes += object.diskSize;
  }
  return { objects: list, byType, bytes, diskBytes };
}

// Objects present after a step that were not present before it. Git never
// deletes objects during the spike (gc and maintenance are off), so an
// object missing from `after` is a harness error.
export function acquiredBetween(
  before: ObjectInventory,
  after: ObjectInventory,
): AcquiredObjects {
  for (const oid of before.keys())
    if (!after.has(oid)) throw new Error(`Object ${oid} disappeared.`);
  return summarizeObjects(
    [...after.values()].filter((object) => !before.has(object.oid)),
  );
}

// The planned blob IDs the store does not hold yet. Only these are fetched:
// a blob already present, such as an ignore file read earlier or the same
// content at another path, is never requested again.
export function absentFrom(
  store: ObjectInventory,
  planned: Iterable<string>,
): string[] {
  return [...new Set(planned)].filter((oid) => !store.has(oid));
}

export interface AcquisitionCheck {
  readonly exact: boolean;
  // Planned blob IDs the store still lacks after acquisition.
  readonly missing: readonly string[];
  // Blobs the acquisition added that the plan did not name.
  readonly unexpected: readonly string[];
}

export function verifyAcquisition(
  planned: Iterable<string>,
  store: ObjectInventory,
  acquired: AcquiredObjects,
): AcquisitionCheck {
  const plannedSet = new Set(planned);
  const missing = [...plannedSet]
    .filter((oid) => store.get(oid)?.type !== 'blob')
    .sort();
  const unexpected = acquired.objects
    .filter((object) => object.type === 'blob' && !plannedSet.has(object.oid))
    .map((object) => object.oid)
    .sort();
  return {
    exact: missing.length === 0 && unexpected.length === 0,
    missing,
    unexpected,
  };
}
