# Prompt caching and request feasibility

This page records what P0.9 (#142) established about prefix caching, reasoning-effort changes, tokenizer margin, and the strict JSON request for the §9.3 layout. The live numbers come from one recorded run, [experiments/cache/results/2026-10-19.json](../experiments/cache/results/2026-10-19.json), and the decisions at the end say which §9.2, §9.3 and §9.5 contracts they support. The harness and its scenario matrix are described in [experiments/cache/README.md](../experiments/cache/README.md).

## Status

| Part | State |
| --- | --- |
| Request payload against the shipped SDK (`openai` 7.39.0) | Verified offline by typecheck and wire-format tests, and live: the provider accepted all 26 requests on 2026-10-19 |
| Strict probe schema in the three §15.3 variants | Accepted live with `strict: true`; all 26 completed outputs validated against their schema |
| Cache behavior for every scenario | Measured live on 2026-10-19; every scenario hypothesis held |
| Reasoning effort change and `configuration_update` | Measured live. A request-level change misses the whole prefix; `configuration_update` reuses it but the response does not report the new effort |
| Tokenizer selection and complete-request margin | Measured live: `o200k_base`, 258 tokens of fixed framing, worst under-prediction under one token |

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

Facts read from the SDK 7.39.0 type definitions. The results below say which ones the live run bore out:

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

## The live run

The run on 2026-10-19 used `gpt-6.1-sol` through `openai` 7.39.0 on Node 24.22.0, with `--budget-usd 5`, the default 8,000 output-token ceiling and 3,000 ms between the steps of a scenario. It sent all 26 planned requests in eight minutes. Every request completed, none was refused by the budget, none came back incomplete, and every response reported usage. The run settled at $0.82 against a planned worst case of $3.16, with nothing held at the end. The results file is `experiments/cache/results/2026-10-19.json`.

To repeat it, on Node 24 from the repository root after `npm ci`:

```sh
node experiments/cache/spike/main.ts --dry-run > /tmp/plan.json
OPENAI_API_KEY=... node experiments/cache/spike/main.ts --budget-usd 5 > experiments/cache/results/$(date +%Y-%m-%d).json
```

Commit the new file and update the numbers below from it.

## Results

Every number below is read from the results file. Token counts are the provider's `usage` fields. Costs use the §9.5 rates in `experiments/cache/lib/pricing.ts`; the run did not re-check them against the pricing page.

### Cache behavior

The provider counts each planned prefix about 250 tokens past the local count. In the cold request the four boundaries fell at 2,409, 4,368, 10,159 and 15,969 provider tokens against 2,159, 4,114, 9,905 and 15,715 locally. Cached and written counts came in 3 tokens short of the provider-counted boundary on every step, so the inferred attribution matched a planned boundary everywhere.

| Scenario | Requests | Cached tokens per step | Written tokens per step | Inferred boundary | Diagnostics | Elapsed per step | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cold-warm` | 3 | 0, 15,966, 15,966 | 15,966, 0, 0 | Write to BP4, then two reads to BP4 | `cache_hit`, `cache_hit` | 12.1 s, 14.5 s, 16.4 s | $0.064 |
| `block4-early-change` | 2 | 0, 10,157 | 15,967, 5,813 | Read to BP3, rewrite to BP4 | `unavailable` | 15.4 s, 20.1 s | $0.072 |
| `block4-late-change` | 2 | 0, 10,157 | 15,967, 5,810 | Read to BP3, rewrite to BP4 | `cache_miss`, `input_changed`, 5,810 missed | 24.7 s, 24.5 s | $0.078 |
| `scope-change` | 2 | 0, 4,364 | 15,965, 14,499 | Read to BP2, rewrite to BP4 | `unavailable` | 22.6 s, 16.0 s | $0.095 |
| `representation-change` | 2 | 0, 4,364 | 15,965, 10,667 | Read to BP2, rewrite to BP4 | `unavailable` | 18.1 s, 22.9 s | $0.084 |
| `base-provenance-only` | 2 | 0, 15,967 | 15,967, 0 | Read to BP4 | `cache_hit` | 20.7 s, 13.9 s | $0.057 |
| `caching-disabled` | 2 | 0, 0 | 0, 0 | None | `unavailable` | 12.7 s, 12.7 s | $0.077 |
| `short-stable-prefix` | 3 | 0, 0, 0 | 0, 0, 0 | None | none, `cache_hit` | 10.0 s, 9.1 s, 10.7 s | $0.038 |

What each scenario showed:

- Identical repeats read the whole prefix through BP4 and wrote nothing. A warm request cost $0.009 against $0.046 cold. It was not faster: elapsed time followed output and reasoning tokens, not cache state.
- A one-line change in block 4 kept the read at BP3 whether the line was in the first file or the last. The late change came back as a `cache_miss` with `input_changed` and 5,810 missed tokens, the exact span from BP3 to BP4.
- A scope change or a representation change in block 3 dropped the read to BP2 and rewrote blocks 3 and 4.
- Changing only the base-tip provenance in block 5 read the whole prefix, so provenance belongs in the uncached suffix where §9.3 places it.
- Explicit mode with no breakpoints neither read nor wrote on either request, and the input was billed at the ordinary rate. This is the disabled-caching contract.
- A stable prefix of 637 provider-counted tokens (434 through block 1) inside a 4,602-token request was never cached: not without breakpoints, and not when two breakpoints were forced onto it. The provider accepted the forced requests and ignored the breakpoints. The third request's diagnostics said `cache_hit` while its usage reported 0 cached tokens, so diagnostics are advisory and the usage counters decide.

Diagnostics through `comparison_response_id` worked with `store: false`. Of 13 comparisons, 7 returned `cache_hit`, 2 returned `cache_miss` with a reason, and 4 returned `unavailable`.

Across the run the provider read 124,845 cached tokens against 212,418 written, a ratio of 59%. The write premium was $0.106 and the cached reads saved $0.237 against the ordinary input rate.

### Reasoning effort

| Step | Request effort | `configuration_update` | Effort the response reports | Cached | Written | Reasoning tokens | Diagnostics |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `effort-high-to-medium` / `high` | high | none | high | 0 | 15,968 | 1,342 | none |
| `effort-high-to-medium` / `medium` | medium | none | medium | 0 | 15,968 | 139 | `cache_miss`, `reasoning_effort_changed`, 16,110 missed |
| `effort-high-to-medium` / `medium-again` | medium | none | medium | 15,968 | 0 | 105 | `cache_hit` |
| `effort-configuration-update` / `high` | high | none | high | 0 | 15,968 | 502 | none |
| `effort-configuration-update` / `updated` | high | medium, after block 4 | high | 15,968 | 0 | 264 | `cache_hit` |
| `effort-configuration-update` / `updated-again` | high | medium, after block 4 | high | 15,968 | 0 | 251 | `cache_hit` |

A request-level change from high to medium missed the whole prefix. The provider named `reasoning_effort_changed` and counted all 16,110 reusable tokens as missed, so the effort is part of the cache key. The medium population warmed on its own: the next medium request read all 15,968 tokens.

The `configuration_update` item was accepted, and the updated request read the high prefix through BP4 on both tries. But the response reported `high` as its effort, echoed no `configuration_update` item, and gave no other sign of the effort it ran at. Its reasoning tokens, 264 and 251, sit below the full-prefix high requests of this run (402 to 1,342) and above the medium ones (105 and 139), but the three short-prefix high requests used 220 to 266, so reasoning-token counts do not tell which effort ran. The spike cannot show that the update changed the effective effort of the response it was sent in.

### Tokenizer and request margin

| Candidate | Slope | Fixed framing (tokens) | Worst under-prediction | Worst residual | Mean residual |
| --- | --- | --- | --- | --- | --- |
| `o200k_base` | 0.99999 | 258.0 | 0.0008% | 0.011% | 0.0013% |
| `cl100k_base` | 0.99942 | 249.0 | 0.0033% | 0.019% | 0.0050% |
| Bytes divided by 4 | 1.00082 | 855.1 | 2.63% | 2.63% | 0.52% |

Eighteen distinct full-schema requests gave the samples. `o200k_base` is selected: its worst residual is under two tokens on a 16,700-token request. The provider's count exceeded the local block text by 258 tokens on every full-schema request that carried breakpoints, by 256 on the two caching-disabled requests, and by 257 on the incremental and reconcile variants, whether the request held 4,344 or 19,491 local tokens. That constant is the message framing plus the response-format schema. It is the fit's intercept, not a tokenizer error. The 1.1 planning margin the spike used is far larger than the measurements call for: the worst under-prediction of the fit is 0.0008%, under one token.

### Strict schema

All 26 requests sent `text.format` with `strict: true`, `tool_choice: 'none'` and no `tools`, and the provider accepted every one. The two requests on the incremental and reconcile variants and the 24 on the full probe schema all completed, and every parsed output validated against its schema with no errors. No response was incomplete and none reached the 8,000 output-token ceiling; the largest output was 1,888 tokens.

## Decisions the results support

The contracts freeze in their own slices: §9.2 and §9.5 in #124, §9.3 in #123. The measurements support these choices.

- Do not ship the `configuration_update` mapping. The rule was to ship it only if the updated request reuses the high prefix and the response shows medium as its effective effort. The first held and the second did not. Incremental rounds send the ordinary request-level effort, keep one cache population per effort, and budget for one full prefix miss when the effort changes (§9.2, §9.3). Revisit if the provider starts reporting the effective effort.
- Turn BP3 and BP4 on. §9.5 puts the break-even at reads above about 26.3% of writes. A warm repeat or a provenance-only round reads 100% of what was written. A block-4 edit reads 10,157 tokens, 5,793 of them owed to BP3, against the 11,602 extra tokens that BP3 and BP4 add to the write: 50%, so one such round pays the premium back. A scope or representation change reads nothing past BP2 and pays the premium on the rewrite, about $0.006 on a 16,000-token prefix. Over this run reads were 59% of writes.
- Freeze `o200k_base` as the tokenizer. Plan the complete request as the local count plus the framing intercept, 258 tokens on the full schema. The measured worst under-prediction is 0.0008%, under one token, so the spike's 10% margin can shrink to whatever the contract slice wants to hold against schema edits that change the framing.
- Freeze the strict schema as sent. Every variant was accepted with `strict: true`, and `tool_choice: 'none'` with no `tools` was accepted on every request.
- Treat `prompt_cache_diagnostics` as advisory. It was `unavailable` on 4 of 13 comparisons and once reported `cache_hit` on a request with 0 cached tokens. Billing and cache decisions read `usage` only.
