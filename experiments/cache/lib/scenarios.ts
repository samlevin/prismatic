// The spike's scenario matrix and the synthetic prompt material each step
// sends. Criteria numbers are the acceptance criteria of #142 in order. A
// hypothesis says what a step is meant to show; only the recorded run says
// what happened.
import type {
  CachingOptions,
  PromptMaterial,
  RepresentationLevel,
  SourceEntry,
} from './layout.ts';
import type { ReasoningPlan } from './request.ts';
import type { SchemaVariant } from './schema.ts';
import {
  editSource,
  syntheticFile,
  syntheticProse,
  syntheticSha,
  syntheticSource,
} from './synthetic.ts';

export interface VariantSpec {
  // Edit one line in the first or last block 4 file (sorted by path).
  readonly editScope?: 'first' | 'last';
  // Add a file to the discovery scope and its neighbor to block 3.
  readonly widenScope?: boolean;
  // Representation of the first block 3 file; L0 when absent.
  readonly contextLevel?: RepresentationLevel;
  // Change only the base-tip provenance in block 5.
  readonly rebased?: boolean;
  // Blocks 1-4 together stay under the provider minimum.
  readonly short?: boolean;
}

export interface StepSpec {
  readonly label: string;
  readonly variant: VariantSpec;
  readonly reasoning: ReasoningPlan;
  readonly caching: CachingOptions;
  readonly schema: SchemaVariant;
  // Label of an earlier step to name as the cache diagnostics comparison.
  readonly compareWith?: string;
}

export interface ScenarioSpec {
  readonly id: string;
  readonly criteria: readonly number[];
  readonly title: string;
  readonly hypothesis: string;
  readonly steps: readonly StepSpec[];
}

export const minimumPrefixTokens = 1024;

// The spike enables BP3 and BP4 so every boundary is measured; production
// keeps both off until measurements justify them (§9.3).
export const measuredCaching: CachingOptions = {
  enabled: true,
  contextBreakpoints: true,
  changedFileBreakpoint: true,
  minimumPrefixTokens,
};

export const disabledCaching: CachingOptions = {
  ...measuredCaching,
  enabled: false,
};

const high: ReasoningPlan = { requestEffort: 'high' };
const medium: ReasoningPlan = { requestEffort: 'medium' };
const highUpdatedToMedium: ReasoningPlan = {
  requestEffort: 'high',
  updateEffort: 'medium',
};

function step(
  label: string,
  variant: VariantSpec = {},
  overrides: Partial<Omit<StepSpec, 'label' | 'variant'>> = {},
): StepSpec {
  return {
    label,
    variant,
    reasoning: high,
    caching: measuredCaching,
    schema: 'full',
    ...overrides,
  };
}

// The prime step every change scenario starts from, then one changed step
// compared against it.
function primedChange(
  id: string,
  title: string,
  hypothesis: string,
  variant: VariantSpec,
): ScenarioSpec {
  return {
    id,
    criteria: [1, 3],
    title,
    hypothesis,
    steps: [step('prime'), step('changed', variant, { compareWith: 'prime' })],
  };
}

