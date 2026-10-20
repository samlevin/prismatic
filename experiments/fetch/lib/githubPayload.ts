// Readers for the untyped GitHub REST payloads the sandbox run uses. A value
// of the wrong shape is skipped or refused, never coerced.

export function field(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value))
    throw new Error(`GitHub returned no valid ${label}.`);
  return value;
}

// Adds the advertised blob sizes from a recursive tree response and returns
// whether GitHub truncated it. Entries a truncated response leaves out stay
// unsized, so they cannot be admitted.
export function addTreeSizes(
  tree: unknown,
  sizes: Map<string, number>,
): boolean {
  const entries = field(tree, 'tree');
  if (Array.isArray(entries))
    for (const entry of entries) {
      const oid = field(entry, 'sha');
      const size = field(entry, 'size');
      if (
        field(entry, 'type') === 'blob' &&
        typeof oid === 'string' &&
        typeof size === 'number'
      )
        sizes.set(oid, size);
    }
  return field(tree, 'truncated') === true;
}
