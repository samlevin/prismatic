// Infers which planned boundary a response's cache counters correspond to.
// The provider reports only whole-response `cached_tokens` and
// `cache_write_tokens`; it does not say which breakpoint matched. Matching a
// counter to the nearest planned prefix position is an estimate, so every
// result carries `basis: 'inferred'` and is never reported as a
// provider-measured per-boundary hit (§9.3).
import type { PlannedBoundary, PrefixBlock } from './layout.ts';

export type BoundaryMatch =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'boundary';
      readonly afterBlock: PrefixBlock;
      readonly offsetTokens: number;
    }
  | { readonly kind: 'unmatched'; readonly nearestOffsetTokens: number | null };

export interface Attribution {
  readonly basis: 'inferred';
  // The boundary the cached prefix most plausibly ended at.
  readonly read: BoundaryMatch;
  // The furthest boundary the written tokens most plausibly reached, judged
  // from cached + written tokens.
  readonly write: BoundaryMatch;
}

function match(
  tokens: number,
  boundaries: readonly PlannedBoundary[],
  tolerance: number,
): BoundaryMatch {
  if (tokens === 0) return { kind: 'none' };
  let best: PlannedBoundary | undefined;
  for (const boundary of boundaries) {
    if (
      best === undefined ||
      Math.abs(boundary.prefixTokens - tokens) <
        Math.abs(best.prefixTokens - tokens)
    ) {
      best = boundary;
    }
  }
  if (best === undefined)
    return { kind: 'unmatched', nearestOffsetTokens: null };
  const offsetTokens = tokens - best.prefixTokens;
  if (Math.abs(offsetTokens) > tolerance * best.prefixTokens) {
    return { kind: 'unmatched', nearestOffsetTokens: offsetTokens };
  }
  return { kind: 'boundary', afterBlock: best.afterBlock, offsetTokens };
}

// `tolerance` is the relative distance, as a fraction of the boundary's
// position, within which a counter still counts as that boundary; it should
// come from the measured tokenizer margin.
export function attribute(
  cachedTokens: number,
  cacheWriteTokens: number,
  boundaries: readonly PlannedBoundary[],
  tolerance: number,
): Attribution {
  return {
    basis: 'inferred',
    read: match(cachedTokens, boundaries, tolerance),
    write:
      cacheWriteTokens === 0
        ? { kind: 'none' }
        : match(cachedTokens + cacheWriteTokens, boundaries, tolerance),
  };
}
