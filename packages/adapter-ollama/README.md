# @llm-ports/adapter-ollama

[Ollama](https://ollama.com) adapter for [llm-ports](https://github.com/baabakk/llm-ports). Local LLMs via the Ollama daemon. Implements `LLMPort`, `EmbeddingsPort`, and adapter-level model management (list / pull / delete / health).

## Why this adapter exists

Ollama exposes an OpenAI-compatible endpoint, so technically `@llm-ports/adapter-openai` with `baseURL: "http://localhost:11434/v1"` works. The native adapter unlocks features the compatibility layer hides:

- Model management: `listModels`, `pullModel`, `deleteModel`, `checkHealth`
- Auto-pull on first use (optional)
- Keep-alive control (VRAM retention)
- Ollama-specific sampling (`num_predict`, `num_ctx`, etc., via the SDK)
- No-cost defaults (every Ollama model is priced $0/1M; budget gating defaults to `unlimited`)

## Installation

```bash
pnpm add @llm-ports/core @llm-ports/adapter-ollama ollama
```

## Usage

```typescript
import { createRegistryFromEnv } from "@llm-ports/core";
import { createOllamaAdapter } from "@llm-ports/adapter-ollama";

const registry = createRegistryFromEnv({
  adapters: {
    ollama: createOllamaAdapter({
      baseURL: "http://localhost:11434",
      autoPull: true,
    }),
  },
});

const llm = registry.getPort();
const result = await llm.generateText({
  taskType: "draft",
  prompt: "Write a haiku about TypeScript.",
});
```

`.env`:

```
LLM_PROVIDER_LOCAL=ollama|llama3.3|unlimited
LLM_TASK_ROUTE_DRAFT=local
```

## The local-to-cloud flip

Develop on Ollama, ship to a cloud provider, change one line:

```diff
# .env (development)
-LLM_PROVIDER_DRAFT=ollama|llama3.3|unlimited
+LLM_PROVIDER_DRAFT=anthropic|claude-sonnet-4-6|cost:200/day
```

Application code never changes. `llm.generateText({ taskType: "draft", ... })` routes to whichever provider is configured.

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | Supported |
| `generateStructured` (Zod schemas) | Supported (uses Ollama's `format: "json"` + `retry-with-feedback`) |
| `streamText` | Supported |
| `streamStructured` (partial JSON) | Supported (best-effort partial parse) |
| `runAgent` (multi-turn tool use) | Supported (model-dependent; tools require capable models like Llama 3.3+) |
| `generateEmbedding` / `generateEmbeddings` | Supported (nomic-embed-text, mxbai-embed-large) |
| Vision input (base64 images) | Supported (model-dependent; needs vision-capable model like LLaVA) |
| Vision input (URL images) | **Not supported** — Ollama does not fetch URLs; pre-fetch and pass base64 |
| Audio input | **Not supported** by Ollama chat |
| Model management | `listModels`, `pullModel(onProgress)`, `deleteModel`, `checkHealth` |
| Auto-pull on first use | Optional, controlled by `autoPull` flag |

## Model management example

```typescript
const adapter = createOllamaAdapter({ autoPull: false });

// List installed models
const models = await adapter.listModels();
console.log(models); // [{ name: "llama3.3", size: 4_000_000_000, ... }]

// Pull a model with progress callback
await adapter.pullModel("qwen2.5:32b", (pct) => console.log(`${pct}%`));

// Health check
const health = await adapter.checkHealth();
if (!health.ok) throw new Error("Ollama daemon unreachable");
```

## License

MIT
