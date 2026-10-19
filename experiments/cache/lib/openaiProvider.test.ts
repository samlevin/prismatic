// Checks what the shipped SDK puts on the wire for the spike's payloads,
// through a fake fetch, so no request leaves the machine.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSecretRedactor } from '../../../src/shared/redaction.ts';
import { EvaluationBudget } from './budget.ts';
import { openAIProvider } from './openaiProvider.ts';
import { pricesFor } from './pricing.ts';
import { countParams } from './request.ts';
import { planStep } from './runner.ts';
import { scenarios } from './scenarios.ts';
import { byteHeuristic } from './tokens.ts';

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function fakeFetch(
  reply: (url: string) => Response,
): typeof globalThis.fetch & { captured: Captured[] } {
  const captured: Captured[] = [];
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as unknown,
    });
    return reply(url);
  };
  return Object.assign(fetch, { captured });
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function plannedRequest(scenarioId: string, stepLabel: string) {
  const scenario = scenarios.find((s) => s.id === scenarioId);
  const step = scenario?.steps.find((s) => s.label === stepLabel);
  if (scenario === undefined || step === undefined) throw new Error('none');
  return planStep(scenario, step, {
    runId: 'run',
    model: 'gpt-6.1-sol',
    prices: pricesFor('gpt-6.1-sol'),
    maxOutputTokens: 8000,
    budget: new EvaluationBudget(1),
    tokenizer: byteHeuristic,
    candidates: [byteHeuristic],
    inputMargin: 1.1,
    attributionTolerance: 0.02,
    settleMs: 0,
    provider: null,
    redactor: createSecretRedactor(),
    now: () => 0,
    sleep: () => Promise.resolve(),
    log: () => undefined,
  }).request;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('openAIProvider', () => {
  test('sends the planned payload to /responses unchanged', async () => {
    const fetch = fakeFetch(() =>
      json({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        output: [],
      }),
    );
    const request = plannedRequest('effort-configuration-update', 'updated');
    const result = await openAIProvider('sk-test', fetch).create(request);
    expect(result).toMatchObject({ id: 'resp_1' });
    const [call] = fetch.captured;
    expect(call?.url).toBe('https://api.openai.com/v1/responses');
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('authorization')).toBe('Bearer sk-test');
    expect(call?.body).toEqual(JSON.parse(JSON.stringify(request)));
    const input = (call?.body as { input: { type: string }[] }).input;
    expect(input.map((item) => item.type)).toEqual([
      'message',
      'message',
      'configuration_update',
      'message',
    ]);
  });

  test('counts input tokens at /responses/input_tokens', async () => {
    const fetch = fakeFetch(() =>
      json({ object: 'response.input_tokens', input_tokens: 4321 }),
    );
    const params = countParams(plannedRequest('cold-warm', 'cold'));
    expect(
      await openAIProvider('sk-test', fetch).countInputTokens(params),
    ).toBe(4321);
    const [call] = fetch.captured;
    expect(call?.url).toBe('https://api.openai.com/v1/responses/input_tokens');
    expect(call?.body).toEqual(JSON.parse(JSON.stringify(params)));
  });

  test('ignores ambient organization, project and base URL settings', async () => {
    vi.stubEnv('OPENAI_ORG_ID', 'org-ambient');
    vi.stubEnv('OPENAI_PROJECT_ID', 'proj-ambient');
    vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.invalid/v1');
    const fetch = fakeFetch(() =>
      json({ object: 'response.input_tokens', input_tokens: 1 }),
    );
    await openAIProvider('sk-test', fetch).countInputTokens({ input: 'x' });
    const [call] = fetch.captured;
    expect(call?.url.startsWith('https://api.openai.com/v1/')).toBe(true);
    expect(call?.headers.has('openai-organization')).toBe(false);
    expect(call?.headers.has('openai-project')).toBe(false);
  });

  test('makes exactly one attempt on a server error', async () => {
    const fetch = fakeFetch(() => json({ error: { message: 'boom' } }, 500));
    await expect(
      openAIProvider('sk-test', fetch).create(
        plannedRequest('cold-warm', 'cold'),
      ),
    ).rejects.toThrow();
    expect(fetch.captured).toHaveLength(1);
  });
});
