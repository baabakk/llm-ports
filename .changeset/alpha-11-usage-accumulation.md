---
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-openai": patch
"@llm-ports/adapter-google": patch
"@llm-ports/adapter-ollama": patch
"@llm-ports/adapter-vercel": patch
---

Fix: `generateStructured` now accumulates token usage across `retry-with-feedback` rounds, so `result.usage` and `result.cost` reflect every SDK call, not just the final one.

**The bug.** When `generateStructured` retried on a Zod-validation failure, `validationAttempts` correctly reported `2` (two real SDK calls happened), but `result.usage` was overwritten with only the SECOND call's tokens. Cost computation read from the overwritten usage, so the reported `result.cost.totalUSD` under-reported the truth by the cost of the first attempt. This was wrong in every retry path across all 5 adapters that implement `generateStructured`.

```ts
// Before alpha.11:
// 2 SDK calls. Call 1: 100 input / 25 output. Call 2: 150 input / 15 output.
// Reported: { inputTokens: 150, outputTokens: 15, totalTokens: 165 }   ← only call 2

// After alpha.11:
// Reported: { inputTokens: 250, outputTokens: 40, totalTokens: 290 }   ← both calls
```

**The fix.** All 5 generateStructured implementations now use `mergeTokenUsage(lastUsage, parseUsage(response))` inside the retry loop — the same pattern `runAgent` has used since alpha.0 to aggregate per-step usage. No public-API surface changed; the contract for `result.usage` is now "sum across all SDK calls", which is what callers always assumed.

**Affected adapters:**

- `@llm-ports/adapter-anthropic` (the original report site — Claude Haiku / Sonnet retry-with-feedback usage)
- `@llm-ports/adapter-openai`
- `@llm-ports/adapter-google`
- `@llm-ports/adapter-ollama`
- `@llm-ports/adapter-vercel`

**Tests.** 3 new regression tests in `adapter-anthropic` covering: (a) first-attempt success reports just call 1, (b) retry success reports sum of both calls, (c) `result.cost.totalUSD` reflects the accumulated tokens. Same shape applies to the other 4 adapters; the runAgent paths already exercised `mergeTokenUsage` and continue to work.

**Why this didn't show up in contract tests.** The shared contract suite asserts `result.validationAttempts >= 2` on the retry path but does not assert anything about cumulative usage — so the bug slipped through. Future addition.

Closes a user report from 2026-05-26: `claude-haiku-4-5` and `claude-sonnet-4-5` calls were observed with `validationAttempts: 2` and ~832 total tokens (single-call-shaped), which the user correctly diagnosed as "the metric is meaningful but the usage field isn't summing".
