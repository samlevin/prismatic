// Cost accounting for evaluation runs, as evals/protocol.md defines it.
// Every inference request a run sends is billed, including retries and
// failed or uncertain attempts. A request without reported usage is charged
// its full pre-request reservation, never zero. Judge and curation requests
// go to a separate research ledger and never count as reviewer cost.

// USD per million tokens.
export interface Rates {
  readonly inputPerMillion: number;
  readonly cacheWritePerMillion: number;
  readonly cachedInputPerMillion: number;
  readonly outputPerMillion: number;
}

export interface Usage {
  readonly inputTokens: number;
  // Both are subsets of inputTokens.
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  // A subset of outputTokens.
  readonly reasoningTokens: number;
}

export const requestPurposes = [
  'discovery',
  'assessment',
  'verification',
  'research',
] as const;
export type RequestPurpose = (typeof requestPurposes)[number];

export const requestOutcomes = [
  'completed',
  'failed',
  'uncertain',
  'refused-budget',
] as const;
export type RequestOutcome = (typeof requestOutcomes)[number];

export interface RequestRecord {
  readonly purpose: RequestPurpose;
  readonly outcome: RequestOutcome;
  // null when the provider reported no usage, or the request was never sent.
  readonly usage: Usage | null;
  // The worst-case cost reserved before the request was sent.
  readonly reservedUsd: number;
}

export interface RequestCost {
  readonly usd: number;
  // False when the cost is the reservation because usage is unknown.
  readonly known: boolean;
}

function checkUsage(usage: Usage): void {
  for (const [name, value] of Object.entries(usage)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer.`);
    }
  }
  if (usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens) {
    throw new RangeError('Cached and written tokens exceed input tokens.');
  }
  if (usage.reasoningTokens > usage.outputTokens) {
    throw new RangeError('Reasoning tokens exceed output tokens.');
  }
}

// The §9.5 formula: uncached input, cache writes, cached reads and output
// (which includes reasoning), each at its own rate.
export function usageCost(usage: Usage, rates: Rates): number {
  checkUsage(usage);
  const ordinary =
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens;
  return (
    (ordinary * rates.inputPerMillion +
      usage.cacheWriteTokens * rates.cacheWritePerMillion +
      usage.cachedInputTokens * rates.cachedInputPerMillion +
      usage.outputTokens * rates.outputPerMillion) /
    1_000_000
  );
}

export function requestCost(record: RequestRecord, rates: Rates): RequestCost {
  if (!(record.reservedUsd >= 0)) {
    throw new RangeError('A reservation must be a non-negative amount.');
  }
  if (record.outcome === 'refused-budget') {
    if (record.usage !== null) {
      throw new RangeError('A request refused for budget was never sent.');
    }
    return { usd: 0, known: true };
  }
  if (record.usage === null) return { usd: record.reservedUsd, known: false };
  return { usd: usageCost(record.usage, rates), known: true };
}

export interface CostLedger {
  readonly reviewerUsd: number;
  // Spend on failed and uncertain reviewer requests, included in reviewerUsd.
  readonly failedAttemptUsd: number;
  readonly researchUsd: number;
  // Reviewer requests sent, and requests refused before sending.
  readonly requests: number;
  readonly refused: number;
  // False when any reviewer request was charged its reservation.
  readonly usageComplete: boolean;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export function costLedger(
  records: readonly RequestRecord[],
  rates: Rates,
): CostLedger {
  let reviewerUsd = 0;
  let failedAttemptUsd = 0;
  let researchUsd = 0;
  let requests = 0;
  let refused = 0;
  let usageComplete = true;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  for (const record of records) {
    const cost = requestCost(record, rates);
    if (record.purpose === 'research') {
      researchUsd += cost.usd;
      continue;
    }
    if (record.outcome === 'refused-budget') {
      refused += 1;
      continue;
    }
    requests += 1;
    reviewerUsd += cost.usd;
    if (record.outcome !== 'completed') failedAttemptUsd += cost.usd;
    if (!cost.known) usageComplete = false;
    if (record.usage !== null) {
      inputTokens += record.usage.inputTokens;
      cachedInputTokens += record.usage.cachedInputTokens;
      cacheWriteTokens += record.usage.cacheWriteTokens;
      outputTokens += record.usage.outputTokens;
      reasoningTokens += record.usage.reasoningTokens;
    }
  }
  return {
    reviewerUsd,
    failedAttemptUsd,
    researchUsd,
    requests,
    refused,
    usageComplete,
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
  };
}

// Cached read tokens as a share of cache-written tokens; null with no writes.
export function cacheReadShare(
  ledger: Pick<CostLedger, 'cachedInputTokens' | 'cacheWriteTokens'>,
): number | null {
  return ledger.cacheWriteTokens === 0
    ? null
    : ledger.cachedInputTokens / ledger.cacheWriteTokens;
}

// The read share at which caching pays for its write premium: the premium
// per written token over the saving per read token. 26.3% at the §9.5 rates.
export function cacheBreakEvenShare(rates: Rates): number {
  const saving = rates.inputPerMillion - rates.cachedInputPerMillion;
  if (!(saving > 0))
    throw new RangeError('Cached reads must cost less than input.');
  return (rates.cacheWritePerMillion - rates.inputPerMillion) / saving;
}

// Reviewer dollars per validated defect; null when nothing was found.
export function costPerDefect(
  reviewerUsd: number,
  defectsFound: number,
): number | null {
  return defectsFound === 0 ? null : reviewerUsd / defectsFound;
}
