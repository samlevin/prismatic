import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { describe, expect, test, vi } from 'vitest';
import { createSecretRedactor } from '../../../src/shared/redaction.ts';
import { EvaluationBudget } from './budget.ts';
import { pricesFor } from './pricing.ts';
import type { Provider, RunOptions } from './runner.ts';
import { planStep, runScenarios } from './runner.ts';
import type { ScenarioSpec } from './scenarios.ts';
import { scenarios } from './scenarios.ts';
import type { Tokenizer } from './tokens.ts';
import { byteHeuristic } from './tokens.ts';

const coldWarm = scenarios.find((s) => s.id === 'cold-warm') as ScenarioSpec;

// A tokenizer that is cheap and exact enough for planning in tests.
const words: Tokenizer = {
  id: 'words',
  count: (text) => (text === '' ? 0 : text.split(/\s+/).length),
};

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  let clock = 0;
  return {
    runId: 'run',
    model: 'gpt-6.1-sol',
    prices: pricesFor('gpt-6.1-sol'),
    maxOutputTokens: 1000,
    budget: new EvaluationBudget(5),
    tokenizer: words,
    candidates: [words, byteHeuristic],
    inputMargin: 1.1,
    attributionTolerance: 0.05,
    settleMs: 0,
    provider: null,
    redactor: createSecretRedactor(['sk-test-secret-value']),
    now: () => (clock += 100),
    sleep: () => Promise.resolve(),
    log: () => undefined,
    ...overrides,
  };
}

const validOutput = JSON.stringify({
  candidateFindings: [],
  priorFindingUpdates: [],
  walkthrough: null,
  limitations: [],
});

// A provider that answers every request with the given cache counters and
// counts tokens as the planner does, plus a fixed framing overhead.
function fakeProvider(
  respond: (request: ResponseCreateParamsNonStreaming, n: number) => unknown,
): Provider & {
  create: ReturnType<typeof vi.fn>;
  countInputTokens: ReturnType<typeof vi.fn>;
} {
  let n = 0;
  return {
    create: vi.fn(async (request: ResponseCreateParamsNonStreaming) =>
      respond(request, n++),
    ),
    countInputTokens: vi.fn(async (params: { input?: unknown }) => {
      const text = JSON.stringify(params.input);
      return text.split(/\s+/).length + 7;
    }),
  };
}

function response(id: string, cached: number, written: number): unknown {
  return {
    id,
    status: 'completed',
    usage: {
      input_tokens: 20_000,
      input_tokens_details: {
        cached_tokens: cached,
        cache_write_tokens: written,
      },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 200 },
    },
    reasoning: { effort: 'high' },
    service_tier: 'default',
    output_text: validOutput,
  };
}

describe('planStep', () => {
  test('plans breakpoints, input and a worst-case reservation per step', () => {
    const [cold] = coldWarm.steps;
    if (cold === undefined) throw new Error('no step');
    const planned = planStep(coldWarm, cold, options());
    expect(planned.breakpoints.map((b) => b.afterBlock)).toEqual([1, 2, 3, 4]);
    expect(planned.localInputTokens).toBeGreaterThan(
      planned.breakpoints.at(-1)?.prefixTokens ?? Infinity,
    );
    expect(planned.reservationUsd).toBeGreaterThan(0.01);
    expect(planned.request.prompt_cache_options).toEqual({
      mode: 'explicit',
      ttl: '30m',
    });
    expect(planStep(coldWarm, cold, options(), 'resp_0').request).toMatchObject(
      {
        prompt_cache_options: { comparison_response_id: 'resp_0' },
      },
    );
    const otherRun = planStep(coldWarm, cold, options({ runId: 'run-2' }));
    expect(otherRun.request.prompt_cache_key).not.toBe(
      planned.request.prompt_cache_key,
    );
  });
});

