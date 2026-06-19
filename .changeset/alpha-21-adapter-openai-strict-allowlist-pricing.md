---
"@llm-ports/adapter-openai": minor
---

Three additions, all empirically grounded in ADW's 2026-06-18 Structured-Output Reliability report:

## 1. Per-call `strict?: boolean` plumbing

`generateStructured` and `streamStructured` now honor a per-call `strict?: boolean` from `GenerateStructuredOptions` / `StreamStructuredOptions`. Precedence:

1. `options.strict` (per-call; highest)
2. `ctx.useStrictResponseFormat` (adapter-level, set at construction)
3. `autoDetectStrictResponseFormat(baseURL)` (default applied to step 2 if the user didn't supply `useStrictResponseFormat`)

Adapters across other packages either honor or silently ignore the per-call field (matching the type contract on `@llm-ports/core`). See llm-ports#46.

## 2. Strict-mode allowlist extended to DeepInfra + Parasail

`autoDetectStrictResponseFormat` now defaults strict ON for `api.deepinfra.com` and `api.parasail.io` baseURLs, joining the existing list (OpenAI native, Cerebras, Groq, SambaNova).

Empirical verification (2026-06-18, 8 calls per provider on the same flat schema):

| Provider           | `json_object` (alpha.20.1 default) | strict (alpha.21 default) |
|---|---|---|
| DeepInfra deepseek-flash | 2 validation retries / 8 | 0 retries / 8 |
| DeepInfra gemma-31b      | **8/8 retries** (one on every call) | 0 retries / 8 |
| Parasail mimo            | 3 validation retries / 8 | 0 retries / 8 |

See llm-ports#47.

## 3. Three new bundled pricing entries

`OPENAI_PRICING` now includes three compat-provider models in active production use against the verified-OK provider matrix:

- `deepseek-ai/DeepSeek-V4-Flash` ($0.10 / $0.20 per 1M tokens; DeepInfra)
- `google/gemma-4-31B-it` ($0.10 / $0.20 per 1M tokens; DeepInfra)
- `XiaomiMiMo/MiMo-V2.5` ($0.14 / $0.28 per 1M tokens; Parasail)

Consumers using these models against the OpenAI-compat adapter no longer need to maintain a parallel `pricingOverrides` table for them. Neither DeepInfra nor Parasail publishes a discounted cache-read tier today; the `cacheReadPer1M` field is intentionally omitted.

See llm-ports#48.

## Backwards compatibility

All three changes are additive. Existing adapters constructed against allowlisted baseURLs (OpenAI native, Cerebras, Groq, SambaNova) behave identically. Adapters explicitly opting OUT via `useStrictResponseFormat: false` are unchanged. Pricing additions are pure-additive; no override behavior changes.
