// Reads what the spike needs from a Responses API result and aggregates step
// records per scenario. Responses are read as untyped JSON so a field the
// provider leaves out is recorded as absent instead of failing the run.
import type { Attribution } from './attribution.ts';
import type { PlannedBoundary } from './layout.ts';
import type { Cost, Usage, UsageResult } from './pricing.ts';
import { parseUsage } from './pricing.ts';

export interface ResponseReading {
  readonly id: string | null;
  readonly status: string | null;
  readonly incompleteReason: string | null;
  readonly usage: UsageResult;
  // reasoning.effort as the response reports it: the effective effort when
  // the provider fills it in, otherwise the echoed request value.
  readonly reportedEffort: string | null;
  // configuration_update items the response echoed back, if any.
  readonly configurationUpdates: readonly unknown[];
  readonly diagnostics: unknown;
  readonly serviceTier: string | null;
  readonly outputText: string | null;
}

function get(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

function outputText(response: unknown): string | null {
  const direct = text(get(response, 'output_text'));
  if (direct !== null) return direct;
  const output = get(response, 'output');
  if (!Array.isArray(output)) return null;
  const parts = output
    .filter((item) => get(item, 'type') === 'message')
    .flatMap((item) => {
      const content = get(item, 'content');
      return Array.isArray(content) ? content : [];
    })
    .filter((part) => get(part, 'type') === 'output_text')
    .map((part) => text(get(part, 'text')) ?? '');
  return parts.length === 0 ? null : parts.join('');
}

export function readResponse(response: unknown): ResponseReading {
  const output = get(response, 'output');
  return {
    id: text(get(response, 'id')),
    status: text(get(response, 'status')),
    incompleteReason: text(get(get(response, 'incomplete_details'), 'reason')),
    usage: parseUsage(get(response, 'usage')),
    reportedEffort: text(get(get(response, 'reasoning'), 'effort')),
    configurationUpdates: Array.isArray(output)
      ? output.filter((item) => get(item, 'type') === 'configuration_update')
      : [],
    diagnostics: get(response, 'prompt_cache_diagnostics') ?? null,
    serviceTier: text(get(response, 'service_tier')),
    outputText: outputText(response),
  };
}

export type StepStatus =
  // Built and priced by a dry run; nothing was sent.
  | 'planned'
  | 'completed'
  | 'incomplete'
  | 'failed'
  | 'refused-budget'
  | 'error';

export interface StepRecord {
  readonly scenario: string;
  readonly step: string;
  readonly settingsIdentity: string;
  readonly requestEffort: string;
  readonly updateEffort: string | null;
  readonly reportedEffort: string | null;
  readonly configurationUpdates: readonly unknown[];
  readonly breakpoints: readonly PlannedBoundary[];
  // Provider counts of the input cut after each planned boundary, keyed by
  // block number; estimates of where the boundaries fall.
  readonly providerPrefixTokens: Readonly<Record<string, number>>;
  readonly localInputTokens: number;
  readonly providerInputTokens: number | null;
  readonly status: StepStatus;
  readonly incompleteReason: string | null;
  readonly usage: Usage | null;
  readonly usageUnknownReason: string | null;
  readonly reservationUsd: number;
  readonly cost: Cost | null;
  readonly elapsedMs: number;
  // Wall time since the previous step of the same scenario finished.
  readonly sincePreviousMs: number | null;
  readonly comparisonResponseId: string | null;
  readonly diagnostics: unknown;
  readonly attribution: Attribution | null;
  // null when no output could be parsed as JSON.
  readonly schemaErrors: readonly string[] | null;
  readonly serviceTier: string | null;
  readonly error: string | null;
}

export interface ScenarioTotals {
  readonly scenario: string;
  readonly requests: number;
  readonly completed: number;
  readonly unknownUsage: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  // Sum over requests with known usage; unknown charges are counted in
  // `unknownUsage` and held in the budget at their reservation.
  readonly knownCostUsd: number;
  readonly writePremiumUsd: number;
  readonly elapsedMs: number;
}

// Totals per scenario, in first-seen order. Planned steps and budget
// refusals sent nothing and are left out.
export function totalsByScenario(
  records: readonly StepRecord[],
): ScenarioTotals[] {
  const order: string[] = [];
  const groups = new Map<string, StepRecord[]>();
  for (const record of records) {
    if (!groups.has(record.scenario)) {
      order.push(record.scenario);
      groups.set(record.scenario, []);
    }
    groups.get(record.scenario)?.push(record);
  }
  return order.map((scenario) => {
    const sent = (groups.get(scenario) ?? []).filter(
      (r) => r.status !== 'refused-budget' && r.status !== 'planned',
    );
    const sum = (pick: (r: StepRecord) => number): number =>
      sent.reduce((total, r) => total + pick(r), 0);
    return {
      scenario,
      requests: sent.length,
      completed: sent.filter((r) => r.status === 'completed').length,
      unknownUsage: sent.filter((r) => r.usage === null).length,
      inputTokens: sum((r) => r.usage?.inputTokens ?? 0),
      cachedTokens: sum((r) => r.usage?.cachedTokens ?? 0),
      cacheWriteTokens: sum((r) => r.usage?.cacheWriteTokens ?? 0),
      outputTokens: sum((r) => r.usage?.outputTokens ?? 0),
      reasoningTokens: sum((r) => r.usage?.reasoningTokens ?? 0),
      knownCostUsd: sum((r) => r.cost?.totalUsd ?? 0),
      writePremiumUsd: sum((r) => r.cost?.writePremiumUsd ?? 0),
      elapsedMs: sum((r) => r.elapsedMs),
    };
  });
}
