// Usage parsing, the §9.5 cost formula and the conservative pre-request
// reservation, over a small versioned price catalog. The spike prices its
// own requests with these so it can stop before the evaluation budget runs
// out; production pricing belongs to CapabilityRegistry (§9.5).

export interface PriceRow {
  // Inclusive upper bound on total input tokens for this row; null is
  // unbounded.
  readonly maxInputTokens: number | null;
  // USD per million tokens. null means the rate is not known, so any cost
  // that needs it is unknown too.
  readonly inputPerMillion: number | null;
  readonly cacheWritePerMillion: number | null;
  readonly cachedInputPerMillion: number | null;
  readonly outputPerMillion: number | null;
}

export interface ModelPrices {
  readonly model: string;
  readonly catalogVersion: string;
  readonly source: string;
  readonly rows: readonly PriceRow[];
}

// Sol standard-tier rates implied by the §9.5 worked example: $2.00 input,
// 1.25x for writes, 0.05x for reads, $10.00 output, all per million tokens.
// The long-context row above 272K input is not in the specification, so it
// stays unknown and the spike never plans a request that needs it.
export const priceCatalog: readonly ModelPrices[] = [
  {
    model: 'gpt-6.1-sol',
    catalogVersion: 'spike-2026-10',
    source:
      'Specification §9.5 worked example. Confirm against the model pricing page before a live run.',
    rows: [
      {
        maxInputTokens: 272_000,
        inputPerMillion: 2.0,
        cacheWritePerMillion: 2.5,
        cachedInputPerMillion: 0.1,
        outputPerMillion: 10.0,
      },
      {
        maxInputTokens: null,
        inputPerMillion: null,
        cacheWritePerMillion: null,
        cachedInputPerMillion: null,
        outputPerMillion: null,
      },
    ],
  },
];

export function pricesFor(model: string): ModelPrices {
  const prices = priceCatalog.find((entry) => entry.model === model);
  if (prices === undefined) {
    throw new RangeError(`No price catalog entry for ${model}.`);
  }
  return prices;
}

export function rowFor(prices: ModelPrices, inputTokens: number): PriceRow {
  const row = prices.rows.find(
    (candidate) =>
      candidate.maxInputTokens === null ||
      inputTokens <= candidate.maxInputTokens,
  );
  if (row === undefined) {
    throw new RangeError(`No price row covers ${inputTokens} input tokens.`);
  }
  return row;
}

export interface Usage {
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export type UsageResult =
  | { readonly kind: 'known'; readonly usage: Usage }
  | { readonly kind: 'unknown'; readonly reason: string };

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

// Reads a Responses `usage` object. Missing usage is unknown, never zero, and
// counters that are negative, fractional or inconsistent are refused.
export function parseUsage(raw: unknown): UsageResult {
  if (raw === undefined || raw === null) {
    return { kind: 'unknown', reason: 'usage missing' };
  }
  const inputTokens = count(field(raw, 'input_tokens'));
  const outputTokens = count(field(raw, 'output_tokens'));
  const inputDetails = field(raw, 'input_tokens_details');
  const cachedTokens = count(field(inputDetails, 'cached_tokens'));
  const cacheWriteTokens = count(field(inputDetails, 'cache_write_tokens'));
  const reasoningTokens = count(
    field(field(raw, 'output_tokens_details'), 'reasoning_tokens'),
  );
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cachedTokens === undefined ||
    cacheWriteTokens === undefined ||
    reasoningTokens === undefined
  ) {
    return { kind: 'unknown', reason: 'usage counter missing or invalid' };
  }
  if (cachedTokens + cacheWriteTokens > inputTokens) {
    return {
      kind: 'unknown',
      reason: 'cached and written tokens exceed input tokens',
    };
  }
  if (reasoningTokens > outputTokens) {
    return { kind: 'unknown', reason: 'reasoning tokens exceed output tokens' };
  }
  return {
    kind: 'known',
    usage: {
      inputTokens,
      cachedTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
    },
  };
}

export interface Cost {
  readonly ordinaryInputUsd: number;
  readonly cacheWriteUsd: number;
  readonly cachedInputUsd: number;
  readonly outputUsd: number;
  // What the written tokens cost beyond ordinary input processing.
  readonly writePremiumUsd: number;
  readonly totalUsd: number;
}

const perToken = (perMillion: number): number => perMillion / 1_000_000;

function known(rate: number | null, what: string): number {
  if (rate === null) throw new RangeError(`The ${what} rate is unknown.`);
  return perToken(rate);
}

// §9.5: ordinaryInput = input - cached - written, each priced at its rate,
// with the row chosen from total input. Output includes reasoning.
export function costOf(usage: Usage, prices: ModelPrices): Cost {
  const row = rowFor(prices, usage.inputTokens);
  const input = known(row.inputPerMillion, 'input');
  const write = known(row.cacheWritePerMillion, 'cache write');
  const cached = known(row.cachedInputPerMillion, 'cached input');
  const output = known(row.outputPerMillion, 'output');
  const ordinary =
    usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens;
  const ordinaryInputUsd = ordinary * input;
  const cacheWriteUsd = usage.cacheWriteTokens * write;
  const cachedInputUsd = usage.cachedTokens * cached;
  const outputUsd = usage.outputTokens * output;
  return {
    ordinaryInputUsd,
    cacheWriteUsd,
    cachedInputUsd,
    outputUsd,
    writePremiumUsd: usage.cacheWriteTokens * (write - input),
    totalUsd: ordinaryInputUsd + cacheWriteUsd + cachedInputUsd + outputUsd,
  };
}

// The most one request can cost, assuming no cache hit: every planned input
// token at the dearer of the ordinary and write rates, plus the full output
// ceiling. `inputMargin` scales the planned input for tokenizer error.
export function reservationFor(
  plannedInputTokens: number,
  maxOutputTokens: number,
  prices: ModelPrices,
  inputMargin = 1,
): number {
  // Rounded first so 100000 * 1.1 is 110000, not 110001.
  const input = Math.ceil(
    Math.round(plannedInputTokens * inputMargin * 1e6) / 1e6,
  );
  const row = rowFor(prices, input);
  const inputRate = Math.max(
    known(row.inputPerMillion, 'input'),
    known(row.cacheWritePerMillion, 'cache write'),
  );
  return (
    input * inputRate + maxOutputTokens * known(row.outputPerMillion, 'output')
  );
}
