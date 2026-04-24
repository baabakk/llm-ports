# @llm-ports/adapter-openai

[OpenAI SDK](https://www.npmjs.com/package/openai) adapter for [llm-ports](https://github.com/baabakk/llm-ports). Implements `LLMPort` and `EmbeddingsPort`. The same adapter serves OpenAI plus 10+ OpenAI-compatible providers via `baseURL`.

## Installation

```bash
pnpm add @llm-ports/core @llm-ports/adapter-openai openai zod
```

## Usage with OpenAI

```typescript
import { createRegistryFromEnv } from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const registry = createRegistryFromEnv({
  adapters: {
    openai: createOpenAIAdapter({
      apiKey: process.env.OPENAI_API_KEY!,
    }),
  },
});

const llm = registry.getPort();
const embed = registry.getEmbeddingsPort();
```

## Usage with OpenAI-compatible providers

The same adapter works for any provider that exposes an OpenAI-shaped API. Just supply a `baseURL`:

| Provider | `baseURL` |
|----------|-----------|
| OpenAI (default) | (none) |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>` |
| Groq | `https://api.groq.com/openai/v1` |
| Together AI | `https://api.together.xyz/v1` |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Perplexity | `https://api.perplexity.ai` |
| Cerebras | `https://api.cerebras.ai/v1` |
| LiteLLM proxy | self-hosted, e.g. `http://localhost:4000` |
| Ollama compat-mode | `http://localhost:11434/v1` (prefer `adapter-ollama` for native API) |

Each compatible provider has its own pricing — supply via `pricingOverrides`:

```typescript
createOpenAIAdapter({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
  displayName: "groq",
  pricingOverrides: {
    "llama-3.3-70b-versatile": { inputPer1M: 0.59, outputPer1M: 0.79 },
  },
});
```

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | Supported |
| `generateStructured` (Zod schemas) | Supported (uses native `response_format: json_object` + `retry-with-feedback`) |
| `streamText` | Supported |
| `streamStructured` (partial JSON) | Supported (best-effort partial parse) |
| `runAgent` (multi-turn tool use) | Supported |
| `generateEmbedding` / `generateEmbeddings` | Supported (text-embedding-3-small / -large) |
| Vision input (`image` blocks) | Supported (base64 → data URI; URL passthrough) |
| Audio input (`audio` blocks) | Supported (wav, mp3 base64 only; ogg and URL audio not supported) |
| Prompt caching | Reported in cost via `cachedTokens` from `usage.prompt_tokens_details.cached_tokens` |

## Pricing

The bundled `pricing.ts` table covers GPT-5 family (gpt-5, gpt-5-mini, gpt-5-nano), GPT-4o family, o3 / o3-mini, and the embedding models. Override per model via the registry's `pricingOverrides` option.

## License

MIT
