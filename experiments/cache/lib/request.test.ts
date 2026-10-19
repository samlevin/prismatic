import type { ResponseInputItem } from 'openai/resources/responses/responses';
import { describe, expect, test } from 'vitest';
import type { BreakpointPlan, RenderedBlock } from './layout.ts';
import type { RequestPlan } from './request.ts';
import {
  buildInput,
  buildRequest,
  countParams,
  inputThrough,
  settingsIdentity,
} from './request.ts';
import { probeSchema } from './schema.ts';

const blocks: RenderedBlock[] = [
  { block: 1, text: 'instructions' },
  { block: 2, text: 'rules' },
  { block: 3, text: '' },
  { block: 4, text: 'scope' },
  { block: 5, text: 'suffix' },
];

const breakpoints: BreakpointPlan = {
  breakpoints: [
    { afterBlock: 1, prefixTokens: 1100 },
    { afterBlock: 4, prefixTokens: 3000 },
  ],
  skipped: [
    { afterBlock: 2, reason: 'below-minimum' },
    { afterBlock: 3, reason: 'coincident' },
  ],
};

const plan = (overrides: Partial<RequestPlan> = {}): RequestPlan => ({
  model: 'gpt-6.1-sol',
  blocks,
  breakpoints,
  reasoning: { requestEffort: 'high' },
  maxOutputTokens: 8000,
  schemaName: 'review_probe_full',
  schema: probeSchema('full'),
  promptCacheKey: 'key-1',
  ...overrides,
});

type Message = Extract<ResponseInputItem, { role: string; content: unknown }>;
const content = (item: ResponseInputItem | undefined) =>
  (item as Message).content;

describe('buildInput', () => {
  test('puts block 1 in a developer message and marks only planned breakpoints', () => {
    const input = buildInput(plan());
    expect(input).toHaveLength(3);
    expect(input[0]).toMatchObject({ type: 'message', role: 'developer' });
    expect(content(input[0])).toEqual([
      {
        type: 'input_text',
        text: 'instructions',
        prompt_cache_breakpoint: { mode: 'explicit' },
      },
    ]);
    expect(input[1]).toMatchObject({ type: 'message', role: 'user' });
    expect(content(input[1])).toEqual([
      { type: 'input_text', text: 'rules' },
      {
        type: 'input_text',
        text: 'scope',
        prompt_cache_breakpoint: { mode: 'explicit' },
      },
    ]);
    expect(content(input[2])).toEqual([{ type: 'input_text', text: 'suffix' }]);
  });

  test('inserts the configuration update between the prefix and block 5', () => {
    const input = buildInput(
      plan({ reasoning: { requestEffort: 'high', updateEffort: 'medium' } }),
    );
    expect(input.map((item) => item.type)).toEqual([
      'message',
      'message',
      'configuration_update',
      'message',
    ]);
    expect(input[2]).toEqual({
      type: 'configuration_update',
      reasoning: { effort: 'medium' },
    });
    expect(buildInput(plan()).filter((i) => i.type === 'message')).toEqual(
      input.filter((i) => i.type === 'message'),
    );
  });

  test('drops the context message when blocks 2-4 are empty', () => {
    const bare = blocks.map((b) =>
      b.block === 1 || b.block === 5 ? b : { ...b, text: '' },
    );
    expect(buildInput(plan({ blocks: bare }))).toHaveLength(2);
    expect(inputThrough(plan({ blocks: bare }), 4)).toHaveLength(1);
  });
});

describe('buildRequest', () => {
  test('sends the §9.2 settings with explicit-mode caching', () => {
    const request = buildRequest(plan({ comparisonResponseId: 'resp_1' }));
    expect(request).toMatchObject({
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'high', mode: 'standard' },
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'review_probe_full',
          strict: true,
        },
      },
      max_output_tokens: 8000,
      store: false,
      stream: false,
      truncation: 'disabled',
      tool_choice: 'none',
      service_tier: 'default',
      prompt_cache_key: 'key-1',
      prompt_cache_options: {
        mode: 'explicit',
        ttl: '30m',
        comparison_response_id: 'resp_1',
      },
    });
    expect(request).not.toHaveProperty('tools');
    expect(request).not.toHaveProperty('temperature');
    expect(request).not.toHaveProperty('prompt_cache_retention');
    expect(buildRequest(plan()).prompt_cache_options).toEqual({
      mode: 'explicit',
      ttl: '30m',
    });
  });
});

describe('settingsIdentity', () => {
  const identity = (p: RequestPlan) => settingsIdentity(buildRequest(p));

  test('ignores input, routing key and the diagnostics comparison', () => {
    expect(identity(plan())).toMatch(/^[0-9a-f]{16}$/);
    expect(
      identity(
        plan({
          blocks: blocks.map((b) => ({ ...b, text: `${b.text}!` })),
          promptCacheKey: 'other',
          comparisonResponseId: 'resp_9',
        }),
      ),
    ).toBe(identity(plan()));
  });

  test('a configuration update keeps the request-level identity', () => {
    expect(
      identity(
        plan({ reasoning: { requestEffort: 'high', updateEffort: 'medium' } }),
      ),
    ).toBe(identity(plan()));
  });

  test('effort and schema changes start a separate population', () => {
    expect(identity(plan({ reasoning: { requestEffort: 'medium' } }))).not.toBe(
      identity(plan()),
    );
    expect(identity(plan({ schema: probeSchema('reconcile') }))).not.toBe(
      identity(plan()),
    );
  });

  test('tolerates a request without cache options', () => {
    const bare = buildRequest(plan());
    delete bare.prompt_cache_options;
    expect(settingsIdentity(bare)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('countParams and inputThrough', () => {
  test('counts the same model, input, reasoning and format without cache options', () => {
    const request = buildRequest(plan());
    const params = countParams(request);
    expect(params).toEqual({
      model: 'gpt-6.1-sol',
      input: request.input,
      reasoning: request.reasoning,
      text: { format: request.text?.format },
      tool_choice: 'none',
      truncation: 'disabled',
    });
    const rest = { ...request };
    delete rest.text;
    delete rest.model;
    delete rest.reasoning;
    expect(countParams(rest)).toMatchObject({ model: null, reasoning: null });
    expect(countParams(rest)).not.toHaveProperty('text');
  });

  test('cuts the input after a boundary', () => {
    expect(inputThrough(plan(), 1)).toEqual([buildInput(plan())[0]]);
    const through2 = inputThrough(plan(), 2);
    expect(content(through2[1])).toEqual([
      { type: 'input_text', text: 'rules' },
    ]);
    expect(content(inputThrough(plan(), 4)[1])).toEqual(
      content(buildInput(plan())[1]),
    );
  });
});
