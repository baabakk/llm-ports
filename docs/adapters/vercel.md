# `@llm-ports/adapter-vercel`

Adapter for the [Vercel AI SDK](https://www.npmjs.com/package/ai). Migration helper for users already using `@ai-sdk/*`. Implements `LLMPort` and `EmbeddingsPort`.

## When to use this adapter

- You already have `@ai-sdk/anthropic`, `@ai-sdk/openai`, etc. wired into your project
- You want to add `llm-ports` (cost gating, fallback chains, capability factories) without rewriting the integration

For new projects, prefer the direct adapters (`@llm-ports/adapter-anthropic`, `@llm-ports/adapter-openai`). Fewer layers, full multimodal, full agent features.

## Install

```bash
pnpm add @llm-ports/core @llm-ports/adapter-vercel ai @ai-sdk/anthropic
```

## Configure

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createRegistryFromEnv } from "@llm-ports/core";
import { createVercelAdapter } from "@llm-ports/adapter-vercel";

const registry = createRegistryFromEnv({
  adapters: {
    vercel: createVercelAdapter({
      models: {
        "claude-sonnet-4-6": anthropic("claude-sonnet-4-6"),
        "gpt-5": openai("gpt-5"),
      },
      embeddingModels: {
        "text-embedding-3-small": openai.textEmbeddingModel("text-embedding-3-small"),
      },
      pricing: {
        "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
        "gpt-5": { inputPer1M: 2.5, outputPer1M: 10 },
        "text-embedding-3-small": { inputPer1M: 0, outputPer1M: 0, embeddingPer1M: 0.02 },
      },
    }),
  },
});

export const llm = registry.getPort();
```

You bring your own `LanguageModel` instances. The adapter routes `LLMPort` calls to Vercel's helpers (`generateText`, `streamText`, `embed`, `embedMany`).

## Adapter options

```ts
interface VercelAdapterOptions {
  models?: Record<string, LanguageModel>;
  embeddingModels?: Record<string, EmbeddingModel<string>>;
  pricing: Record<string, ModelPricing>;     // REQUIRED
  validationStrategy?: ValidationStrategy;
}
```

`pricing` is required because the adapter has no built-in pricing table — models can come from any of `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, etc. You supply the pricing for whatever you wire up.

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (prompted JSON + retry-with-feedback) |
| `streamText` | ✓ |
| `streamStructured` | ✓ (best-effort partial parse) |
| `runAgent` | **Limited in v0.1**: single-turn only; multi-turn tool use through Vercel's own agent loop comes in v0.2 |
| `generateEmbedding` / `generateEmbeddings` | ✓ |
| Multimodal content blocks | partial (string conversion in v0.1; full multimodal in v0.2) |

## Limitations to know

- **`runAgent` is single-turn in v0.1.** Multi-step tool use through Vercel's own agent loop will land in v0.2 once the API surface is locked down. For multi-turn agents today, prefer the direct adapters.
- **Multimodal is text-only in v0.1.** Image and audio content blocks pass through as a stringified `[image content]` placeholder. Direct adapters support full multimodal.
- **You bring your own pricing.** No bundled table. Look up the rates for your chosen models from the provider's pricing page.

## Reading next

- [Migration from Vercel AI SDK →](/migration/from-vercel-ai)
- [Adapter feature matrix →](/adapters/) — when to use this vs direct adapters
