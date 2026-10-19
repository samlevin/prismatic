// Runs the scenario matrix against a provider, one request at a time, inside
// the evaluation budget. A dry run (no provider) builds and prices every
// request without sending anything. The live provider lives in
// openaiProvider.ts; tests pass a fake.
import { createHash } from 'node:crypto';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import type { InputTokenCountParams } from 'openai/resources/responses/input-tokens';
import { canonicalJson } from '../../../src/shared/canonical.ts';
import { normalizeError } from '../../../src/shared/errors.ts';
import type { SecretRedactor } from '../../../src/shared/redaction.ts';
import { attribute } from './attribution.ts';
import type { EvaluationBudget } from './budget.ts';
import { planBreakpoints, renderBlocks } from './layout.ts';
import type { PlannedBoundary, PrefixBlock, RenderedBlock } from './layout.ts';
import type { ModelPrices } from './pricing.ts';
import { costOf, reservationFor } from './pricing.ts';
import { readResponse } from './record.ts';
import type { StepRecord, StepStatus } from './record.ts';
import type { RequestPlan } from './request.ts';
import {
  buildRequest,
  countParams,
  inputThrough,
  settingsIdentity,
} from './request.ts';
import { materialFor } from './scenarios.ts';
import type { ScenarioSpec, StepSpec } from './scenarios.ts';
import { probeSchema, validate } from './schema.ts';
import type { CountSample, Tokenizer } from './tokens.ts';

export interface Provider {
  create(request: ResponseCreateParamsNonStreaming): Promise<unknown>;
  countInputTokens(params: InputTokenCountParams): Promise<number>;
}

export interface RunOptions {
  readonly runId: string;
  readonly model: string;
  readonly prices: ModelPrices;
  readonly maxOutputTokens: number;
  readonly budget: EvaluationBudget;
  // Plans breakpoints and local token counts.
  readonly tokenizer: Tokenizer;
  // Every candidate counted against the provider for tokenizer selection.
  readonly candidates: readonly Tokenizer[];
  // Planned input is scaled by this before reserving, for tokenizer error.
  readonly inputMargin: number;
  // Relative tolerance for inferred boundary attribution.
  readonly attributionTolerance: number;
  // Wait between steps of a scenario, so a write can land before a read.
  readonly settleMs: number;
  readonly provider: Provider | null;
  readonly redactor: SecretRedactor;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface PlannedStep {
  readonly scenario: ScenarioSpec;
  readonly step: StepSpec;
  readonly plan: RequestPlan;
  readonly request: ResponseCreateParamsNonStreaming;
  readonly blocks: readonly RenderedBlock[];
  readonly breakpoints: readonly PlannedBoundary[];
  readonly localInputTokens: number;
  readonly reservationUsd: number;
}

export function planStep(
  scenario: ScenarioSpec,
  step: StepSpec,
  options: RunOptions,
  comparisonResponseId?: string,
): PlannedStep {
  // One nonce per scenario run: steps of a scenario share a cache, scenarios
  // and runs do not.
  const nonce = `${options.runId}/${scenario.id}`;
  const blocks = renderBlocks(materialFor(nonce, step.variant));
  const through = (k: number): number =>
    blocks
      .filter((b) => b.block <= k)
      .reduce((sum, b) => sum + options.tokenizer.count(b.text), 0);
  const breakpoints = planBreakpoints(blocks, through, step.caching);
  const plan: RequestPlan = {
    model: options.model,
    blocks,
    breakpoints,
    reasoning: step.reasoning,
    maxOutputTokens: options.maxOutputTokens,
    schemaName: `review_probe_${step.schema}`,
    schema: probeSchema(step.schema),
    promptCacheKey: createHash('sha256')
      .update(nonce)
      .digest('hex')
      .slice(0, 32),
    ...(comparisonResponseId === undefined ? {} : { comparisonResponseId }),
  };
  const localInputTokens = through(5);
  return {
    scenario,
    step,
    plan,
    request: buildRequest(plan),
    blocks,
    breakpoints: breakpoints.breakpoints,
    localInputTokens,
    reservationUsd: reservationFor(
      localInputTokens,
      options.maxOutputTokens,
      options.prices,
      options.inputMargin,
    ),
  };
}

export interface RunResult {
  readonly records: readonly StepRecord[];
  // Local count against provider count of each distinct request, per
  // tokenizer candidate.
  readonly countSamples: Readonly<Record<string, readonly CountSample[]>>;
}

class Counter {
  readonly #provider: Provider;
  readonly #cache = new Map<string, number>();

  constructor(provider: Provider) {
    this.#provider = provider;
  }

