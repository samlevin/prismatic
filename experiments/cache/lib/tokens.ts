// Local tokenizer candidates and the margin between their counts and the
// provider's. No published tokenizer maps to gpt-6.1-sol, so the spike counts
// the same requests locally with each candidate and with the provider's
// input-token counting endpoint, then selects the most accurate candidate
// and the margin it needs. Under-counting is the dangerous direction: it lets
// a plan the allocator believes fits exceed the ceiling. Over-counting only
// wastes budget, but a candidate that over-counts everything is not "safe",
// just inaccurate, so selection weighs both directions.
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';
import o200k from 'js-tiktoken/ranks/o200k_base';

export interface Tokenizer {
  readonly id: string;
  count(text: string): number;
}

function tiktoken(
  id: string,
  ranks: ConstructorParameters<typeof Tiktoken>[0],
): Tokenizer {
  let encoder: Tiktoken | undefined;
  return {
    id,
    count(text) {
      encoder ??= new Tiktoken(ranks);
      return encoder.encode(text, [], []).length;
    },
  };
}

// A deliberately crude baseline: four UTF-8 bytes per token.
export const byteHeuristic: Tokenizer = {
  id: 'utf8-bytes-div-4',
  count: (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4),
};

export const tokenizerCandidates: readonly Tokenizer[] = [
  tiktoken('o200k_base', o200k),
  tiktoken('cl100k_base', cl100k),
  byteHeuristic,
];

export interface CountSample {
  // What the sample is, such as `cold-warm/full-request`.
  readonly label: string;
  readonly local: number;
  readonly provider: number;
}

export interface MarginSummary {
  readonly tokenizer: string;
  readonly samples: number;
  // max((provider - local) / provider) over samples; positive means the
  // local count was low.
  readonly worstUnderCountRatio: number;
  readonly worstAbsoluteErrorRatio: number;
  readonly meanAbsoluteErrorRatio: number;
  // The input margin to plan with: the worst under-count, or 0.
  readonly requiredMarginRatio: number;
  // provider - local in tokens: the fixed framing a complete request adds
  // over its rendered text, when the ratio is near zero.
  readonly minOverheadTokens: number;
  readonly maxOverheadTokens: number;
}

export function summarizeMargin(
  tokenizer: string,
  samples: readonly CountSample[],
): MarginSummary {
  if (samples.length === 0) {
    throw new RangeError('A margin needs at least one sample.');
  }
  const ratios = samples.map(
    (s) => (s.provider - s.local) / Math.max(1, s.provider),
  );
  const overheads = samples.map((s) => s.provider - s.local);
  const worstUnderCountRatio = Math.max(...ratios);
  return {
    tokenizer,
    samples: samples.length,
    worstUnderCountRatio,
    worstAbsoluteErrorRatio: Math.max(...ratios.map(Math.abs)),
    requiredMarginRatio: Math.max(0, worstUnderCountRatio),
    meanAbsoluteErrorRatio:
      ratios.reduce((sum, r) => sum + Math.abs(r), 0) / ratios.length,
    minOverheadTokens: Math.min(...overheads),
    maxOverheadTokens: Math.max(...overheads),
  };
}

// The candidate with the smallest worst error in either direction, ties
// broken by mean error. Returns undefined when there is nothing to compare.
export function selectTokenizer(
  summaries: readonly MarginSummary[],
): MarginSummary | undefined {
  return [...summaries].sort(
    (a, b) =>
      a.worstAbsoluteErrorRatio - b.worstAbsoluteErrorRatio ||
      a.meanAbsoluteErrorRatio - b.meanAbsoluteErrorRatio,
  )[0];
}
