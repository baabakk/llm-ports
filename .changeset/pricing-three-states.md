---
"@llm-ports/core": minor
"@llm-ports/observability-contract": minor
"@llm-ports/capabilities": minor
"@llm-ports/adapter-openai": minor
"@llm-ports/adapter-anthropic": minor
"@llm-ports/adapter-google": minor
"@llm-ports/adapter-vercel": minor
"@llm-ports/adapter-codex": minor
"@llm-ports/adapter-aider": minor
---

A price is now priced, free, or unknown, and an unknown price is reported as unknown rather than as zero.

**Pricing is required only where it is enforced.** A model with no known price routes normally on an alias with no cost cap. On a cost-capped alias it is still refused by default; `pricingPolicy: "warn" | "silent"` admits it instead.

**`AdapterRegistration.pricing` accepts `"free"`**, for an adapter that never bills and cannot list its models in advance.

**`cost` is optional** on results, the capability event, the streamed-completion metadata, and the attempt-completed contract event. It is `undefined` when no price is known. The `onCost` hook does not fire for such a call.

**Adapters no longer throw an untyped error for a model missing from their pricing table**, and creating a port for such a model no longer fails.

**Unknown cost is no longer reported as zero anywhere.** The instrumentation layer substituted zero when none was reported, and the Codex and Aider adapters reported an explicit zero on every call. A zero is indistinguishable from a free call, so totals including these were under-counting silently.

New helpers: `computeChatCostOptional`, `computeEmbeddingCostOptional`.

**TypeScript-strict consumer impact.** Code reading `result.cost.totalUSD` must guard for `undefined`. Code indexing `adapter.pricing[modelId]` must check for `"free"` first. See the migration page.
