# Migrating from Vercel AI SDK

If your codebase already imports `generateText`, `streamText`, `generateObject`, etc. from `"ai"` and the `@ai-sdk/*` provider packages, you have two migration paths:

1. **Keep your Vercel setup** and adopt `llm-ports` via [`@llm-ports/adapter-vercel`](/adapters/vercel). Lower-friction, but slower-evolving (some features lag the direct adapters).
2. **Switch to direct adapters** (`@llm-ports/adapter-anthropic`, `@llm-ports/adapter-openai`, ...). More work, but full feature parity and faster iteration.

This page walks both options.

## Path 1: Keep Vercel via `@llm-ports/adapter-vercel`

Lowest effort. You keep your existing `@ai-sdk/*` imports for model construction; `llm-ports` handles routing, cost gating, and fallback on top.

### Before

```ts
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

// Sprinkled across many files:
const result = await generateText({
  model: anthropic("claude-sonnet-4-6"),
  prompt: "...",
});
```

### After

```ts
// === ONE-TIME SETUP (somewhere central) ===
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createRegistryFromEnv } from "@llm-ports/core";
import { createVercelAdapter } from "@llm-ports/adapter-vercel";

const registry = createRegistryFromEnv({
  adapters: {
    vercel: createVercelAdapter({
      models: {
        "claude-sonnet-4-6": anthropic("claude-sonnet-4-6"),
        "gpt-5": openai("gpt-5"),
      },
      pricing: {
        "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
        "gpt-5": { inputPer1M: 2.5, outputPer1M: 10 },
      },
    }),
  },
});

export const llm = registry.getPort();
```

```bash
# .env
LLM_PROVIDER_FAST=vercel|claude-sonnet-4-6|cost:50/day
LLM_PROVIDER_GPT=vercel|gpt-5|cost:100/day
LLM_TASK_ROUTE_DRAFT=fast,gpt
```

```ts
// === EVERY CALL SITE ===
const result = await llm.generateText({
  taskType: "draft",       // chooses provider per env
  prompt: "...",
});
// result.text, result.cost.totalUSD, result.modelId, result.providerAlias, result.latencyMs
```

What changed:

- `import { generateText } from "ai"` → `import { llm } from "./your-llm-setup"` (or wherever you put the registry)
- `model: anthropic(...)` → `taskType: "draft"` (let the registry pick)
- Result shape: `{ text, usage }` → `{ text, usage, cost, modelId, providerAlias, latencyMs }` (more info, all backwards-compatible if you only access `.text`)

What you gain:

- Cost gating with USD caps
- Fallback chain when one provider is over quota or down
- Per-call latency / cost / model tracking

What stays the same:

- Your `@ai-sdk/*` package choices
- Vercel's models hold all the auth and config
- Vercel's tool definitions, schemas, etc. (until you migrate to capability factories)

## Path 2: Switch to direct adapters

More work, more upside. Replace `@ai-sdk/anthropic` with `@llm-ports/adapter-anthropic`, etc.

### Before

```ts
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const result = await generateText({
  model: anthropic("claude-sonnet-4-6"),
  prompt: "...",
});
```

### After

```ts
// === SETUP ===
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
```

```bash
# .env
LLM_PROVIDER_PREMIUM=anthropic|claude-sonnet-4-6-20250514|cost:50/day
LLM_TASK_ROUTE_DRAFT=premium
```

```ts
// === EVERY CALL SITE ===
const result = await llm.generateText({ taskType: "draft", prompt: "..." });
```

You can drop `@ai-sdk/anthropic` and the `ai` package once all call sites are migrated.

## Per-method translation

| Vercel AI SDK | llm-ports |
|---------------|-----------|
| `generateText({ model, prompt, system, temperature, maxTokens })` | `llm.generateText({ taskType, prompt, instructions, temperature, maxOutputTokens })` |
| `generateObject({ model, schema, ... })` | `llm.generateStructured({ taskType, schema, schemaName, ... })` |
| `streamText({ ... })` | `for await (const chunk of llm.streamText(...))` |
| `streamObject({ ... })` | `for await (const partial of llm.streamStructured(...))` |
| `tool({ description, inputSchema, execute })` | `ToolDefinition` with same shape (plus `destructive`, `requiresConfirmation`, `maxOutputBytes`) |
| Calling tools via `generateText({ tools, maxSteps })` | `llm.runAgent({ tools, maxSteps, instructions, messages })` |
| `embed({ model, value })` | `embedPort.generateEmbedding({ taskType, input })` |
| `embedMany({ model, values })` | `embedPort.generateEmbeddings({ taskType, inputs })` |

Argument renames you'll hit:

- `prompt` (just user) and `system` (just system) → `prompt` (user) and `instructions` (system)
- `maxTokens` → `maxOutputTokens`
- `messages: [{ role, content }]` → same shape, but content uses our `MessageContent` type
- `usage.promptTokens` → `usage.inputTokens`; `usage.completionTokens` → `usage.outputTokens`
- `result.response.modelId` → `result.modelId` (already at top level)

## Streaming differences

Vercel exposes `result.textStream` (an `AsyncIterable<string>`); we return the iterable directly:

```ts
// Vercel
const stream = streamText({ model, prompt });
for await (const chunk of stream.textStream) { ... }

// llm-ports
for await (const chunk of llm.streamText({ taskType, prompt })) { ... }
```

For streaming structured output, Vercel's `streamObject` returns deeply-nested partials. Our `streamStructured` does best-effort partial JSON parsing (yields `Partial<T>` as the buffer fills). The semantics are similar but the implementation differs by adapter.

## Capability factories (replace prompt-template duplication)

If you have classification or drafting prompts that you've written by hand at multiple call sites, this is where `@llm-ports/capabilities` shines. Migrate one capability at a time:

```ts
// BEFORE (per call site)
const triageResult = await llm.generateStructured({
  taskType: "triage",
  prompt: `Classify this email...
    P0: ...
    P1: ...
    Reply with JSON: { priority, needsReply, reasoning }`,
  schema: TriageSchema,
});

// AFTER (capability factory, configure once)
import { createClassifier } from "@llm-ports/capabilities";

export const classifyEmail = createClassifier({
  port: llm,
  schema: TriageSchema,
  schemaName: "email-triage",
  rubric: TRIAGE_RUBRIC,
  boundaryExamples: TRIAGE_EXAMPLES,
});

// Per call site:
const triage = await classifyEmail({ content: emailBody });
```

[More on capabilities →](/capabilities/)

## Reading next

- [Migrating from a direct SDK →](/migration/from-direct-sdk)
- [`@llm-ports/adapter-vercel` reference →](/adapters/vercel)
