# Ports and Adapters

`llm-ports` applies the [hexagonal architecture](https://en.wikipedia.org/wiki/Hexagonal_architecture) (also called "ports and adapters") to LLM provider integration. The pattern isn't new; the application to LLMs is.

## The two ports

```ts
import type { LLMPort, EmbeddingsPort } from "@llm-ports/core";
```

| Port | What it does | What implements it |
|------|--------------|--------------------|
| `LLMPort` | 5 methods: `generateText`, `generateStructured`, `streamText`, `streamStructured`, `runAgent` | All chat adapters (anthropic, openai, ollama, vercel) |
| `EmbeddingsPort` | 2 methods: `generateEmbedding`, `generateEmbeddings` (batch) | Adapters whose providers ship embedding models (openai, ollama, vercel) |

The two ports are siblings, not a hierarchy. An adapter can implement either, both, or neither — though "neither" is unusual.

**Why split them?** Most chat-only adapters (Anthropic, today) don't ship embeddings. Some embedding-only providers (voyage-ai, certain Cohere endpoints) don't ship chat. Forcing one port to cover both would produce stub implementations that throw "not supported" errors. The split keeps each port's surface meaningful.

## Adapters

Adapters translate between the port interface and a specific provider SDK. Examples:

- `@llm-ports/adapter-anthropic` translates `LLMPort.generateText(...)` to `Anthropic.messages.create(...)`
- `@llm-ports/adapter-openai` translates the same call to `openai.chat.completions.create(...)`
- `@llm-ports/adapter-ollama` translates it to `ollama.chat(...)`

Adapters also handle:

- Type translation between llm-ports `ContentBlock[]` and the provider's content shape
- Cost computation from token usage + pricing table
- Error wrapping (`ProviderUnavailableError`)
- Validation retry strategy when structured output fails the schema

## The registry

Sits between adapters and the user's application code. Responsibilities:

- Parse `LLM_PROVIDER_*` and `LLM_TASK_ROUTE_*` env vars into a routing table
- Walk task fallback chains; pick the first available provider per call
- Enforce budget (request count) and cost (USD) gating
- Build the per-call port instance the application sees

The application never sees adapters directly. It sees an `LLMPort` returned by `registry.getPort()`. That port internally routes to whichever adapter the registry selects per call.

```
┌──────────────────────────────────────────┐
│ Application code                         │
│   await llm.generateText({ taskType })   │
└──────────────────┬───────────────────────┘
                   │ LLMPort interface
                   ▼
┌──────────────────────────────────────────┐
│ Registry                                 │
│   - parses env config                    │
│   - walks fallback chain                 │
│   - gates on budget + cost               │
│   - selects an adapter per call          │
└──────────────────┬───────────────────────┘
                   │ AdapterRegistration
                   ▼
┌──────────────────────────────────────────┐
│ Adapter                                  │
│   - translates to provider SDK           │
│   - computes cost from tokens            │
│   - wraps errors                         │
└──────────────────┬───────────────────────┘
                   │ Provider SDK
                   ▼
┌──────────────────────────────────────────┐
│ Anthropic / OpenAI / Ollama / ...        │
└──────────────────────────────────────────┘
```

## The capability layer (optional)

Above the port, `@llm-ports/capabilities` provides factory functions that wrap common cognitive operations (classify, score, draft, ...). The factories take prompt fragments + schema at definition time and return typed functions you call per-input.

The capabilities depend on `LLMPort` only. They don't import any adapter, don't know about provider names, and don't care which model runs. They're pure consumers of the port.

## Why this pattern matters

| Without ports/adapters | With `llm-ports` |
|------------------------|------------------|
| `import { generateText } from "ai"` scattered across N files | Imports from `@llm-ports/core` and capabilities; SDK invisible |
| Every SDK upgrade touches every call site | Two files (adapter + registry) absorb the upgrade |
| Provider switch = refactor | Provider switch = one env var |
| Cost tracking is hand-rolled per call | Cost tracking is in the result object |
| Capability prompts duplicate per call | Capability factory binds it once |

The pattern's job is to keep the SDK out of business logic. Once you draw that line, everything downstream (cost gating, fallback chains, capability factories, observability hooks) becomes possible to centralize.

## Reading next

- [Task routing concept →](/concepts/task-routing) — how the registry picks providers
- [Content blocks →](/concepts/content-blocks) — multimodal content
