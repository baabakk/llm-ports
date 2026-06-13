# Cost vs Request Gating

`llm-ports` supports four gating dimensions per provider, configurable via env tokens, plus a per-scope dimension that the caller supplies at call time. This page documents every token alpha.20 ships and shows how they compose.

## TL;DR (alpha.20)

| You want to | Use |
|---|---|
| Cap real dollar spend per day / hour / month | `cost:N/day` (or `/hour`, `/month`) |
| Cap dollar spend per minute (rate-protect against expensive bursts) | `cost:N/minute` |
| Cap request rate per minute (provider RPM limit, e.g. Cerebras 30 RPM) | `req:N/minute` |
| Cap request rate per hour | `req:N/hour` |
| Hard per-session ceilings | `cost:N/session`, `req:N/session`, `total_tokens:N/session`, `tool_calls:N/session` |
| Per-tenant / per-customer / per-user / per-agent / per-session quotas | Set caps in env; pass `budgetScope: { scope, scopeId }` on each call |
| Local Ollama (no real cost, no rate limit) | `unlimited` |

For most production usage, **cost gating is the primary tool**. Request count is what you used in 2023 because that was easier to compute. Now, knowing the dollar amount per call is built in — use it. Use `req:N/minute` only when a provider's RPM limit physically caps your throughput.

## What's new in alpha.20

The env-token grammar gained five dimensions:

- **`req:N/minute`** — request-count cap per rolling minute. Designed for Cerebras (30 RPM) and similar providers whose throughput cap can't be expressed in `req:N/hour` without false negatives.
- **`cost:N/minute`** — USD cap per rolling minute. Catches expensive bursts without waiting for the hour mark.
- **`cost:N/session`** — USD cap per `CostSession`. Backwards-compatible with the alpha.18 `openCostSession({ budgetUSD })` constructor argument.
- **`req:N/session`**, **`total_tokens:N/session`**, **`tool_calls:N/session`** — request, token, and tool-call ceilings per `CostSession`. Trip `SessionBudgetExceededError` with a `grain` field naming which cap fired.

Plus a per-call scope hint: `budgetScope?: { scope, scopeId }` on every request option type. When set, the Registry composes the gating storage key as `${alias}|${scope}:${scopeId}`, making every configured cap apply per-tenant / per-customer / per-user / per-agent / per-session instead of per-alias. Omitting it preserves alpha.19.1 per-alias behavior — every existing caller works unchanged.

```ts
// Same provider config, two tenants. Each tenant has its own $50/day budget.
await llm.generateText({
  taskType: "triage",
  prompt: messageForTenantAcme,
  budgetScope: { scope: "tenant", scopeId: "acme" },
});

await llm.generateText({
  taskType: "triage",
  prompt: messageForTenantInitech,
  budgetScope: { scope: "tenant", scopeId: "initech" },
});
```

## Verified behavior matrix (alpha.20)

Every cell is enforced at runtime and covered by a test in [`packages/core/tests/budget-scope.test.ts`](https://github.com/baabakk/llm-ports/blob/main/packages/core/tests/budget-scope.test.ts).

| Dimension | Env token | Enforced by | Per-scope? |
|---|---|---|---|
| Requests per minute | `req:N/minute` | `InMemoryBudget.check` | Yes (when `budgetScope` set) |
| Requests per hour | `req:N/hour` | `InMemoryBudget.check` (legacy `requestsPerHour` populated for backwards compat) | Yes |
| Requests per session | `req:N/session` | `CostSession.maxRequests` | n/a (session = scope) |
| USD per minute | `cost:N/minute` | `InMemoryCost.check` | Yes |
| USD per hour | `cost:N/hour` | same | Yes |
| USD per day | `cost:N/day` | same | Yes |
| USD per month | `cost:N/month` | same | Yes |
| USD per session | `cost:N/session` | `CostSession.budgetUSD` | n/a |
| Total tokens per session | `total_tokens:N/session` | `CostSession.maxTokens` | n/a |
| Tool calls per session | `tool_calls:N/session` | `CostSession.maxToolCalls` | n/a |

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
