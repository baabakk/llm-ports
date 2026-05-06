# `@llm-ports/example-multi-provider`

The features that matter once you have more than one LLM provider:

1. **Fallback chain** — primary cheap-fast model; fall back to backup when the primary is unavailable or its budget is exhausted
2. **USD cost gating** — per-provider hourly/daily/monthly caps enforced **before** the API call, not after
3. **Capability factories** — define "classify intent" once, reuse it across the codebase. Improving the prompt improves every call site.

## Run it

```bash
# 1. Set at least one of the two API keys
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...

# 2. From the monorepo root
pnpm --filter @llm-ports/example-multi-provider start
```

You'll see four customer messages classified into intent + urgency, with each result coming from whichever provider in the chain was available and within budget.

## What's happening

Two adapters wire up. **Their imports are the only LLM-SDK imports in this entire example**:

```ts
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";
```

The registry config is the routing brain:

```
LLM_PROVIDER_PRIMARY=anthropic|claude-haiku-4-5|cost:5/day
LLM_PROVIDER_BACKUP=openai|gpt-4o-mini|cost:10/day
LLM_TASK_ROUTE_TRIAGE=primary,backup
```

The format is `ALIAS=adapter|model|budgetSpec`:

| Field | Example | Notes |
|---|---|---|
| `adapter` | `anthropic` | Matches a key under `adapters: { ... }` in `createRegistryFromEnv` |
| `model` | `claude-haiku-4-5` | Provider's model id |
| `budgetSpec` | `cost:5/day` | `unlimited` or `req:N/window` (request count) or `cost:USD/window` (USD cap). Window: `hour` or `day` or `month`. |

Task-routing strings (e.g. `LLM_TASK_ROUTE_TRIAGE=primary,backup`) name a chain of providers tried in order. If the primary's budget is exhausted (or the provider returns a budget-class error), the registry walks to the next entry and accumulates per-alias reasons. If all fail, you get a single `NoProvidersAvailableError` carrying the full reason map.

## Capability factories

The capability layer is the second decoupling: instead of `llm.generateStructured({...})` scattered across files, each operation gets a factory that bundles schema + rubric + hooks once, then exposes a tiny call signature:

```ts
const classifyIntent = createClassifier({
  port: llm,
  schema: IntentSchema,
  schemaName: "user-intent",
  rubric: "...",
});

// Call site (anywhere in your app):
const result = await classifyIntent({ content: userMessage });
```

Improving the rubric improves every classifier call site. Same shape, no provider-specific code in your business logic.

The seven shipped capabilities: `createClassifier`, `createScorer`, `createDrafter`, `createSummarizer`, `createExtractor`, `createPlanner`, `createAnalyzer`. Each takes a Zod schema (or doesn't, for text-output ones) and emits typed results.

## What this example doesn't show

- **Streaming** (`streamText`, `streamStructured`) — same registry, different method
- **Tool use** (`runAgent`) — same registry, with destructive/confirmation flags on each tool
- **Vision / multimodal** — pass `ContentBlock[]` instead of a string prompt
- **Local-only path** — see `examples/local-to-cloud` (planned) for an Ollama → Anthropic dev-prod flip

## Try it without spending money

This example makes real API calls. To see the routing logic without cost, look at:
- [`packages/core/tests/registry-edges.test.ts`](../../packages/core/tests/registry-edges.test.ts) — fallback chain + cost gating + budget gating, all mocked
- [`packages/core/tests/registry.test.ts`](../../packages/core/tests/registry.test.ts) — registry construction + provider walking
