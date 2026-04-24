# @llm-ports/adapter-anthropic

Direct [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) adapter for [llm-ports](https://github.com/baabakk/llm-ports). Implements `LLMPort` for Claude models with prompt caching, vision, and tool use.

## Installation

```bash
pnpm add @llm-ports/core @llm-ports/adapter-anthropic @anthropic-ai/sdk zod
```

## Usage

```typescript
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

const registry = createRegistryFromEnv({
  adapters: {
    anthropic: createAnthropicAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    }),
  },
});

const llm = registry.getPort();

const result = await llm.generateText({
  taskType: "triage",
  prompt: "Classify this email: ...",
});
```

`.env`:

```
LLM_PROVIDER_FAST=anthropic|claude-haiku-4-5|cost:5/day
LLM_PROVIDER_SMART=anthropic|claude-sonnet-4-6-20250514|cost:50/day
LLM_TASK_ROUTE_TRIAGE=fast,smart
```

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | Supported |
| `generateStructured` (Zod schemas) | Supported with `retry-with-feedback` (default validation strategy) |
| `streamText` | Supported (yields text chunks) |
| `streamStructured` (partial JSON) | Supported (best-effort partial parse) |
| `runAgent` (multi-turn tool use) | Supported |
| Prompt caching | Reported in cost via `cacheReadTokens` / `cacheWriteTokens` |
| Vision input (`image` blocks) | Supported (base64 + URL) |
| Audio input (`audio` blocks) | **Not supported** — throws `ContentBlockUnsupportedError` |
| Embeddings | **Not supported** (Anthropic ships no embedding models) |

## Pricing

The bundled `pricing.ts` table covers Claude Opus 4, Sonnet 4.5/4.6, Haiku 4.5. Override per model via the registry's `pricingOverrides` option.

## License

MIT
