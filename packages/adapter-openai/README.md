# @llm-ports/adapter-openai

[OpenAI SDK](https://www.npmjs.com/package/openai) adapter for [llm-ports](https://github.com/baabakk/llm-ports). Implements `LLMPort` and `EmbeddingsPort`. The same adapter serves OpenAI plus 12+ OpenAI-compatible providers via `baseURL`, including Groq, Together AI, Fireworks AI, Cerebras, Clarifai, and SambaNova.

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
| Clarifai | `https://api.clarifai.com/v2/ext/openai/v1` |
| SambaNova | `https://api.sambanova.ai/v1` |
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

## Known reasoning models (auto-handled)

Reasoning models consume output tokens on hidden chain-of-thought before producing visible text. The adapter detects this on first call (empty visible text + `finish_reason=length` + a reasoning signal in the response) and retries once with the budget expanded by a headroom multiplier.

`KNOWN_REASONING_MODELS` is a static catalog that pre-seeds the cache at port creation so the first call against a known reasoning model already uses the expanded budget — no wasted round-trip:

| Pattern | Provider example |
|---|---|
| `o1*` / `o3*` / `o4*` | OpenAI native |
| `gpt-5-nano*` | OpenAI native |
| `gpt-oss-*` | Cerebras (`baseURL=https://api.cerebras.ai/v1`) |
| `qwen3[._-]?6*` | Clarifai (canonical ID `Qwen3_6-35B-A3B-FP8`) |
| `minimax[-_]?m2[._]7*` | SambaNova (canonical ID `MiniMax-M2.7`) |

Unknown reasoning models still get caught by runtime learning on first call; the catalog only saves the first-call round-trip. User-supplied `pricingOverrides[modelId].capabilities.reasoningModel` always wins.

```typescript
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const clarifai = createOpenAIAdapter({
  apiKey: process.env.CLARIFAI_PAT!,
  baseURL: "https://api.clarifai.com/v2/ext/openai/v1",
  displayName: "clarifai",
  pricingOverrides: {
    "Qwen3_6-35B-A3B-FP8": { inputPer1M: 0.76, outputPer1M: 0.43 },
  },
});
```

## Pricing

The bundled `pricing.ts` table covers GPT-5 family (gpt-5, gpt-5-mini, gpt-5-nano), GPT-4o family, o3 / o3-mini, and the embedding models. Override per model via the registry's `pricingOverrides` option.

Bundled pricing does NOT cover compat-provider models (Groq, Together AI, Fireworks, Cerebras, Clarifai, SambaNova, LiteLLM proxy, etc.) — supply `pricingOverrides` for those.

## License

MIT