export const scenarios: readonly ScenarioSpec[] = [
  {
    id: 'cold-warm',
    criteria: [1, 3],
    title: 'Cold request, then two identical repeats',
    hypothesis:
      'The cold request writes up to BP4; repeats read through BP4 and write nothing new.',
    steps: [
      step('cold'),
      step('warm-1', {}, { compareWith: 'cold' }),
      step('warm-2', {}, { compareWith: 'warm-1' }),
    ],
  },
  primedChange(
    'block4-early-change',
    'One changed line in the first block 4 file',
    'Reuse stops at BP3; BP4 is rewritten.',
    { editScope: 'first' },
  ),
  primedChange(
    'block4-late-change',
    'One changed line in the last block 4 file',
    'Reuse still stops at BP3: any changed byte before BP4 invalidates it, however late.',
    { editScope: 'last' },
  ),
  primedChange(
    'scope-change',
    'The discovery scope gains a file and block 3 its neighbor',
    'Reuse stops at BP2.',
    { widenScope: true },
  ),
  primedChange(
    'representation-change',
    'One block 3 file drops from L0 to L2',
    'Reuse stops at BP2.',
    { contextLevel: 'L2' },
  ),
  primedChange(
    'base-provenance-only',
    'Only the base-tip provenance in block 5 changes',
    'Reuse reaches BP4, because provenance sits in the uncached suffix.',
    { rebased: true },
  ),
  {
    id: 'caching-disabled',
    criteria: [1, 3],
    title: 'Explicit mode with no breakpoints, sent twice',
    hypothesis: 'Neither request reads or writes the cache.',
    steps: [
      step('first', {}, { caching: disabledCaching }),
      step('second', {}, { caching: disabledCaching, compareWith: 'first' }),
    ],
  },
  {
    id: 'short-stable-prefix',
    criteria: [1, 3],
    title: 'A stable prefix under the minimum in a request over it',
    hypothesis:
      'No breakpoint qualifies, so nothing is written or read even though the whole request exceeds the minimum.',
    steps: [
      step('first', { short: true }),
      step('second', { short: true }, { compareWith: 'first' }),
    ],
  },
  {
    id: 'effort-high-to-medium',
    criteria: [2, 3],
    title: 'Request-level effort drops from high to medium',
    hypothesis:
      'The medium request misses the high population; a second medium request reads the medium population.',
    steps: [
      step('high'),
      step('medium', {}, { reasoning: medium, compareWith: 'high' }),
      step('medium-again', {}, { reasoning: medium, compareWith: 'medium' }),
    ],
  },
  {
    id: 'effort-configuration-update',
    criteria: [2, 3],
    title:
      'Request-level high with a configuration_update to medium after block 4',
    hypothesis:
      'The updated request reuses the high prefix through BP4 and the response reports medium as its effective effort.',
    steps: [
      step('high'),
      step(
        'updated',
        {},
        { reasoning: highUpdatedToMedium, compareWith: 'high' },
      ),
      step(
        'updated-again',
        {},
        {
          reasoning: highUpdatedToMedium,
          compareWith: 'updated',
        },
      ),
    ],
  },
  {
    id: 'schema-variants',
    criteria: [4],
    title: 'The incremental and reconcile schema variants under strict mode',
    hypothesis:
      'Both variants are accepted and every completed response validates against its schema.',
    steps: [
      step('incremental', {}, { schema: 'incremental', reasoning: medium }),
      step('reconcile', {}, { schema: 'reconcile', reasoning: medium }),
    ],
  },
];

function entries(
  prefix: string,
  seed: number,
  count: number,
  functions: number,
): SourceEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    file: syntheticSource(`${prefix}/module${i}.ts`, seed + i, functions),
    level: 'L0' as const,
  }));
}

function diffOf(scope: readonly SourceEntry[], lines: number): string {
  return scope
    .flatMap(({ file }) => [
      `--- a/${file.path}`,
      `+++ b/${file.path}`,
      ...file.text
        .split('\n')
        .slice(0, lines)
        .map((line) => `+${line}`),
    ])
    .join('\n');
}

// The material for one step. Equal nonces and variants render equal bytes.
export function materialFor(
  nonce: string,
  variant: VariantSpec,
): PromptMaterial {
  const short = variant.short === true;
  let scope = entries('src/scope', 400, short ? 1 : 4, short ? 2 : 20);
  let context = short ? [] : entries('src/context', 300, 4, 20);
  if (variant.widenScope === true) {
    scope = [...scope, ...entries('src/scope-added', 500, 1, 20)];
    context = [...context, ...entries('src/context-added', 600, 1, 20)];
  }
  if (variant.contextLevel !== undefined && context[0] !== undefined) {
    context = [
      { ...context[0], level: variant.contextLevel },
      ...context.slice(1),
    ];
  }
  // The diff is taken before any edit, so block 5 stays byte-equal across a
  // scenario's steps unless the variant changes provenance. A short variant
  // still sends a request over the minimum: its diff is long.
  const diff = short
    ? diffOf(entries('src/diff-only', 700, 3, 20), 200)
    : diffOf(scope, 12);
  if (variant.editScope !== undefined) {
    const index = variant.editScope === 'first' ? 0 : scope.length - 1;
    scope = scope.map((entry, i) =>
      i === index
        ? {
            ...entry,
            file: editSource(entry.file, 0.5, variant.editScope ?? ''),
          }
        : entry,
    );
  }
  return {
    nonce,
    instructions: syntheticProse(100, short ? 1 : 14),
    globalRules: short
      ? []
      : [0, 1, 2].map((i) =>
          syntheticFile(
            `.prismatic/rules/rule${i}.md`,
            syntheticProse(200 + i, 4),
          ),
        ),
    context,
    scope,
    suffix: {
      provenance: {
        baseRef: syntheticSha(variant.rebased === true ? 'base-2' : 'base-1'),
        mergeBase: syntheticSha('merge-base'),
        head: syntheticSha('head'),
        frontier: null,
      },
      diff,
      mode: 'full',
      attempt: 1,
    },
  };
}
