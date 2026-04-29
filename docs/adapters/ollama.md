# `@llm-ports/adapter-ollama`

Native adapter for [Ollama](https://ollama.com), the local LLM daemon. Implements `LLMPort`, `EmbeddingsPort`, and adapter-level `ModelManagement` (list / pull / delete / health). All Ollama models default to **zero-cost, unlimited budget**.

## Why this and not adapter-openai with `baseURL`?

Ollama exposes an OpenAI-compatible endpoint at `http://localhost:11434/v1`, so technically `@llm-ports/adapter-openai` works. The native adapter unlocks features the compatibility layer hides:

- Model management: `listModels`, `pullModel`, `deleteModel`, `checkHealth`
- Auto-pull on first use (optional)
- Keep-alive control (VRAM retention)
- Ollama-specific sampling (`num_predict`, `num_ctx`, etc.) via the SDK
- Zero-cost pricing defaults (every Ollama model priced $0/1M)

## Install

```bash
pnpm add @llm-ports/core @llm-ports/adapter-ollama ollama
```

## Configure

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createOllamaAdapter } from "@llm-ports/adapter-ollama";

const registry = createRegistryFromEnv({
  adapters: {
    ollama: createOllamaAdapter({
      baseURL: "http://localhost:11434",   // default
      autoPull: true,                       // pull missing models on first use
      keepAlive: "5m",                      // VRAM retention (default 5m)
    }),
  },
});

export const llm = registry.getPort();
```

`.env`:

```
LLM_PROVIDER_LOCAL=ollama|llama3.3|unlimited
LLM_TASK_ROUTE_DRAFT=local
```

## Adapter options

```ts
interface OllamaAdapterOptions {
  baseURL?: string;                          // default "http://localhost:11434"
  autoPull?: boolean;                        // default false
  keepAlive?: string;                        // default "5m"
  validationStrategy?: ValidationStrategy;
  pricingOverrides?: Record<string, ModelPricing>;
}
```

## Model management

```ts
const ollama = createOllamaAdapter({ autoPull: false });

// List installed models
const models = await ollama.listModels();
// [{ name: "llama3.3", size: 4_000_000_000, family: "llama", parameterSize: "8B", ... }]

// Pull a model with progress callback
await ollama.pullModel("qwen2.5:32b", (pct) => console.log(`${pct}%`));

// Delete a model
await ollama.deleteModel("old-model");

// Health check (returns ok: false if daemon unreachable)
const health = await ollama.checkHealth();
console.log(health);  // { ok: true, latencyMs: 8 }
```

## Pricing (zero-cost defaults)

```ts
const OLLAMA_DEFAULT_PRICING = {
  inputPer1M: 0,
  outputPer1M: 0,
  embeddingPer1M: 0,
};
```

Every model id resolves to zero-cost. The catch-all default applies to any model id not in the explicit list, so you don't have to maintain pricing entries for every Ollama model you pull.

To track GPU time as an internal cost, override:

```ts
createOllamaAdapter({
  pricingOverrides: {
    "llama3.3:70b": { inputPer1M: 0.05, outputPer1M: 0.05 },  // synthetic "cost"
  },
});
```

This makes cost gating meaningful for local models. Otherwise leave the defaults; gating is correctly disabled.

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (uses `format: "json"` + retry-with-feedback) |
| `streamText` | ✓ |
| `streamStructured` | ✓ |
| `runAgent` (multi-turn tool use) | ✓ (model-dependent; needs Llama 3.3+ or Qwen 2.5+) |
| `generateEmbedding` / `generateEmbeddings` | ✓ (nomic-embed-text, mxbai-embed-large) |
| Vision input — base64 images | ✓ (model-dependent; LLaVA, etc.) |
| Vision input — URL images | ✗ (Ollama doesn't fetch URLs) |
| Audio input | ✗ |
| Model management | ✓ |

## Content blocks supported

`text`, `image` (base64 only), `tool_use`, `tool_result`. Throws `ContentBlockUnsupportedError` for `audio` and URL-form images.

## Reading next

- [Local-to-cloud flip →](/guides/local-to-cloud)
- [Ollama documentation](https://github.com/ollama/ollama)
