# @llm-ports/adapter-vercel

[Vercel AI SDK](https://www.npmjs.com/package/ai) adapter for [llm-ports](https://github.com/baabakk/llm-ports). Migration helper for users already using `@ai-sdk/*`.

## Why this adapter exists

If you've already wired your project around `@ai-sdk/anthropic`, `@ai-sdk/openai`, etc., you can adopt llm-ports without rewriting that integration. This adapter takes your pre-configured Vercel `LanguageModel` instances and routes `LLMPort` calls through Vercel's `generateText`, `streamText`, `embed`, and `embedMany` helpers. You get cost gating, fallback chains, and capability factories on top of the stack you already have.

For new projects, prefer the direct adapters (`@llm-ports/adapter-anthropic`, `@llm-ports/adapter-openai`) — fewer layers, more control.

## Installation

```bash
pnpm add @llm-ports/core @llm-ports/adapter-vercel ai @ai-sdk/anthropic
```

## Usage

```typescript
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

const llm = registry.getPort();
```

`.env`:

```
LLM_PROVIDER_FAST=vercel|claude-sonnet-4-6|cost:50/day
LLM_PROVIDER_GPT=vercel|gpt-5|cost:100/day
LLM_TASK_ROUTE_TRIAGE=fast,gpt
```

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | Supported |
| `generateStructured` (Zod schemas) | Supported (prompted JSON + retry-with-feedback) |
| `streamText` | Supported |
| `streamStructured` (partial JSON) | Supported (best-effort partial parse) |
| `runAgent` | **Limited in v0.1**: single-turn only; multi-turn tool use via Vercel's own agent loop comes in v0.2 |
| `generateEmbedding` / `generateEmbeddings` | Supported |
| Multimodal content blocks | Limited (string conversion in v0.1) |

## When to use this vs the direct adapters

| You're already on `@ai-sdk/*` and want to add llm-ports | Use this adapter |
| You're building a new project | Use `adapter-anthropic`, `adapter-openai`, etc. directly |
| You need full multimodal + advanced agent features | Use the direct adapters |

## License

MIT
