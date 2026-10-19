// Canonical JSON: one byte sequence per value, whatever order its keys were
// inserted in, so digests over it are stable. Object keys are sorted by UTF-16
// code unit, as in RFC 8785, and numbers and strings use JSON.stringify's
// shortest round-trip form. Object properties whose value is undefined are
// omitted, the same as an absent optional property. Anything JSON cannot
// represent exactly is refused instead of being coerced: undefined outside an
// object property, array holes, non-finite numbers, bigints, symbols,
// functions, cycles, and objects other than arrays and plain objects (a Date,
// Map, or class instance would otherwise serialize through toJSON or lose
// its contents).

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          'canonicalJson cannot represent a non-finite number.',
        );
      }
      return JSON.stringify(value);
    case 'object':
      return value === null ? 'null' : serializeObject(value, ancestors);
    default:
      throw new TypeError(`canonicalJson cannot represent a ${typeof value}.`);
  }
}

function serializeObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new TypeError('canonicalJson cannot represent a cyclic value.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return serializeArray(value, ancestors);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        'canonicalJson accepts only arrays and plain objects.',
      );
    }
    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) continue;
      members.push(`${JSON.stringify(key)}:${serialize(member, ancestors)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(
  value: readonly unknown[],
  ancestors: Set<object>,
): string {
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError('canonicalJson cannot represent an array hole.');
    }
    items.push(serialize(value[index], ancestors));
  }
  return `[${items.join(',')}]`;
}
