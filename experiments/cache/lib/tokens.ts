// Local tokenizer candidates and the margin between their counts and the
// provider's. No published tokenizer maps to gpt-6.1-sol, so the spike counts
// the same requests locally with each candidate and with the provider's
// input-token counting endpoint, fits the provider count as a linear
// function of each candidate's count to separate fixed request framing from
// per-token error, and selects the candidate whose fit is tightest. The
// fit's worst under-prediction is the margin to plan with: under-counting
// lets a plan the allocator believes fits exceed the ceiling.
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
  // The step that first sent this exact request, such as `cold-warm/cold`.
  readonly label: string;
  // The candidate's count of the rendered block text.
  readonly local: number;
  // The provider's count of the complete request, which adds message and
  // item framing and the response-format schema to the block text.
  readonly provider: number;
}

export interface MarginSummary {
  readonly tokenizer: string;
  readonly samples: number;
  // Least-squares fit of provider = slope * local + interceptTokens. The
  // intercept is the fixed framing and schema a complete request adds; the
  // slope is the tokenizer's proportional error. With one distinct local
  // count the slope is taken as 1.
  readonly slope: number;
  readonly interceptTokens: number;
  // Residuals of the fit relative to the provider count. Positive means the
  // fit predicted too few tokens.
  readonly worstUnderPredictionRatio: number;
  readonly worstAbsoluteResidualRatio: number;
  readonly meanAbsoluteResidualRatio: number;
  // The input margin to plan with on top of the fit: the worst
  // under-prediction, or 0.
  readonly requiredMarginRatio: number;
}

function fit(samples: readonly CountSample[]): {
  slope: number;
  intercept: number;
} {
  const n = samples.length;
  const meanX = samples.reduce((sum, s) => sum + s.local, 0) / n;
  const meanY = samples.reduce((sum, s) => sum + s.provider, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const s of samples) {
    sxx += (s.local - meanX) ** 2;
    sxy += (s.local - meanX) * (s.provider - meanY);
  }
  const slope = sxx === 0 ? 1 : sxy / sxx;
  return { slope, intercept: meanY - slope * meanX };
}

export function summarizeMargin(
  tokenizer: string,
  samples: readonly CountSample[],
): MarginSummary {
  if (samples.length === 0) {
    throw new RangeError('A margin needs at least one sample.');
  }
  const { slope, intercept } = fit(samples);
  const residuals = samples.map(
    (s) =>
      (s.provider - (slope * s.local + intercept)) / Math.max(1, s.provider),
  );
  const worstUnderPredictionRatio = Math.max(...residuals);
  return {
    tokenizer,
    samples: samples.length,
    slope,
    interceptTokens: intercept,
    worstUnderPredictionRatio,
    worstAbsoluteResidualRatio: Math.max(...residuals.map(Math.abs)),
    meanAbsoluteResidualRatio:
      residuals.reduce((sum, r) => sum + Math.abs(r), 0) / residuals.length,
    requiredMarginRatio: Math.max(0, worstUnderPredictionRatio),
  };
}

// The candidate whose fit leaves the smallest worst residual, ties broken by
// the slope's distance from 1, so fixed framing never counts as tokenizer
// error. Returns undefined when there is nothing to compare.
export function selectTokenizer(
  summaries: readonly MarginSummary[],
): MarginSummary | undefined {
  return [...summaries].sort(
    (a, b) =>
      a.worstAbsoluteResidualRatio - b.worstAbsoluteResidualRatio ||
      Math.abs(a.slope - 1) - Math.abs(b.slope - 1),
  )[0];
}