describe('runScenarios', () => {
  test('a dry run plans every step and sends nothing', async () => {
    const result = await runScenarios(scenarios, options());
    const steps = scenarios.flatMap((s) => s.steps);
    expect(result.records).toHaveLength(steps.length);
    expect(result.records.every((r) => r.status === 'planned')).toBe(true);
    expect(result.countSamples).toEqual({ words: [], 'utf8-bytes-div-4': [] });
  });

  test('a live run records usage, cost, comparisons and inferred attribution', async () => {
    const provider = fakeProvider((_request, n) =>
      n === 0
        ? response('resp_0', 0, 15_000)
        : response(`resp_${n}`, 15_000, 0),
    );
    const sleep = vi.fn(() => Promise.resolve());
    const budget = new EvaluationBudget(5);
    const result = await runScenarios([coldWarm], {
      ...options({ provider, budget, sleep, settleMs: 250 }),
    });
    expect(result.records.map((r) => r.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    const [cold, warm1, warm2] = result.records;
    expect(cold?.comparisonResponseId).toBeNull();
    expect(warm1?.comparisonResponseId).toBe('resp_0');
    expect(warm2?.comparisonResponseId).toBe('resp_1');
    expect(provider.create.mock.calls[1]?.[0]).toMatchObject({
      prompt_cache_options: { comparison_response_id: 'resp_0' },
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(cold?.sincePreviousMs).toBeNull();
    expect(warm1?.sincePreviousMs).toBeGreaterThan(0);
    expect(cold?.usage).toMatchObject({ cacheWriteTokens: 15_000 });
    expect(cold?.cost?.writePremiumUsd).toBeCloseTo(15_000 * 0.5e-6, 12);
    expect(cold?.schemaErrors).toEqual([]);
    expect(cold?.attribution?.basis).toBe('inferred');
    expect(Object.keys(cold?.providerPrefixTokens ?? {})).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    // Identical requests are counted once.
    expect(provider.countInputTokens).toHaveBeenCalledTimes(5);
    expect(result.countSamples['words']).toHaveLength(3);
    expect(budget.snapshot().settledUsd).toBeCloseTo(
      result.records.reduce((sum, r) => sum + (r.cost?.totalUsd ?? 0), 0),
      12,
    );
  });

  test('refuses a step the budget cannot cover and sends nothing for it', async () => {
    const provider = fakeProvider((_r, n) => response(`resp_${n}`, 0, 0));
    const [first] = coldWarm.steps;
    if (first === undefined) throw new Error('no step');
    const reservation = planStep(coldWarm, first, options()).reservationUsd;
    const log = vi.fn();
    const result = await runScenarios([coldWarm], {
      ...options({
        provider,
        log,
        budget: new EvaluationBudget(reservation * 1.5),
      }),
    });
    expect(result.records.map((r) => r.status)).toEqual([
      'completed',
      'refused-budget',
      'refused-budget',
    ]);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'cold-warm/warm-1: refused, the budget cannot cover it',
    );
  });

  test('a failed request keeps its reservation and its message is redacted', async () => {
    const provider = fakeProvider(() => {
      throw new Error('timed out for key sk-test-secret-value');
    });
    const budget = new EvaluationBudget(5);
    const result = await runScenarios(
      [{ ...coldWarm, steps: coldWarm.steps.slice(0, 1) }],
      options({ provider, budget }),
    );
    const [record] = result.records;
    expect(record?.status).toBe('error');
    expect(record?.error).not.toContain('sk-test-secret-value');
    expect(record?.error).toMatch(/^Error \(unknown\): timed out for key /);
    expect(record?.providerInputTokens).toBeGreaterThan(0);
    expect(budget.snapshot().heldUsd).toBeCloseTo(
      record?.reservationUsd ?? 0,
      12,
    );
  });

  test('maps incomplete and failed responses and unparsable or missing usage', async () => {
    const provider = fakeProvider((_r, n) =>
      n === 0
        ? {
            id: 'a',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output_text: '{"candidateFindings": [',
          }
        : { status: 'failed' },
    );
    const result = await runScenarios(
      [{ ...coldWarm, steps: coldWarm.steps.slice(0, 2) }],
      options({ provider }),
    );
    const [incomplete, failed] = result.records;
    expect(incomplete).toMatchObject({
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
      usage: null,
      usageUnknownReason: 'usage missing',
      cost: null,
      attribution: null,
      schemaErrors: null,
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.comparisonResponseId).toBe('a');
  });
});
