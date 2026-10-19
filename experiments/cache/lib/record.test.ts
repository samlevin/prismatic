import { describe, expect, test } from 'vitest';
import type { StepRecord } from './record.ts';
import { readResponse, totalsByScenario } from './record.ts';

const usage = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
  output_tokens: 50,
  output_tokens_details: { reasoning_tokens: 40 },
};

describe('readResponse', () => {
  test('reads usage, effective effort, echoed updates and diagnostics', () => {
    const reading = readResponse({
      id: 'resp_1',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage,
      reasoning: { effort: 'medium', mode: 'standard' },
      service_tier: 'default',
      prompt_cache_diagnostics: { type: 'cache_hit' },
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'configuration_update',
          id: 'cu_1',
          reasoning: { effort: 'medium' },
        },
        {
          type: 'message',
          content: [
            { type: 'output_text', text: '{"a":' },
            { type: 'refusal', refusal: 'no' },
            { type: 'output_text', text: '1}' },
          ],
        },
        { type: 'message', content: 'not a list' },
      ],
    });
    expect(reading).toEqual({
      id: 'resp_1',
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
      usage: {
        kind: 'known',
        usage: {
          inputTokens: 1000,
          cachedTokens: 600,
          cacheWriteTokens: 300,
          outputTokens: 50,
          reasoningTokens: 40,
        },
      },
      reportedEffort: 'medium',
      configurationUpdates: [
        {
          type: 'configuration_update',
          id: 'cu_1',
          reasoning: { effort: 'medium' },
        },
      ],
      diagnostics: { type: 'cache_hit' },
      serviceTier: 'default',
      outputText: '{"a":1}',
    });
  });

  test('prefers the SDK output_text and records absent fields as null', () => {
    expect(readResponse({ output_text: '{}' }).outputText).toBe('{}');
    expect(readResponse({ output: [] }).outputText).toBeNull();
    const empty = readResponse(undefined);
    expect(empty).toEqual({
      id: null,
      status: null,
      incompleteReason: null,
      usage: { kind: 'unknown', reason: 'usage missing' },
      reportedEffort: null,
      configurationUpdates: [],
      diagnostics: null,
      serviceTier: null,
      outputText: null,
    });
  });
});

function record(overrides: Partial<StepRecord>): StepRecord {
  return {
    scenario: 's',
    step: 'x',
    settingsIdentity: 'i',
    requestEffort: 'high',
    updateEffort: null,
    reportedEffort: null,
    configurationUpdates: [],
    breakpoints: [],
    providerPrefixTokens: {},
    localInputTokens: 0,
    providerInputTokens: null,
    status: 'completed',
    incompleteReason: null,
    usage: null,
    usageUnknownReason: null,
    reservationUsd: 0.1,
    cost: null,
    elapsedMs: 0,
    sincePreviousMs: null,
    comparisonResponseId: null,
    diagnostics: null,
    attribution: null,
    schemaErrors: null,
    serviceTier: null,
    error: null,
    ...overrides,
  };
}

describe('totalsByScenario', () => {
  test('sums sent requests per scenario and leaves unsent ones out', () => {
    const known = {
      inputTokens: 1000,
      cachedTokens: 600,
      cacheWriteTokens: 300,
      outputTokens: 50,
      reasoningTokens: 40,
    };
    const cost = {
      ordinaryInputUsd: 0,
      cacheWriteUsd: 0,
      cachedInputUsd: 0,
      outputUsd: 0,
      writePremiumUsd: 0.25,
      totalUsd: 1,
    };
    expect(
      totalsByScenario([
        record({ usage: known, cost, elapsedMs: 10 }),
        record({ status: 'error', elapsedMs: 5 }),
        record({ status: 'refused-budget' }),
        record({ scenario: 't', status: 'planned' }),
        record({ usage: known, cost, elapsedMs: 1, status: 'incomplete' }),
      ]),
    ).toEqual([
      {
        scenario: 's',
        requests: 3,
        completed: 1,
        unknownUsage: 1,
        inputTokens: 2000,
        cachedTokens: 1200,
        cacheWriteTokens: 600,
        outputTokens: 100,
        reasoningTokens: 80,
        knownCostUsd: 2,
        writePremiumUsd: 0.5,
        elapsedMs: 16,
      },
      {
        scenario: 't',
        requests: 0,
        completed: 0,
        unknownUsage: 0,
        inputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        knownCostUsd: 0,
        writePremiumUsd: 0,
        elapsedMs: 0,
      },
    ]);
  });
});
