# Cost Gating in Production

`llm-ports` ships USD-denominated cost gating as a first-class feature. The thesis: real users care about dollars per day, not requests per hour. Request-count gating is a weak proxy — a 16k-token completion costs ~30× a 500-token one, but request count treats them the same.

This guide covers: how cost is computed per call, how to set caps, how the in-memory backend works, when to swap in a Redis backend, and how to override pricing when providers raise prices between releases.

## How cost is computed

Each adapter ships a [pricing table](https://github.com/baabakk/llm-ports/blob/main/packages/adapter-anthropic/src/pricing.ts) keyed by model id. After every call, the adapter:

1. Reads the token usage from the provider response (`usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, etc.)
2. Looks up the model's pricing entry: `inputPer1M`, `outputPer1M`, optional `cacheReadPer1M`, `cacheWritePer1M`
3. Computes USD cost via `computeChatCost(usage, pricing)`
4. Returns it on the result object as `result.cost.totalUSD`
5. Records it against the provider's running totals via the registered `CostBackend`

If the model id has no pricing entry, the call **fails fast** with an explicit error — no silent zero-costing. That includes models you might add to env config but forget to price; the fix is one of:

- Add the entry to the adapter's `pricing.ts` and submit a PR
- Override locally via `pricingOverrides` (next section)

## Set caps in env

```bash
# Cost cap: $50/day on this provider
LLM_PROVIDER_PREMIUM=anthropic|claude-sonnet-4-6-20250514|cost:50/day

# Multiple windows: per-hour AND per-day. First to trip blocks.
LLM_PROVIDER_GPT_TIGHT=openai|gpt-5|cost:1/hour,cost:20/day

# Combine with request gating
LLM_PROVIDER_BALANCED=openai|gpt-5-mini|req:500/hour,cost:5/day

# Local Ollama: no cost, no limit
LLM_PROVIDER_LOCAL=ollama|llama3.3|unlimited
```

Available windows: `cost:N/hour`, `cost:N/day`, `cost:N/month`. Multiple may apply at once.

## Override pricing for a model

Providers raise prices. Releases lag. Use `pricingOverrides` for the daily-use escape hatch:

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

export const registry = createRegistryFromEnv({
  adapters: {
    anthropic: createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  },
  pricingOverrides: {
    // Override the bundled rate; effective immediately, no release needed
    "claude-sonnet-4-6-20250514": { inputPer1M: 3.5, outputPer1M: 17.5 },
    // Add a model not in the bundled table at all
    "claude-experimental-x": { inputPer1M: 5, outputPer1M: 25 },
  },
});
```

When a release ships updated bundled pricing, you can drop the override.

## Inspect cost per call

Every call returns full cost breakdown:

```ts
const result = await llm.generateText({ taskType: "triage", prompt });

result.cost.inputUSD;   // input tokens cost (incl. cache reads/writes)
result.cost.outputUSD;  // output tokens cost
result.cost.totalUSD;   // sum
result.cost.cacheDiscountUSD;  // savings vs paying full input rate (when cache used)

result.usage.inputTokens;       // raw token counts
result.usage.outputTokens;
result.usage.cacheReadTokens;   // present if model used prompt cache
```

Wire this to your analytics / observability pipeline via the [observability hooks on capabilities](/capabilities/) or directly in your activity wrappers.

## Swap in a Redis backend for multi-process

The default `InMemoryBudget` and `InMemoryCost` backends work for single-process apps. For multi-process deployments (Temporal workers, multiple API server replicas, etc.), the counters need to be shared. Implement the `CostBackend` interface against Redis:

```ts
import type { CostBackend, CostCheckResult, CostLimit } from "@llm-ports/core";
import { createRegistryFromEnv } from "@llm-ports/core";
import { createClient } from "redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

class RedisCost implements CostBackend {
  async recordCost(alias: string, usd: number): Promise<void> {
    const now = Date.now();
    const key = `cost:${alias}`;
    // Use a sorted set with timestamp scores; trim entries older than 30d
    await redis.zAdd(key, { score: now, value: `${now}:${usd}` });
    await redis.zRemRangeByScore(key, 0, now - 30 * 24 * 60 * 60 * 1000);
  }

  async check(alias: string, limit: CostLimit): Promise<CostCheckResult> {
    if (limit.kind === "unlimited") {
      return { allowed: true, current: 0, limit: Infinity };
    }
    // Sum recent entries by window; trip if any cap exceeded
    // (full implementation in @llm-ports/backend-redis when it ships in v0.2)
    // ...
  }
}

export const registry = createRegistryFromEnv({
  adapters: { ... },
  cost: new RedisCost(),
});
```

A reference Redis backend will ship as `@llm-ports/backend-redis` in v0.2.

## Sunset / monthly budgets

Set a monthly cap to enforce a hard ceiling on spend:

```bash
LLM_PROVIDER_BUDGET=anthropic|claude-haiku-4-5|cost:0.5/hour,cost:5/day,cost:100/month
```

The monthly window prevents drift across days. Combined with hourly and daily windows, you get layered defense: hourly catches a runaway script, daily catches a buggy automation, monthly catches everything else.

## What this DOESN'T do

- **Doesn't enforce per-tenant or per-user budgets.** That's an application concern. The registry alias is application-level. For per-tenant gating, you'd build it as a wrapper that selects a per-tenant alias.
- **Doesn't refund failed calls.** If a call fails mid-stream after some tokens were charged, the cost gate doesn't know. In practice provider failures usually charge $0 anyway.
- **Doesn't predict cost ahead of time.** Budget check happens before the call; cost recording happens after. A single call can trip the cap mid-day; subsequent calls are blocked but the tripping call itself succeeds.

## Reading next

- [Multi-provider routing →](/guides/multi-provider) — fallback chain mechanics
- [Cost vs request gating →](/concepts/cost-vs-request-gating) — when to use which
