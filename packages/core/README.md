# @llm-ports/core

The foundation of [llm-ports](https://github.com/baabakk/llm-ports). SDK-independent interfaces, multimodal content blocks, registry with cost-and-budget gating, validation strategies. Zero dependencies on any LLM SDK.

## Installation

```bash
pnpm add @llm-ports/core
# Plus at least one adapter:
pnpm add @llm-ports/adapter-anthropic
```

## What you get

| Export | Purpose |
|--------|---------|
| `LLMPort` | The interface adapters implement: `generateText`, `generateStructured`, `streamText`, `streamStructured`, `runAgent` |
| `EmbeddingsPort` | Sibling interface for embeddings (most chat adapters do not implement this) |
| `ContentBlock`, `MessageContent` | Multimodal message content (text, image, audio, tool_use, tool_result) |
| `createRegistryFromEnv()` | Builds a routing registry from `LLM_PROVIDER_*` and `LLM_TASK_ROUTE_*` env vars |
| `declareTasks<T>()` | Type-safe task name helper with autocomplete |
| `InMemoryBudget`, `InMemoryCost` | Default backends; replace with Redis-backed for multi-process |
| `ValidationStrategy` | Pluggable strategies for handling failed structured-output validation |
| `BudgetExceededError`, `NoProvidersAvailableError`, `ValidationError`, ... | Typed error classes |

## Minimal example

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

export const llm = registry.getPort();

// Then anywhere in your codebase:
const result = await llm.generateText({
  taskType: "triage",
  prompt: "Classify this email: ...",
});
```

`.env`:

```
LLM_PROVIDER_FAST=anthropic|claude-haiku-4-5|cost:5/day
LLM_PROVIDER_SMART=anthropic|claude-sonnet-4-6|cost:50/day
LLM_TASK_ROUTE_TRIAGE=fast,smart
```

## License

MIT
