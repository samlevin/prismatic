// The §9.3 cache-first prompt layout for the spike: five blocks rendered
// deterministically, and the explicit breakpoint plan over them. Blocks 1-4
// are the reusable prefix candidates; block 5 is the uncached suffix that
// carries provenance, the diff and attempt metadata.
import type { SyntheticFile } from './synthetic.ts';

// L0 is the full file, L2 exported signatures with labeled omitted bodies,
// L3 the path and exported names (§9.4). The spike needs no L1: changing a
// representation is enough to move bytes.
export type RepresentationLevel = 'L0' | 'L2' | 'L3';

export interface SourceEntry {
  readonly file: SyntheticFile;
  readonly level: RepresentationLevel;
}

export interface Provenance {
  readonly baseRef: string;
  readonly mergeBase: string;
  readonly head: string;
  readonly frontier: string | null;
}

export interface PromptMaterial {
  // Opens block 1. A fresh nonce per scenario run keeps one run's cache
  // entries from warming another run's cold request.
  readonly nonce: string;
  readonly instructions: string;
  readonly globalRules: readonly SyntheticFile[];
  readonly context: readonly SourceEntry[];
  readonly scope: readonly SourceEntry[];
  readonly suffix: {
    readonly provenance: Provenance;
    readonly diff: string;
    readonly mode: 'full' | 'incremental';
    readonly attempt: number;
  };
}

export type BlockNumber = 1 | 2 | 3 | 4 | 5;
export type PrefixBlock = 1 | 2 | 3 | 4;

export interface RenderedBlock {
  readonly block: BlockNumber;
  readonly text: string;
}

const byPath = <T extends { readonly path: string }>(a: T, b: T): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

function numbered(text: string): string {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body
    .split('\n')
    .map((line, i) => `${i + 1}| ${line}`)
    .join('\n');
}

export function renderRepresentation(entry: SourceEntry): string {
  const { file, level } = entry;
  const head = `<file path="${file.path}" blob="${file.blobId}" level="${level}">`;
  if (level === 'L0') return `${head}\n${numbered(file.text)}\n</file>`;
  const lines = file.text.split('\n');
  const exported = lines
    .map((line, i) => ({ line, number: i + 1 }))
    .filter(({ line }) => line.startsWith('export function '));
  if (level === 'L3') {
    const names = exported.map(({ line }) =>
      line.slice('export function '.length, line.indexOf('(')),
    );
    return `${head}\nexports: ${names.join(', ')}\n</file>`;
  }
  const signatures = exported.map(
    ({ line, number }) => `${number}| ${line} /* body omitted */ }`,
  );
  return `${head}\n${signatures.join('\n')}\n</file>`;
}

function renderSources(entries: readonly SourceEntry[]): string {
  return [...entries]
    .sort((a, b) => byPath(a.file, b.file))
    .map(renderRepresentation)
    .join('\n');
}

export function renderBlocks(material: PromptMaterial): RenderedBlock[] {
  const { suffix } = material;
  const rules = [...material.globalRules]
    .sort(byPath)
    .map(
      (rule) =>
        `<rule path="${rule.path}" blob="${rule.blobId}">\n${rule.text}</rule>`,
    )
    .join('\n');
  const provenance = suffix.provenance;
  return [
    { block: 1, text: `run ${material.nonce}\n${material.instructions}` },
    { block: 2, text: rules },
    { block: 3, text: renderSources(material.context) },
    { block: 4, text: renderSources(material.scope) },
    {
      block: 5,
      text: [
        `mode: ${suffix.mode}`,
        `attempt: ${suffix.attempt}`,
        `base ref: ${provenance.baseRef}`,
        `merge base: ${provenance.mergeBase}`,
        `head: ${provenance.head}`,
        `frontier: ${provenance.frontier ?? 'none'}`,
        '<diff>',
        suffix.diff,
        '</diff>',
      ].join('\n'),
    },
  ];
}

export interface CachingOptions {
  // false sends explicit mode with no breakpoints (§9.3).
  readonly enabled: boolean;
  // caching.contextBreakpoints: BP3.
  readonly contextBreakpoints: boolean;
  // caching.changedFileBreakpoint: BP4, off by default in production.
  readonly changedFileBreakpoint: boolean;
  // The provider's minimum cacheable prefix. Short prefixes are not padded.
  readonly minimumPrefixTokens: number;
}

export const maxBreakpoints = 4;

export type SkipReason =
  'caching-disabled' | 'boundary-disabled' | 'coincident' | 'below-minimum';

export interface PlannedBoundary {
  readonly afterBlock: PrefixBlock;
  // Tokens from the start of the input through this boundary, as the
  // supplied counter measured them.
  readonly prefixTokens: number;
}

export interface SkippedBoundary {
  readonly afterBlock: PrefixBlock;
  readonly reason: SkipReason;
}

export interface BreakpointPlan {
  readonly breakpoints: readonly PlannedBoundary[];
  readonly skipped: readonly SkippedBoundary[];
}

// Chooses explicit breakpoints after blocks 1-4. `prefixTokens(k)` returns
// the token count from the start of the input through block k. An empty
// block's boundary coincides with the one before it and is coalesced; a
// prefix under the provider minimum gets no breakpoint.
export function planBreakpoints(
  blocks: readonly RenderedBlock[],
  prefixTokens: (afterBlock: PrefixBlock) => number,
  options: CachingOptions,
): BreakpointPlan {
  const breakpoints: PlannedBoundary[] = [];
  const skipped: SkippedBoundary[] = [];
  for (const afterBlock of [1, 2, 3, 4] as const) {
    const text = blocks.find((b) => b.block === afterBlock)?.text ?? '';
    let reason: SkipReason | undefined;
    let tokens = 0;
    if (!options.enabled) reason = 'caching-disabled';
    else if (
      (afterBlock === 3 && !options.contextBreakpoints) ||
      (afterBlock === 4 && !options.changedFileBreakpoint)
    )
      reason = 'boundary-disabled';
    else if (text === '') reason = 'coincident';
    else {
      tokens = prefixTokens(afterBlock);
      if (tokens < options.minimumPrefixTokens) reason = 'below-minimum';
    }
    if (reason === undefined) {
      breakpoints.push({ afterBlock, prefixTokens: tokens });
    } else skipped.push({ afterBlock, reason });
  }
  // Four candidates never exceed the provider's limit of four writes.
  return { breakpoints, skipped };
}
