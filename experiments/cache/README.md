# Live cache and request spike (P0.9)

This spike measures prefix caching, reasoning-effort changes, and request validity for the §9.3 prompt layout against the OpenAI Responses API, using synthetic source. Method, offline findings, and the live results are in [docs/caching.md](../../docs/caching.md). Production code never imports anything from this directory.

## Running it

```sh
node experiments/cache/spike/main.ts --dry-run > plan.json
OPENAI_API_KEY=... node experiments/cache/spike/main.ts --budget-usd 5 > results.json
OPENAI_API_KEY=... node experiments/cache/spike/main.ts --budget-usd 1 --only cold-warm,effort-configuration-update > results.json
```

The dry run builds and prices every request and sends nothing. A live run requires `--budget-usd`. Each request reserves its worst case first (every planned input token at the cache-write rate, scaled by 1.1 for tokenizer error, plus the full output ceiling) and is skipped when that does not fit. A request that fails or returns no usage keeps its whole reservation. The full matrix is 26 requests with a planned worst case of $3.16 at the default 8,000 output tokens. Options: `--model` (default `gpt-6.1-sol`, the only model in the price catalog), `--max-output-tokens` (default 8000), `--settle-ms` between steps of a scenario (default 3000), and `--only <ids>`.

Results are JSON on stdout and progress goes to stderr. The exit status is 1 when any request errored. Each step also makes up to five calls to the input-token counting endpoint, one for the whole request and one per planned breakpoint, cached by payload.

## Layout

- `lib/` holds the tested parts: seeded synthetic source, the five-block layout and breakpoint planner, the SDK-typed request builder, the strict probe schema with its linter and validator, the price catalog and §9.5 cost formula, the evaluation budget, tokenizer candidates and margin math, inferred boundary attribution, response reading, the scenario matrix, the runner, and the SDK provider. Unit tests sit beside each file and count toward the coverage gate. No test touches the network; the provider tests check the SDK's wire format through a fake `fetch`.
- `spike/main.ts` is the command-line driver. The coverage gate leaves it out.
- `results/` is where the live run's JSON goes once someone with an API key runs the spike; `docs/caching.md` cites it.

## Scenarios

Criteria are the acceptance criteria of #142, in order.

| Id | Criteria | Steps |
| --- | --- | --- |
| `cold-warm` | 1, 3 | Cold, then two identical repeats |
| `block4-early-change` | 1, 3 | Prime, then one changed line in the first block 4 file |
| `block4-late-change` | 1, 3 | Prime, then one changed line in the last block 4 file |
| `scope-change` | 1, 3 | Prime, then a file added to blocks 3 and 4 |
| `representation-change` | 1, 3 | Prime, then one block 3 file from L0 to L2 |
| `base-provenance-only` | 1, 3 | Prime, then only the base-tip SHA in block 5 changes |
| `caching-disabled` | 1, 3 | Explicit mode with no breakpoints, twice |
| `short-stable-prefix` | 1, 3 | A prefix under 1,024 tokens in a request over it: once with no breakpoint, then twice with breakpoints forced onto the short prefix |
| `effort-high-to-medium` | 2, 3 | High, medium, medium again |
| `effort-configuration-update` | 2, 3 | High, then high with a `configuration_update` to medium after block 4, twice |
| `schema-variants` | 4 | The incremental and reconcile schemas under `strict: true` |

Every step after the first names the earlier response as `prompt_cache_options.comparison_response_id`, so the provider returns cache diagnostics when it supports them. Each scenario run opens block 1 with its own nonce and uses its own `prompt_cache_key`, so one run never warms another's cold request.
