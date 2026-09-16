# Multi-Provider Routing

Real production AI systems use multiple LLM providers. Some tasks need fast and cheap (`gpt-5-nano`, `claude-haiku-4-5`); some need slow and smart (`claude-sonnet-4-6`, `gpt-5`). Some need to fall back to a backup provider when the primary is rate-limited. `llm-ports` handles routing and fallback as a config concern, not a code concern.

## The model

Two layers of mapping:

1. **Provider aliases** (`LLM_PROVIDER_*` env vars) declare available providers. Each entry: `<adapter>|<modelId>|<gating>`.
2. **Task routes** (`LLM_TASK_ROUTE_*` env vars) map task types to fallback chains. First available provider wins.

```bash
LLM_PROVIDER_FAST=anthropic|claude-haiku-4-5|cost:5/day
LLM_PROVIDER_PREMIUM=anthropic|claude-sonnet-4-6-20250514|cost:50/day
LLM_PROVIDER_GPT_FAST=openai|gpt-5-mini|cost:5/day

LLM_TASK_ROUTE_TRIAGE=fast,gpt_fast       # try fast first, fall back to gpt_fast
LLM_TASK_ROUTE_DRAFT=premium               # only use premium for drafts
LLM_TASK_ROUTE_RESEARCH=premium,fast       # premium first, degrade to fast
```

Application code never names a provider:

```ts
const triage = await llm.generateText({ taskType: "triage", prompt: emailBody });
// May land on "fast" or "gpt_fast" depending on which is available + within budget
```

## Initialize multiple adapters

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

export const registry = createRegistryFromEnv({
  adapters: {
    anthropic: createAnthropicAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    }),
    openai: createOpenAIAdapter({
      apiKey: process.env.OPENAI_API_KEY!,
    }),
  },
});

export const llm = registry.getPort();
```

The adapter token in env config (`LLM_PROVIDER_FAST=anthropic|...`) matches the key under `adapters` in the registry call.

## Fallback chain semantics

For each call, the registry walks the task's chain in order. A provider is **skipped** if:

- Its budget cap is exceeded (`req:N/hour` already hit this hour)
- Its cost cap is exceeded (`cost:N/day` already exceeded this day)
- It is cost-capped and its model has no known price, under the default `pricingPolicy`

A provider whose adapter is not registered never reaches this point. Since `0.1.0-alpha.34` it is dropped when the registry is constructed, removed from every chain that named it, and reported once as a warning; the other providers keep working. Set `strictConfig: true` to make that a construction error instead. The registry still refuses to construct if nothing usable is left.

The first provider that passes all checks gets the call. If the call **succeeds**, the cost is recorded against that provider's running totals.

If the call **fails** with a provider-side error (network failure, a 5xx, an unreachable provider, a per-attempt timeout, or a content block the provider cannot express), the registry **moves on to the next provider in the chain** automatically. The `runtimeFallback` option decides which errors do that; `"none"` turns it off.

### Which errors move on to the next provider

It depends on `runtimeFallback`. There are three ready-made policies, and **the one you get when you set nothing is not the one called `defaultShouldFallback`**: that name belongs to a broader table you have to pass in explicitly. The policy you get by default is exported as `conservativeShouldFallback`.

In the table, "walks" means the registry tries the next provider in the chain, and "stops" means the error goes back to your code.

| Error | Nothing set, or `"default"` (`conservativeShouldFallback`) | `"aggressive"` | `{ shouldFallback: defaultShouldFallback }` |
|---|---|---|---|
| Provider HTTP 5xx, provider unreachable (refused, DNS failure, connect timeout), attempt timed out, empty response | walks | walks | walks |
| A content block this provider cannot carry, such as a document | walks | walks | walks |
| A credential that has never worked in this process | walks | walks | walks |
| A credential that worked earlier and has now failed | stops | stops | stops |
| Rate limited | stops | walks | walks |
| Prompt too long for this model's context window | stops | walks | walks |
| Content policy violation | stops | stops | walks |
| Image larger than this provider accepts | stops | stops | walks |
| Any other bad request, a configuration error, or a bug in the adapter's own code | stops | stops | stops |

`"aggressive"` also walks on a bad request whose message indicates exhausted credit. `defaultShouldFallback` also walks on `CreditExhaustionError` and `ProviderMalformed400Error`; no shipped adapter throws either, so they matter only for an adapter of your own.

A credential that worked and then stopped working is treated as a change worth hearing about, so it stops under every policy rather than quietly moving on.

**Before `0.1.0-alpha.34`, parts of the first two rows stopped.** With nothing set, a provider HTTP 5xx and an empty response went back to your code instead of walking. Under `"aggressive"`, a provider HTTP 5xx and an unsupported content block did the same. Under every policy, an Ollama daemon that was not running, or a Google endpoint that could not be reached, was reported as a bug in the adapter and stopped. Upgrade if you rely on any of them.

To choose something else entirely, pass your own predicate: `runtimeFallback: { shouldFallback: (err) => ... }`. `"none"` turns fallback off.

If **every provider in the chain is skipped**, the registry throws `NoProvidersAvailableError` with details on what failed and why:

```ts
try {
  await llm.generateText({ taskType: "triage", prompt });
} catch (err) {
  if (err instanceof NoProvidersAvailableError) {
    console.error(`Task ${err.taskType} blocked. Reasons:`, err.reasons);
    // { fast: "Cost cap exceeded for "fast" per day: $5.10 >= $5",
    //   gpt_fast: "Request budget exceeded for "gpt_fast"..." }
  }
}
```

## P0: critical tasks bypass gating

Mark a call as `priority: 0` to bypass budget and cost gating entirely. Use sparingly:

```ts
await llm.generateText({
  taskType: "urgent-alert",
  priority: 0,                  // bypasses budget + cost gating
  prompt: "Translate this incident report",
});
```

Other priorities (1, 2, 3 — defaults to 2) all respect gating. Priority 0 is for tasks where the cost of NOT running them is much higher than the LLM call cost (security alerts, compliance triage, etc.).

## OpenAI-compatible providers in one adapter

`@llm-ports/adapter-openai` accepts a `baseURL`, which means a single adapter installation serves OpenAI plus 10+ compatible providers. Register each as its own alias:

```ts
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

