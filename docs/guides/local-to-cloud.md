# Local-to-Cloud Flip

Develop on Ollama, ship on Anthropic. One env var change, no application code changes. This is the headline use case for `@llm-ports/adapter-ollama`.

> **Worked example:** [`examples/local-with-ollama/`](https://github.com/baabakk/llm-ports/tree/main/examples/local-with-ollama) — Ollama health check, `generateText`, `generateStructured`, plus the `FORCE_CLOUD=1` flag that simulates the production-flip on the same code path.

## The flow

```
┌──────────────────────────────────────┐    ┌──────────────────────────────────────┐
│ Development (.env.local)             │    │ Production (.env.production)         │
│                                      │    │                                      │
│ LLM_PROVIDER_DRAFT=ollama|llama3.3   │ -> │ LLM_PROVIDER_DRAFT=anthropic|        │
│                |unlimited            │    │   claude-sonnet-4-6|cost:50/day     │
│                                      │    │                                      │
│ Free, fast iteration, offline        │    │ Production cost-gated, audited       │
└──────────────────────────────────────┘    └──────────────────────────────────────┘

Application code in both environments:
  await llm.generateText({ taskType: "draft", prompt: "..." });

Same call. Same result shape. Different provider underneath.
```

## Setup

Install both adapters:

```bash
pnpm add @llm-ports/core @llm-ports/adapter-ollama @llm-ports/adapter-anthropic ollama @anthropic-ai/sdk
```

Configure both in your registry. The registry doesn't care that one might not be reachable in a given environment; it only cares that env vars don't reference unregistered adapters:

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createOllamaAdapter } from "@llm-ports/adapter-ollama";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

export const registry = createRegistryFromEnv({
  adapters: {
    ollama: createOllamaAdapter({
      baseURL: process.env.OLLAMA_URL ?? "http://localhost:11434",
      autoPull: true,
    }),
    anthropic: createAnthropicAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY ?? "missing",
    }),
  },
});

export const llm = registry.getPort();
```

## Per-environment env vars

```bash
# .env.local (development)
LLM_PROVIDER_DRAFT=ollama|llama3.3|unlimited
LLM_PROVIDER_TRIAGE=ollama|llama3.3|unlimited
LLM_TASK_ROUTE_DRAFT=draft
LLM_TASK_ROUTE_TRIAGE=triage

# .env.production
LLM_PROVIDER_DRAFT=anthropic|claude-sonnet-4-6-20250514|cost:50/day
LLM_PROVIDER_TRIAGE=anthropic|claude-haiku-4-5|cost:5/day
LLM_TASK_ROUTE_DRAFT=draft
LLM_TASK_ROUTE_TRIAGE=triage
```

Application code (unchanged in both environments):

```ts
const triage = await llm.generateText({ taskType: "triage", prompt: emailBody });
const draft = await llm.generateText({ taskType: "draft", prompt: replyInstructions });
```

## Ollama-specific niceties

`@llm-ports/adapter-ollama` exposes adapter-level model management you can wire to admin UIs:

```ts
import { createOllamaAdapter } from "@llm-ports/adapter-ollama";

const ollama = createOllamaAdapter({ autoPull: true });

// Health check
const health = await ollama.checkHealth();
if (!health.ok) {
  console.error("Ollama daemon unreachable");
}

// Pull a model with progress
await ollama.pullModel("qwen2.5:32b", (pct) => console.log(`${pct}%`));

// List installed models
const models = await ollama.listModels();
console.log(models);  // [{ name: "llama3.3", size: 4_000_000_000, ... }]
```

The `autoPull: true` flag pulls the model on first use if not already present locally. Convenient in development, less convenient in production where you want explicit control over what's installed. Default is `false`.

## Hybrid setups

Nothing prevents using Ollama in production for a subset of tasks. Some teams use:

```bash
# Production: use Ollama for non-sensitive bulk classification, Anthropic for tone-sensitive drafts
LLM_PROVIDER_FAST=ollama|llama3.3|unlimited
LLM_PROVIDER_PREMIUM=anthropic|claude-sonnet-4-6-20250514|cost:50/day

LLM_TASK_ROUTE_BULK_CLASSIFY=fast       # local: free, fast, no PII leaves the network
LLM_TASK_ROUTE_DRAFT=premium            # cloud: better tone matching
LLM_TASK_ROUTE_TRIAGE=fast,premium      # local first, cloud fallback if local fails
```

This pattern works because Ollama models default to **zero-cost, unlimited budget**. The cost cap doesn't trip; the request budget doesn't either. They're not competing with cloud providers in the gating layer — they're free.

## When NOT to flip

Ollama is great for development, prototyping, and bulk non-tone-sensitive work. It's not always production-ready for:

- **Tone-sensitive drafts.** Most local models can't match Claude Opus or GPT-5 on writing nuance.
- **Long-context reasoning.** Local models cap at 32K-128K context with quantization tradeoffs.
- **Tool calling.** Model-dependent; Llama 3.3 and Qwen 2.5 work, smaller models often don't.
- **High concurrency.** A single Ollama daemon serves one request at a time per model. Cloud providers parallelize trivially.

The flip is a flow optimization (free dev iteration), not a "everything moves to local" play.

## Reading next

- [`@llm-ports/adapter-ollama` reference →](/adapters/ollama)
- [Multi-provider routing →](/guides/multi-provider) — fallback chain semantics
