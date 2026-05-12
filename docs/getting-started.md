# Getting Started

`llm-ports` is a small, focused TypeScript library for running LLMs against multiple providers with typed capabilities, cost control, and fallback chains. Under 3000 lines total. Zero LangChain dependencies.

This page gets you from `pnpm install` to a working LLM call in under 5 minutes.

## Install

You always need `@llm-ports/core`. You also pick at least one adapter and (optionally) the capabilities package.

```bash
pnpm add @llm-ports/core @llm-ports/adapter-anthropic @anthropic-ai/sdk zod

# Optional: reusable cognitive operations (classify, draft, score, ...)
pnpm add @llm-ports/capabilities
```

For other providers:

| Provider | Install |
|----------|---------|
| OpenAI (or 10+ compat: Groq, Together, Fireworks, Cerebras, ...) | `pnpm add @llm-ports/adapter-openai openai` |
| Ollama (local LLMs) | `pnpm add @llm-ports/adapter-ollama ollama` |
| Vercel AI SDK migration | `pnpm add @llm-ports/adapter-vercel ai @ai-sdk/anthropic` |

## Configure providers in `.env`

Two env var families: `LLM_PROVIDER_*` declares providers, `LLM_TASK_ROUTE_*` maps task types to fallback chains.

```bash
# Each provider entry: <adapter>|<modelId>|<gating>
LLM_PROVIDER_FAST=anthropic|claude-haiku-4-5|cost:5/day
LLM_PROVIDER_SMART=anthropic|claude-sonnet-4-6-20250514|cost:50/day

# Each task route: comma-separated alias chain (first eligible wins; v0.1 walks
# the chain on budget gating — runtime-error fallback ships in v0.2)
LLM_TASK_ROUTE_TRIAGE=fast,smart
LLM_TASK_ROUTE_DRAFT=smart

# Catch-all for anything else (including the capability factories' default
# task types: classify, score, draft, summarize, extract, plan, analyze).
# If you don't set this, capability factories will throw NoProvidersAvailableError
# unless every implicit task type also has its own LLM_TASK_ROUTE_* entry.
LLM_TASK_ROUTE_GENERAL=fast,smart
```

> **What "first eligible wins" means in v0.1.** When a call comes in, the registry walks the chain in order and picks the first provider that's within its budget cap. If a provider is over budget, the registry walks past it. **The registry does not currently retry on the next provider when a runtime error fires** (network timeout, provider 5xx, 429); that ships in v0.2. See the [multi-provider guide](/guides/multi-provider) for full details, or the [v0.1 status page](/v0-1-status) for the full inventory of v0.1 limitations.

Gating options:

| Token | Meaning |
|-------|---------|
| `req:N/hour` | At most N requests per hour |
| `cost:N/day` | At most $N per day. Also `/hour`, `/month` |
| `req:N/hour,cost:N/day` | Both apply; first to trip blocks |
| `unlimited` | No gating (typical for local Ollama) |

## Initialize the registry

Once at app startup. Hold the returned port as a singleton:

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

const registry = createRegistryFromEnv({
  adapters: {
    anthropic: createAnthropicAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    }),
  },
});

export const llm = registry.getPort();
```

## Make a call

```ts
const result = await llm.generateText({
  taskType: "triage",          // matches LLM_TASK_ROUTE_TRIAGE
  prompt: "Classify this email: ...",
});

console.log(result.text);              // model output
console.log(result.cost.totalUSD);     // exact USD cost of this call
console.log(result.modelId);           // which model was actually used
console.log(result.providerAlias);     // which alias from the env was selected
console.log(result.latencyMs);         // measured end-to-end latency
```

## Structured output

```ts
import { z } from "zod";

const TriageSchema = z.object({
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  needsReply: z.boolean(),
  reasoning: z.string(),
});

const result = await llm.generateStructured({
  taskType: "triage",
  prompt: emailBody,
  schema: TriageSchema,
  schemaName: "email-triage",
});

// result.data is fully typed: { priority: "P0"|...; needsReply: boolean; reasoning: string }
```

If the model returns invalid JSON or the schema fails to parse, the registry retries with the validation errors injected back into the prompt (default strategy: `retry-with-feedback`, max 2 attempts). [More on validation strategies →](/concepts/validation-strategies)

## Reusable capabilities

Don't reimplement classification logic per call site. Use a capability factory:

```ts
import { createClassifier } from "@llm-ports/capabilities";

export const classifyEmail = createClassifier({
  port: llm,
  schema: TriageSchema,
  schemaName: "email-triage",
  rubric: `
    P0: customer-blocking; reply within 1 hour
    P1: investor / board / key partner; same day
    P2: standard professional; within 2 days
    P3: newsletters; no reply needed
  `,
  onResult: async (event) => {
    await myAnalytics.track({
      capability: event.capability,
      cost: event.cost.totalUSD,
      latencyMs: event.latencyMs,
    });
  },
});

// Then anywhere:
const triage = await classifyEmail({ content: emailBody });
```

[All 7 capabilities →](/capabilities/)

## What you got

- ✅ Multi-provider routing with fallback chain
- ✅ Per-call USD cost in the result object
- ✅ Validation retry on invalid structured output
- ✅ Audit trail (provider, model, latency, tokens) on every call
- ✅ One config change to swap providers (no code changes)
- ✅ Capability factories with hooks (analytics, observability)

## Next steps

- [Multi-provider routing in production →](/guides/multi-provider)
- [Local-to-cloud flip with Ollama →](/guides/local-to-cloud)
- [Cost gating in production →](/guides/cost-gating)
- [Tool-use security →](/guides/security)
- [Migrating from Vercel AI SDK →](/migration/from-vercel-ai)