export const registry = createRegistryFromEnv({
  adapters: {
    // Each call to createOpenAIAdapter creates an isolated client.
    // The registry treats them as the same "adapter token" but they
    // route to different baseURLs.
    openai: createOpenAIAdapter({
      apiKey: process.env.OPENAI_API_KEY!,
    }),
    groq: createOpenAIAdapter({
      apiKey: process.env.GROQ_API_KEY!,
      baseURL: "https://api.groq.com/openai/v1",
    }),
    cerebras: createOpenAIAdapter({
      apiKey: process.env.CEREBRAS_API_KEY!,
      baseURL: "https://api.cerebras.ai/v1",
      pricingOverrides: {
        "llama-4-scout-17b": { inputPer1M: 0.65, outputPer1M: 0.85 },
      },
    }),
  },
});
```

Then in env:

```bash
LLM_PROVIDER_OPENAI_PRIMARY=openai|gpt-5|cost:100/day
LLM_PROVIDER_GROQ_FAST=groq|llama-3.3-70b-versatile|cost:5/day
LLM_PROVIDER_CEREBRAS_FAST=cerebras|llama-4-scout-17b|cost:5/day

LLM_TASK_ROUTE_TRIAGE=cerebras_fast,groq_fast,openai_primary
```

## Inspecting topology

The registry exposes its parsed config:

```ts
registry.listProviders();
// [
//   { alias: "fast", adapter: "anthropic", modelId: "claude-haiku-4-5",
//     budgetLimit: { kind: "unlimited" },
//     costLimit: { kind: "usd", perDay: 5 } },
//   ...
// ]

registry.listTasks();
// [
//   { task: "triage", chain: ["fast", "gpt_fast"] },
//   { task: "draft", chain: ["premium"] },
// ]
```

Useful for admin dashboards or runtime debugging.

## What's coming in v0.2

- Automatic retry to the next provider in the chain on transient errors
- Per-call provider preference override (force a specific alias)
- Health-aware routing (skip providers with elevated error rates)
- Per-region routing (route closest first)
