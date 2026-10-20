// Builds the Responses API payloads the spike sends, typed against the
// shipped `openai` SDK so a field the SDK does not know fails typecheck. The
// payload follows §9.2: strict JSON output, low verbosity, store false,
// truncation disabled, no streaming, no tools, default service tier and
// standard reasoning mode. Prompt caching uses explicit mode, so only the
// planned breakpoints are written (§9.3).
import { createHash } from 'node:crypto';
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseInputText,
} from 'openai/resources/responses/responses';
import type { InputTokenCountParams } from 'openai/resources/responses/input-tokens';
import { canonicalJson } from '../../../src/shared/canonical.ts';
import type { BreakpointPlan, RenderedBlock } from './layout.ts';
import type { JsonSchema } from './schema.ts';

// §9.2: gpt-6.1-sol accepts low through max.
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ReasoningPlan {
  // reasoning.effort on the request itself.
  readonly requestEffort: Effort;
  // When set, a `configuration_update` item after block 4 changes the
  // effective effort for this response while the request-level settings,
  // and so the cached prefix, stay as they were.
  readonly updateEffort?: Effort;
}

export interface RequestPlan {
  readonly model: string;
  readonly blocks: readonly RenderedBlock[];
  readonly breakpoints: BreakpointPlan;
  readonly reasoning: ReasoningPlan;
  readonly maxOutputTokens: number;
  readonly schemaName: string;
  readonly schema: JsonSchema;
  // Routes requests of one scenario together; distinct per scenario run.
  readonly promptCacheKey: string;
  // An earlier response to compare against for cache diagnostics.
  readonly comparisonResponseId?: string;
}

function textPart(
  block: RenderedBlock,
  plan: BreakpointPlan,
): ResponseInputText {
  const breakpoint = plan.breakpoints.some((b) => b.afterBlock === block.block);
  return {
    type: 'input_text',
    text: block.text,
    ...(breakpoint ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}),
  };
}

function parts(
  plan: RequestPlan,
  blocks: readonly number[],
): ResponseInputText[] {
  return plan.blocks
    .filter((block) => blocks.includes(block.block) && block.text !== '')
    .map((block) => textPart(block, plan.breakpoints));
}

// Block 1 is the developer message. Blocks 2-4 form a user message, then
// the optional configuration update, then block 5 as a second user message,
// so the message structure is the same with and without the update.
export function buildInput(plan: RequestPlan): ResponseInputItem[] {
  const input: ResponseInputItem[] = [
    { type: 'message', role: 'developer', content: parts(plan, [1]) },
  ];
  const context = parts(plan, [2, 3, 4]);
  if (context.length > 0) {
    input.push({ type: 'message', role: 'user', content: context });
  }
  if (plan.reasoning.updateEffort !== undefined) {
    input.push({
      type: 'configuration_update',
      reasoning: { effort: plan.reasoning.updateEffort },
    });
  }
  input.push({ type: 'message', role: 'user', content: parts(plan, [5]) });
  return input;
}

export function buildRequest(
  plan: RequestPlan,
): ResponseCreateParamsNonStreaming {
  return {
    model: plan.model,
    input: buildInput(plan),
    reasoning: { effort: plan.reasoning.requestEffort, mode: 'standard' },
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: plan.schemaName,
        strict: true,
        schema: { ...plan.schema },
      },
    },
    max_output_tokens: plan.maxOutputTokens,
    store: false,
    stream: false,
    truncation: 'disabled',
    tool_choice: 'none',
    service_tier: 'default',
    prompt_cache_key: plan.promptCacheKey,
    prompt_cache_options: {
      mode: 'explicit',
      ttl: '30m',
      ...(plan.comparisonResponseId === undefined
        ? {}
        : { comparison_response_id: plan.comparisonResponseId }),
    },
  };
}

// The request settings that can decide cache compatibility: everything but
// the input, the per-scenario routing key and the diagnostics comparison.
// Two requests with different identities belong to separate cache
// populations until a measurement shows otherwise.
export function settingsIdentity(
  request: ResponseCreateParamsNonStreaming,
): string {
  const settings: Record<string, unknown> = { ...request };
  delete settings['input'];
  delete settings['prompt_cache_key'];
  const cacheOptions = { ...request.prompt_cache_options };
  delete cacheOptions.comparison_response_id;
  settings['prompt_cache_options'] = cacheOptions;
  return createHash('sha256')
    .update(canonicalJson(settings))
    .digest('hex')
    .slice(0, 16);
}

// The same request for the input-token counting endpoint, which takes the
// model, input, reasoning, text format and tool choice but no cache options.
export function countParams(
  request: ResponseCreateParamsNonStreaming,
  input: ResponseInputItem[] = request.input as ResponseInputItem[],
): InputTokenCountParams {
  const format = request.text?.format;
  return {
    model: request.model ?? null,
    input,
    reasoning: request.reasoning ?? null,
    ...(format === undefined ? {} : { text: { format } }),
    tool_choice: 'none',
    truncation: 'disabled',
  };
}

// The input cut after block `afterBlock`, for counting where a boundary
// falls. The trailing message closes where the full request's would not, so
// the provider count of a cut input is an estimate of the boundary position.
export function inputThrough(
  plan: RequestPlan,
  afterBlock: 1 | 2 | 3 | 4,
): ResponseInputItem[] {
  const blocks = [1, 2, 3, 4].filter((b) => b <= afterBlock);
  const input: ResponseInputItem[] = [
    { type: 'message', role: 'developer', content: parts(plan, [1]) },
  ];
  const context = parts(
    plan,
    blocks.filter((b) => b > 1),
  );
  if (context.length > 0) {
    input.push({ type: 'message', role: 'user', content: context });
  }
  return input;
}
