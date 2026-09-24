# `@llm-ports/adapter-vercel`

Adapter for the [Vercel AI SDK](https://www.npmjs.com/package/ai). Migration helper for users already using `@ai-sdk/*`. Implements `LLMPort` and `EmbeddingsPort`.

## When to use this adapter

- You already have `@ai-sdk/anthropic`, `@ai-sdk/openai`, etc. wired into your project
- You want to add `llm-ports` (cost gating, fallback chains, capability factories) without rewriting the integration

For new projects, prefer the direct adapters (`@llm-ports/adapter-anthropic`, `@llm-ports/adapter-openai`). Not because this one is missing features, since the feature table below is nearly identical, but because it reaches the provider through one more library: a provider quirk arrives here filtered through Vercel's own translation, and reasoning-token budgets are handled less precisely as a result.

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

`pricing` is optional. The adapter ships a bundled table covering the common OpenAI, Anthropic and Google models reached through `@ai-sdk/openai`, `@ai-sdk/anthropic` and `@ai-sdk/google`, and anything you pass merges on top of it, with your entries winning. Since the Vercel ecosystem is wider than the bundled table (LMStudio, OpenRouter, Perplexity and others are not in it), supply pricing for whatever it does not cover. A model with no pricing reports usage without cost rather than reporting a cost of zero.

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (prompted JSON + retry-with-feedback) |
| `streamText` | ✓ |
| `streamStructured` | ✓ (best-effort partial parse) |
| `runAgent` | ✓ multi-turn, through Vercel's own tool loop (`maxSteps`, default 10) |
| `generateEmbedding` / `generateEmbeddings` | ✓ |
| Multimodal content blocks | ✓ images, audio and documents as base64; images also by URL |

## Limitations to know

Current as of `0.1.0-alpha.35`, checked against the adapter source rather than against earlier release notes. Four entries that stood here through v0.1 are gone because the features shipped: the multi-turn agent loop, multimodal content, bundled pricing, and a typed empty-response error, all in `0.1.0-alpha.8` or since.

- **Reasoning budgets are rescued after the fact, not anticipated.** The OpenAI adapter multiplies the token budget up front for a model it knows reasons internally. This adapter does not: a reasoning model given a small `maxOutputTokens` can spend the whole budget thinking and return empty text, at which point the adapter retries once with an expanded budget and fires `onRetry` with reason `reasoning-starvation`. That recovers the call and costs an extra round trip. Setting `maxOutputTokens` well above your visible-output budget avoids it, and `@llm-ports/adapter-openai` avoids it without help.
- **Audio by URL is refused.** Vercel routes audio as file data rather than as a fetchable URL, so an audio block in URL form throws `ContentBlockUnsupportedError` naming that. Pass audio as base64 with its media type. Images accept either form.
- **Tool-role messages are flattened to user text.** Vercel carries tool results in a dedicated role with its own part shape, and threading tool-call identifiers through it is not implemented here, so a `tool` message is sent as user text. Multi-turn agent runs are unaffected, since the loop belongs to Vercel and never round-trips those messages through this adapter.
- **The model surface is yours to keep current.** You wire `@ai-sdk/*` model objects in yourself, which is the point of this adapter, and that also means a model rename or deprecation in one of those packages surfaces here rather than being absorbed for you.

## Cancellation

Full `AbortSignal` support shipped in `0.1.0-alpha.6`. The signal is passed through to Vercel's `abortSignal` field on `generateText` / `streamText`, so `controller.abort()` cancels the in-flight provider HTTP request (the cancellation propagates from Vercel to the underlying provider SDK). See the [Cancellation guide](/guides/cancellation).

## Reading next

- [Migration from Vercel AI SDK →](/migration/from-vercel-ai)
- [Adapter feature matrix →](/adapters/) — when to use this vs direct adapters