  async count(params: InputTokenCountParams): Promise<number> {
    const key = canonicalJson(params);
    const known = this.#cache.get(key);
    if (known !== undefined) return known;
    const counted = await this.#provider.countInputTokens(params);
    this.#cache.set(key, counted);
    return counted;
  }
}

function parsed(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function runScenarios(
  scenarios: readonly ScenarioSpec[],
  options: RunOptions,
): Promise<RunResult> {
  const records: StepRecord[] = [];
  const samples: Record<string, CountSample[]> = Object.fromEntries(
    options.candidates.map((c) => [c.id, []]),
  );
  const provider = options.provider;
  const counter = provider === null ? null : new Counter(provider);
  for (const scenario of scenarios) {
    const responseIds = new Map<string, string>();
    let previousEnd: number | null = null;
    for (const step of scenario.steps) {
      const compare =
        step.compareWith === undefined
          ? undefined
          : responseIds.get(step.compareWith);
      const planned = planStep(scenario, step, options, compare);
      const label = `${scenario.id}/${step.label}`;
      const base = {
        scenario: scenario.id,
        step: step.label,
        settingsIdentity: settingsIdentity(planned.request),
        requestEffort: step.reasoning.requestEffort,
        updateEffort: step.reasoning.updateEffort ?? null,
        breakpoints: planned.breakpoints,
        localInputTokens: planned.localInputTokens,
        reservationUsd: planned.reservationUsd,
        comparisonResponseId: compare ?? null,
      };
      const empty = {
        reportedEffort: null,
        configurationUpdates: [],
        providerPrefixTokens: {},
        providerInputTokens: null,
        incompleteReason: null,
        usage: null,
        usageUnknownReason: null,
        cost: null,
        elapsedMs: 0,
        sincePreviousMs: null,
        diagnostics: null,
        attribution: null,
        schemaErrors: null,
        serviceTier: null,
        error: null,
      };
      if (provider === null || counter === null) {
        records.push({ ...base, ...empty, status: 'planned' });
        continue;
      }
      if (!options.budget.reserve(label, planned.reservationUsd)) {
        options.log(`${label}: refused, the budget cannot cover it`);
        records.push({ ...base, ...empty, status: 'refused-budget' });
        continue;
      }
      if (previousEnd !== null && options.settleMs > 0) {
        await options.sleep(options.settleMs);
      }
      const providerPrefixTokens: Record<string, number> = {};
      let providerInputTokens: number | null = null;
      const started = options.now();
      const sincePreviousMs =
        previousEnd === null ? null : started - previousEnd;
      try {
        providerInputTokens = await counter.count(countParams(planned.request));
        for (const candidate of options.candidates) {
          samples[candidate.id]?.push({
            label,
            local: planned.blocks.reduce(
              (sum, b) => sum + candidate.count(b.text),
              0,
            ),
            provider: providerInputTokens,
          });
        }
        for (const boundary of planned.breakpoints) {
          providerPrefixTokens[boundary.afterBlock] = await counter.count(
            countParams(
              planned.request,
              inputThrough(planned.plan, boundary.afterBlock as PrefixBlock),
            ),
          );
        }
        options.log(`${label}: sending`);
        const sentAt = options.now();
        const response = readResponse(await provider.create(planned.request));
        const finished = options.now();
        previousEnd = finished;
        const usage =
          response.usage.kind === 'known' ? response.usage.usage : null;
        const cost = usage === null ? null : costOf(usage, options.prices);
        options.budget.settle(label, cost?.totalUsd);
        if (response.id !== null) responseIds.set(step.label, response.id);
        const output = parsed(response.outputText);
        const status: StepStatus =
          response.status === 'completed'
            ? 'completed'
            : response.status === 'incomplete'
              ? 'incomplete'
              : 'failed';
        records.push({
          ...base,
          status,
          reportedEffort: response.reportedEffort,
          configurationUpdates: response.configurationUpdates,
          providerPrefixTokens,
          providerInputTokens,
          incompleteReason: response.incompleteReason,
          usage,
          usageUnknownReason:
            response.usage.kind === 'unknown' ? response.usage.reason : null,
          cost,
          elapsedMs: finished - sentAt,
          sincePreviousMs,
          diagnostics: response.diagnostics,
          attribution:
            usage === null
              ? null
              : attribute(
                  usage.cachedTokens,
                  usage.cacheWriteTokens,
                  planned.breakpoints.map((b) => ({
                    afterBlock: b.afterBlock,
                    prefixTokens:
                      providerPrefixTokens[b.afterBlock] ?? b.prefixTokens,
                  })),
                  options.attributionTolerance,
                ),
          schemaErrors:
            output === undefined ? null : validate(output, planned.plan.schema),
          serviceTier: response.serviceTier,
          error: null,
        });
      } catch (error) {
        // The charge is unknown: the request may have reached the provider.
        options.budget.settle(label, undefined);
        previousEnd = options.now();
        const normalized = normalizeError(error, options.redactor);
        options.log(`${label}: ${normalized.name}: ${normalized.message}`);
        records.push({
          ...base,
          ...empty,
          providerPrefixTokens,
          providerInputTokens,
          status: 'error',
          sincePreviousMs,
          elapsedMs: previousEnd - started,
          error: `${normalized.name} (${normalized.code}): ${normalized.message}`,
        });
      }
    }
  }
  return { records, countSamples: samples };
}
