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

## Tool use

A tool is a named function with a Zod input schema. The model decides when to call it, the library runs it, feeds the result back, and loops until the model answers in words.

```typescript
import { z } from "zod";
import type { ToolDefinition } from "@llm-ports/core";

const getOrderStatus: ToolDefinition = {
  name: "get_order_status",
  description: "Look up the current status of a customer order by its id.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => db.orders.findById(orderId),
};

const result = await llm.runAgent({
  taskType: "support",
  instructions: "You are a support agent. Use the tools when a fact is needed.",
  messages: [{ role: "user", content: "Where is ORD-10293?" }],
  tools: { get_order_status: getOrderStatus },
  maxSteps: 10,
});

result.text;              // the final answer
result.toolCalls;         // [{ name, input, output }], in call order
result.terminationReason; // "completed" | "max_steps" | "stopped_by_user"
```

**Check `terminationReason` before trusting `text`.** `"max_steps"` means the model was still working when the budget ran out.

Your schema is converted to each provider's own tool-schema format by the adapter serving that attempt, so a fallback chain of providers that disagree needs one schema from you.

Full reference: [Tool use](https://baabakk.github.io/llm-ports/guides/tool-use). For gating which tools may run without a human approving: [Tool-Use Security](https://baabakk.github.io/llm-ports/guides/security).

## License

MIT
