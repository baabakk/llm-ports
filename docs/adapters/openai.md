# `@llm-ports/adapter-openai`

Direct adapter for the [OpenAI SDK](https://www.npmjs.com/package/openai). Implements both `LLMPort` and `EmbeddingsPort`. The `baseURL` option means the same adapter serves OpenAI plus 10+ OpenAI-compatible providers.

## Install

```bash
pnpm add @llm-ports/core @llm-ports/adapter-openai openai zod
```

## Configure (OpenAI default)

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const registry = createRegistryFromEnv({
  adapters: {
    openai: createOpenAIAdapter({
      apiKey: process.env.OPENAI_API_KEY!,
    }),
  },
});

export const llm = registry.getPort();
```

## Configure (compat providers via `baseURL`)

| Provider | `baseURL` | Notes |
|----------|-----------|-------|
| OpenAI | (none) | Default |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>` | Needs `api-version` header |
| Groq | `https://api.groq.com/openai/v1` | Fast inference |
| Together AI | `https://api.together.xyz/v1` | Open models |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | Open models |
| DeepInfra | `https://api.deepinfra.com/v1/openai` | Open models |
| Perplexity | `https://api.perplexity.ai` | Online models with citations |
| Cerebras | `https://api.cerebras.ai/v1` | Fast inference |
| LiteLLM proxy | self-hosted, e.g. `http://localhost:4000` | Self-hosted proxy |
| Ollama (compat mode) | `http://localhost:11434/v1` | Prefer [`adapter-ollama`](/adapters/ollama) for native API + management |

Each compatible provider has its own pricing — supply via `pricingOverrides`:

```ts
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

createOpenAIAdapter({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
  pricingOverrides: {
    "llama-3.3-70b-versatile": { inputPer1M: 0.59, outputPer1M: 0.79 },
  },
});
```

## Adapter options

```ts
interface OpenAIAdapterOptions {
  apiKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
  validationStrategy?: ValidationStrategy;
  pricingOverrides?: Record<string, ModelPricing>;
  displayName?: string;       // for error messages when pointed at a non-OpenAI baseURL
}
```

## Bundled pricing

| Model | Input/1M | Output/1M | Cached input |
|-------|---------:|----------:|-------------:|
| `gpt-5` | $2.50 | $10.00 | $0.25 |
| `gpt-5-mini` | $0.15 | $0.60 | $0.075 |
| `gpt-5-nano` | $0.05 | $0.20 | $0.025 |
| `gpt-4o` | $2.50 | $10.00 | $1.25 |
| `gpt-4o-mini` | $0.15 | $0.60 | $0.075 |
| `o3` | $15.00 | $60.00 | $7.50 |
| `o3-mini` | $1.10 | $4.40 | $0.55 |
| `text-embedding-3-small` | n/a | n/a | $0.02 (per 1M input tokens) |
| `text-embedding-3-large` | n/a | n/a | $0.13 |

Source: openai.com/pricing. Verified 2026-04-10.

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (native `response_format: json_object` + retry-with-feedback) |
| `streamText` | ✓ |
| `streamStructured` | ✓ |
| `runAgent` (multi-turn tool use) | ✓ |
| `generateEmbedding` / `generateEmbeddings` | ✓ |
| Vision input — base64 images | ✓ (data URI) |
| Vision input — URL images | ✓ |
| Audio input — base64 wav, mp3 | ✓ |
| Audio input — base64 ogg | ✗ (OpenAI doesn't support ogg) |
| Audio input — URL audio | ✗ (OpenAI requires base64) |
| Prompt caching | partial (`cached_tokens` reported in usage) |

## Content blocks supported

`text`, `image` (base64 → data URI; URL passthrough), `audio` (base64 wav/mp3 only), `tool_use`, `tool_result`. The adapter throws `ContentBlockUnsupportedError` for unsupported variants.

## Reading next

- [Multi-provider routing](/guides/multi-provider) — wire multiple compat providers as separate aliases
- [OpenAI pricing](https://openai.com/api/pricing/) — verify bundled table
