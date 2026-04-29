# `@llm-ports/adapter-anthropic`

Direct adapter for the [Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk). Implements `LLMPort` for Claude models. Does NOT implement `EmbeddingsPort` — Anthropic ships no embedding models.

## Install

```bash
pnpm add @llm-ports/core @llm-ports/adapter-anthropic @anthropic-ai/sdk zod
```

## Configure

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

`.env`:

```
LLM_PROVIDER_FAST=anthropic|claude-haiku-4-5|cost:5/day
LLM_PROVIDER_PREMIUM=anthropic|claude-sonnet-4-6-20250514|cost:50/day
LLM_TASK_ROUTE_TRIAGE=fast,premium
```

## Adapter options

```ts
interface AnthropicAdapterOptions {
  apiKey: string;
  baseURL?: string;          // typically only useful for testing
  fetch?: typeof fetch;       // inject a custom fetch (tests, proxies)
  validationStrategy?: ValidationStrategy;
  pricingOverrides?: Record<string, ModelPricing>;
}
```

## Bundled pricing

| Model | Input/1M | Output/1M | Cache read | Cache write |
|-------|---------:|----------:|-----------:|------------:|
| `claude-opus-4` | $15.00 | $75.00 | $1.50 | $18.75 |
| `claude-sonnet-4-6-20250514` | $3.00 | $15.00 | $0.30 | $3.75 |
| `claude-sonnet-4-5` | $3.00 | $15.00 | $0.30 | $3.75 |
| `claude-haiku-4-5` | $0.80 | $4.00 | $0.08 | $1.00 |

Source: anthropic.com/pricing. Verified 2026-04-10.

Override per model via `pricingOverrides` if prices change between releases:

```ts
createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  pricingOverrides: {
    "claude-sonnet-4-6-20250514": { inputPer1M: 3.5, outputPer1M: 17.5 },
  },
});
```

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (prompted JSON + retry-with-feedback) |
| `streamText` | ✓ |
| `streamStructured` | ✓ (best-effort partial parse) |
| `runAgent` (multi-turn tool use) | ✓ |
| Vision input — base64 images | ✓ |
| Vision input — URL images | ✓ |
| Audio input | ✗ (Anthropic chat doesn't support audio) |
| Prompt caching | ✓ native; cost reflects `cacheReadPer1M` rate |
| Embeddings | ✗ (Anthropic ships no embedding models) |

## Content blocks supported

`text`, `image` (base64 + URL), `tool_use`, `tool_result`. The adapter throws `ContentBlockUnsupportedError` for `audio` blocks.

## Reading next

- [Anthropic prompt caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) — how cache reads are billed
- [Pricing source](https://www.anthropic.com/pricing) — verify the bundled table is current
