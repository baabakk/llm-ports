# Cost vs Request Gating

`llm-ports` supports two gating modes per provider: **request count** (`req:N/hour`) and **USD cost** (`cost:N/day`, also `/hour`, `/month`). They can combine. This page explains when to use which.

## TL;DR

| You want to | Use |
|-------------|-----|
| Cap real dollar spend | `cost:N/day` (or `/hour`, `/month`) |
| Cap rate of requests (e.g. respect provider's RPM limit) | `req:N/hour` |
| Hard ceiling regardless of model size | `cost:N/day` |
| Both: rate AND budget | `req:N/hour,cost:N/day` |
| Local Ollama (no real cost, no rate limit) | `unlimited` |

For most production usage, **cost gating is the primary tool**. Request count is what you used in 2023 because that was easier to compute. Now, knowing the dollar amount per call is built in — use it.

## What "request gating" measures

Just request count. A 10-token request and a 100,000-token request count the same. This is a **weak proxy for spend** because input/output token volume drives actual cost.

When request gating still makes sense:

- The provider has a hard rate limit (e.g. 200 requests/minute) and you want to avoid 429s.
- Calls are highly predictable in size and you trust the count as a proxy.
- You're prototyping and don't have pricing data yet.

## What "cost gating" measures

The actual USD cost computed from token usage and the model's pricing entry. Cache reads (Anthropic's prompt caching feature) priced at the discounted rate. Embedding models priced at `embeddingPer1M`.

Cost is tracked at 10-decimal-place precision so per-call costs as low as `$1e-7` (e.g. a 5-token embedding at `$0.02/1M`) survive the gate without rounding to zero. If you cost-gate embedding workloads on a tight per-day cap, the smallest single-call cost the gate can resolve is `$0.0000001`.

This is **what you actually care about** in production: how many dollars will this provider spend today.

## Combining both

```bash
# Both apply. First to trip blocks.
LLM_PROVIDER_BALANCED=openai|gpt-5-mini|req:500/hour,cost:5/day
```

Useful when:

- You want a request rate ceiling to avoid 429s, AND a dollar cap as the real safety net.
- You want a soft ceiling (cost) and a hard ceiling (request rate the provider would reject anyway).

## Multi-window cost gating

Cost can be capped per-hour, per-day, AND per-month simultaneously. **First window to trip blocks** the provider.

```bash
# Layered defense:
#   - per-hour catches a runaway script
#   - per-day catches a buggy automation
#   - per-month catches everything else
LLM_PROVIDER_PROTECTED=openai|gpt-5|cost:1/hour,cost:20/day,cost:300/month
```

The math:

- `cost:1/hour` blocks new calls if the past hour summed > $1
- `cost:20/day` blocks if the past 24 hours summed > $20
- `cost:300/month` blocks if the past 30 days summed > $300

A call passing all three windows runs. Once any window trips, the provider is skipped (and the next provider in the chain gets the call, if there is one).

## P0 bypasses gating

Mark a critical call as `priority: 0`:

```ts
await llm.generateText({
  taskType: "compliance-alert",
  priority: 0,                  // bypasses budget + cost gating
  prompt: "...",
});
```

Use sparingly. The reason a P0 call exists is the cost of NOT running it is much higher than the LLM call cost.

## What gating doesn't do

- **Doesn't refund failed calls.** If a streaming response fails mid-token, the cost recorded is whatever the adapter computed (which depends on whether the provider returned token counts in the partial response).
- **Doesn't predict cost ahead of time.** Budget check happens before the call; cost recording happens after. A single call CAN trip the cap mid-day; subsequent calls are blocked but the tripping call itself succeeds.
- **Doesn't enforce per-tenant or per-user budgets.** That's an application concern. The registry alias is application-level; per-tenant gating is a wrapper your application writes.

## In-memory vs Redis backends

The default `InMemoryBudget` and `InMemoryCost` work for single-process deployments. For multi-process (multiple Temporal workers, multiple API server replicas), counters need to be shared across processes. A reference Redis backend ships in v0.2 as `@llm-ports/backend-redis`. Until then, write your own:

```ts
import type { CostBackend } from "@llm-ports/core";

class MyRedisCost implements CostBackend {
  async recordCost(alias, usd) { /* ... */ }
  async check(alias, limit)    { /* ... */ }
}

createRegistryFromEnv({
  adapters: { ... },
  cost: new MyRedisCost(),
});
```

See the [cost gating guide →](/guides/cost-gating) for a worked example.

## Reading next

- [Cost gating guide →](/guides/cost-gating) — practical setup
- [Multi-provider routing →](/guides/multi-provider) — fallback chain mechanics
