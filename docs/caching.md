# Prompt caching and request feasibility

This page records what P0.9 (#142) established about prefix caching, reasoning-effort changes, tokenizer margin, and the strict JSON request for the §9.3 layout. The production cache contracts in §9.2, §9.3 and §9.5 do not freeze until the live results below are filled in. The harness and its scenario matrix are described in [experiments/cache/README.md](../experiments/cache/README.md).

## Status

| Part | State |
| --- | --- |
| Request payload against the shipped SDK (`openai` 7.39.0) | Verified offline: typecheck and wire-format tests |
| Strict probe schema in the three §15.3 variants | Linted offline; provider acceptance not yet measured |
| Cache behavior for every scenario | Not yet measured |
| Reasoning effort change and `configuration_update` | Not yet measured |
| Tokenizer selection and complete-request margin | Not yet measured |

No result on this page comes from a mocked response or a local content hash. Every live number must come from a recorded run under `experiments/cache/results/`.

## Request mapping

The spike builds each request with `experiments/cache/lib/request.ts`, typed as the SDK's `ResponseCreateParamsNonStreaming`. A field the SDK does not define fails `npm run typecheck`. The provider tests send the planned payloads through the SDK with a fake `fetch` and check that the JSON body on the wire equals the payload, that it goes to `POST /v1/responses` (and `POST /v1/responses/input_tokens` for counting), that the SDK makes one attempt on a 5xx with `maxRetries: 0`, and that ambient `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and `OPENAI_BASE_URL` values do not reach the request.

| Contract | Payload |
| --- | --- |
| Block 1 | Developer message, one `input_text` part |
| Blocks 2 to 4 | One user message, one `input_text` part per non-empty block |
| Effective-effort change (variant) | A `configuration_update` input item with `reasoning.effort`, placed after block 4 |
| Block 5 | A second user message |
| Breakpoint | `prompt_cache_breakpoint: { mode: 'explicit' }` on the part that ends the block |
| Caching mode and TTL | `prompt_cache_options: { mode: 'explicit', ttl: '30m' }` |
| Diagnostics | `prompt_cache_options.comparison_response_id` set to an earlier response |
| Routing | `prompt_cache_key`, one per scenario run |
| §9.2 settings | `reasoning: { effort, mode: 'standard' }`, `text: { verbosity: 'low', format: { type: 'json_schema', strict: true } }`, `store: false`, `stream: false`, `truncation: 'disabled'`, `tool_choice: 'none'`, `service_tier: 'default'`, no `tools` |

Facts read from the SDK 7.39.0 type definitions, which the live run must confirm:

- `prompt_cache_options.mode` defaults to `implicit`, which adds one provider-chosen breakpoint and writes up to the latest three explicit ones. `explicit` writes up to the latest four explicit breakpoints and, with none, does not cache at all. The disabled-caching contract in §9.3 relies on that last rule.
- `ttl` accepts only `30m`. The SDK describes it as a minimum lifetime; the provider may keep entries longer.
- The SDK also offers `prompt_cache_options.prewarm`, which fills the cache without generating output. The spike does not use it, and §9.3 adds no probe or extra call to a review round.
- `prompt_cache_retention` is deprecated in favor of `prompt_cache_options.ttl`, so the spike does not send it.
- Usage reports `input_tokens_details.cached_tokens` and `input_tokens_details.cache_write_tokens` for the whole response. Nothing reports which breakpoint matched.
- Diagnostics are `cache_hit`, `cache_miss` (with `cache_missed_tokens`, an optional `comparison_reusable_tokens`, and a reason such as `reasoning_effort_changed`, `text_format_changed` or `input_changed`), `comparison_response_not_found`, or `unavailable`. Whether a comparison works with `store: false` is one of the things the live run shows.
- A `configuration_update` item accepts only `reasoning.effort`. The SDK says it applies to subsequent responses until replaced; whether it changes the effort of the response it is sent in, and whether the response reports that effort, is unverified.
- `reasoning.effort` accepts `none` through `max` in the SDK. §9.2 limits `gpt-6.1-sol` to `low` through `max`, and the spike's `Effort` type does the same.

## Method

Each scenario renders seeded synthetic material in the five §9.3 blocks: about 2,200 tokens of instructions, 1,900 of rules, 5,800 of block 3 source, 5,800 of block 4 source and 700 of suffix, about 16,400 in all by `o200k_base`. The short-prefix variant keeps blocks 1 to 4 under 1,024 tokens inside a request of about 4,300. Its scenario sends that request once with no breakpoint, as the planner decides, and twice with breakpoints forced onto the short prefix, to see whether the provider ignores them, rejects the request, or caches the prefix anyway. The spike turns on both BP3 and BP4 so every boundary is measured; production keeps them off until the measurements justify them.

For every step the run records:

- the planned breakpoints, with local and provider-counted prefix positions;
- the request-settings identity, a digest of everything except the input, routing key and comparison ID, so requests that cannot share a cache population are visible;
- provider usage, the cost by the §9.5 formula, and the write premium;
- elapsed time and time since the previous step;
- diagnostics when the provider returns them;
- the effort the response reports and any echoed `configuration_update`;
- schema validation errors for the parsed output;
- an attribution of `cached_tokens` and `cached_tokens + cache_write_tokens` to the nearest planned boundary.

Attribution is labeled `inferred` everywhere. It matches whole-response counters to planned positions and is never a provider-measured per-boundary hit.

Costs use the rates implied by the §9.5 worked example: $2.00 per million input tokens, $2.50 for cache writes, $0.10 for cached reads and $10.00 for output, below 272K input. Check them against the current pricing page before a live run and update `experiments/cache/lib/pricing.ts` if they differ. The long-context row is unknown, and no scenario comes near it.

The evaluation budget is explicit. A live run requires `--budget-usd`. Every request reserves its worst case before it is sent: all planned input at the write rate, scaled by 1.1 for tokenizer error, plus the full output ceiling. A request that does not fit is skipped and recorded as `refused-budget`. A request that errors or returns no usage keeps its whole reservation. The full matrix is 26 requests with a planned worst case of $3.16.

Tokenizer selection compares `o200k_base`, `cl100k_base` and a four-bytes-per-token baseline against the provider's input-token count, with one sample per distinct request that uses the full schema. The provider counts the complete request, so its count includes message framing and the response-format schema on top of the block text. For each candidate the run fits provider = slope * local + intercept by least squares. The intercept is the fixed framing in tokens and the slope is the tokenizer's proportional error, so a fixed overhead never reads as a percentage error on a short request. The selected candidate leaves the smallest worst residual, with ties going to the slope nearer 1. The allocator plans with that slope and intercept plus the fit's worst under-prediction as a margin. The results file keeps every sample, so the selection can be redone from it. `js-tiktoken` 1.0.21 maps no `gpt-6` model to an encoding, so the choice has to come from these measurements.

## Running the live measurements

A person with an OpenAI API key for a project that can call `gpt-6.1-sol` runs, on Node 24 from the repository root after `npm ci`:

```sh
node experiments/cache/spike/main.ts --dry-run > /tmp/plan.json
mkdir -p experiments/cache/results
OPENAI_API_KEY=... node experiments/cache/spike/main.ts --budget-usd 5 > experiments/cache/results/$(date +%Y-%m-%d).json
```

Then commit the results file and replace the pending sections below with the measured values, citing the file.

## Results

Pending the live run. These sections stay empty until then; nothing here is an estimate.

### Cache behavior

For each scenario: requests, cached and written tokens per step, inferred boundary, diagnostics, elapsed time and total cost.

### Reasoning effort

For `effort-high-to-medium` and `effort-configuration-update`: whether the medium request reused the high prefix, the effort each response reports, reasoning tokens per step, and whether the medium population warmed on its own.

### Tokenizer and request margin

The margin summary per candidate, the selected tokenizer, and the provider's framing overhead over the rendered text.

### Strict schema

Whether each schema variant was accepted with `strict: true`, and whether every completed output validated.

## Decisions waiting on the results

- Ship the `configuration_update` mapping for incremental rounds only if the updated request reuses the high prefix and the response shows medium as its effective effort. Otherwise send the ordinary request-level effort, keep separate cache populations, and budget for the miss (§9.2, §9.3).
- Keep BP3 and BP4 off by default unless the change scenarios show reads that outweigh the write premium. §9.5 puts the break-even at reads above about 26.3% of writes.
- Freeze the tokenizer and the planning margin from the measured under-count.
- Freeze the strict schema keywords from what the provider accepted, and confirm `tool_choice: 'none'` with no tools is accepted.
