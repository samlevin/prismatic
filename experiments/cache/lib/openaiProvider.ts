// The live provider for the cache spike: the shipped OpenAI SDK with no
// transport retries, so every attempt is one possible charge, and with the
// ambient organization, project, base URL and logging overrides pinned off.
import OpenAI from 'openai';
import type { Provider } from './runner.ts';

// `fetch` is for tests, which check the wire format without a network.
export function openAIProvider(
  apiKey: string,
  fetch?: typeof globalThis.fetch,
): Provider {
  const client = new OpenAI({
    apiKey,
    ...(fetch === undefined ? {} : { fetch }),
    baseURL: 'https://api.openai.com/v1',
    organization: null,
    project: null,
    maxRetries: 0,
    timeout: 600_000,
    logLevel: 'off',
  });
  return {
    create: (request) => client.responses.create(request),
    countInputTokens: async (params) =>
      (await client.responses.inputTokens.count(params)).input_tokens,
  };
}
