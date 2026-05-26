# @llm-ports/adapter-ollama

[Ollama](https://ollama.com) adapter for [llm-ports](https://github.com/baabakk/llm-ports). Local LLMs via the Ollama daemon. Implements `LLMPort`, `EmbeddingsPort`, and adapter-level model management (list / pull / delete / health).

## Why this adapter exists

Ollama exposes an OpenAI-compatible endpoint, so technically `@llm-ports/adapter-openai` with `baseURL: "http://localhost:11434/v1"` works. The native adapter unlocks features the compatibility layer hides:

- Model management: `listModels`, `pullModel`, `deleteModel`, `checkHealth`
- Auto-pull on first use (optional)
- Keep-alive control (VRAM retention)
- Ollama-specific sampling (`num_predict`, `num_ctx`, etc., via the SDK)
- No-cost defaults (every Ollama model is priced $0/1M; budget gating defaults to `unlimited`)

## Install

```bash
pnpm add @llm-ports/core @llm-ports/adapter-ollama ollama
```

## Configure

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

## Adapter options

```ts
interface OllamaAdapterOptions {
  baseURL?: string;                    // default "http://localhost:11434"
  autoPull?: boolean;                  // default false
  keepAlive?: string;                  // default "5m" (VRAM retention)
  validationStrategy?: ValidationStrategy;
  pricingOverrides?: Record<string, ModelPricing>;
  imageSizeLimitBytes?: number;        // unset by default (model-dependent)
}
```

## Bundled pricing

`OLLAMA_PRICING` defaults every model to `$0/1M` (local inference is free at the API layer; you pay in hardware + electricity). Override via `pricingOverrides` if you want to attribute internal cost (electricity, GPU-hour amortization) — useful for cost-tracking dashboards.

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
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (uses Ollama's `format: "json"` + `retry-with-feedback`) |
| `streamText` | ✓ |
| `streamStructured` (partial JSON) | ✓ (best-effort partial parse) |
| `runAgent` (multi-turn tool use) | ✓ (model-dependent; tools need capable models like Llama 3.3+) |
| `generateEmbedding` / `generateEmbeddings` | ✓ (nomic-embed-text, mxbai-embed-large) |
| Vision input — base64 images | ✓ (model-dependent; needs vision model like LLaVA) |
| Vision input — URL images | ✗ — Ollama doesn't fetch URLs; pre-fetch + pass base64 |
| Audio input | ✗ — Ollama chat doesn't support audio |
| Model management | ✓ `listModels`, `pullModel(onProgress)`, `deleteModel`, `checkHealth` |
| Auto-pull on first use | ✓ (opt-in via `autoPull` flag) |
| `AbortSignal` cancellation | partial — entry-time check only (ollama-js limitation) |

## Content blocks supported

`text`, `image` (base64 only), `tool_use`, `tool_result`. Throws `ContentBlockUnsupportedError` for `audio` and URL-form images.

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

## Cancellation (limited)

Entry-time abort support shipped in `0.1.0-alpha.6` — if `options.signal.aborted` is already true at entry, the call throws without invoking the daemon. **Mid-flight cancellation is NOT supported** because `ollama-js` v0.5 doesn't expose a per-call signal; its `client.abort()` method cancels ALL in-flight requests on the client, which is too coarse for per-call use. Will land when ollama-js v0.7+ exposes per-call signal. See the [Cancellation guide](https://baabakk.github.io/llm-ports/guides/cancellation).

## Reading next

- [Ollama adapter docs](https://baabakk.github.io/llm-ports/adapters/ollama) — full feature deep-dive
- [Local-to-cloud flip guide](https://baabakk.github.io/llm-ports/guides/local-to-cloud) — develop on Ollama, ship to cloud
- [Tool-use security guide](https://baabakk.github.io/llm-ports/guides/security) — `runAgent` safety patterns
- [Ollama documentation](https://github.com/ollama/ollama) — daemon setup, model catalog
