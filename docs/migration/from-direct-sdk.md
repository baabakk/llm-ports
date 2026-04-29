# Migrating from a direct SDK

If your codebase imports `@anthropic-ai/sdk`, `openai`, `ollama`, or similar provider packages directly, the migration is straightforward: those become adapter dependencies, and your business logic moves to `LLMPort`.

## The pattern

| Layer | Before | After |
|-------|--------|-------|
| Auth + client | `new Anthropic({ apiKey })` scattered or in a singleton | Inside `createAnthropicAdapter({ apiKey })`, called once |
| API call | `client.messages.create({ ... })` | `llm.generateText({ taskType, prompt })` |
| Result extraction | `response.content[0].text` | `result.text` |
| Token / cost tracking | Hand-rolled | `result.usage`, `result.cost.totalUSD` |
| Provider switching | Code change | `.env` change |
| Cost cap enforcement | Hand-rolled | Built-in via env (`cost:50/day`) |

## Anthropic example (most common case)

### Before

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Sprinkled across many files:
async function classifyEmail(emailBody: string) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: "You classify emails by urgency.",
    messages: [{ role: "user", content: emailBody }],
  });
  return (response.content[0] as { type: "text"; text: string }).text;
}
```

### After (port + adapter)

```ts
// === SETUP (once) ===
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
LLM_PROVIDER_FAST=anthropic|claude-haiku-4-5|cost:5/day
LLM_TASK_ROUTE_TRIAGE=fast
```

```ts
// === USE SITE ===
async function classifyEmail(emailBody: string) {
  const result = await llm.generateText({
    taskType: "triage",
    instructions: "You classify emails by urgency.",
    prompt: emailBody,
  });
  return result.text;   // also: result.cost.totalUSD, result.modelId, result.latencyMs
}
```

You can now also delete `@anthropic-ai/sdk` from your app's direct deps; it's a transitive dep of `@llm-ports/adapter-anthropic`.

## Per-call payoff

Every call now returns:

```ts
const result = await llm.generateText({ taskType: "triage", prompt });

result.text;                    // model output
result.usage.inputTokens;       // input tokens
result.usage.outputTokens;      // output tokens
result.usage.totalTokens;       // sum
result.usage.cacheReadTokens;   // present when prompt cache used (Anthropic)
result.cost.totalUSD;           // exact USD for this call
result.cost.cacheDiscountUSD;   // savings from cache
result.modelId;                 // which model was actually used
result.providerAlias;           // which env alias was selected
result.latencyMs;               // measured end-to-end latency
```

This is a strict superset of what direct SDK calls give you. Code that only reads `result.text` is unaffected; new analytics code can pull cost / latency / provider trivially.

## Per-method translation

| Direct Anthropic SDK | llm-ports |
|----------------------|-----------|
| `client.messages.create({ model, system, messages, max_tokens, temperature })` | `llm.generateText({ taskType, instructions, prompt, maxOutputTokens, temperature })` (or `generateStructured` with a schema) |
| `client.messages.stream({ ... })` | `for await (const chunk of llm.streamText(...))` |
| `client.messages.create({ ..., tools })` (multi-turn loop) | `llm.runAgent({ taskType, instructions, messages, tools, maxSteps })` |
| Manual `text` extraction from `response.content[0]` | `result.text` (already extracted) |
| Manual JSON parse + Zod safeParse + retry | `llm.generateStructured({ schema })` (built-in retry-with-feedback) |

| Direct OpenAI SDK | llm-ports |
|-------------------|-----------|
| `client.chat.completions.create({ model, messages, temperature })` | `llm.generateText({ taskType, prompt, instructions, temperature })` |
| `client.chat.completions.create({ ..., response_format: { type: "json_object" } })` | `llm.generateStructured({ schema, schemaName, ... })` |
| `client.chat.completions.create({ ..., stream: true })` | `for await (const chunk of llm.streamText(...))` |
| `client.embeddings.create({ model, input })` | `embedPort.generateEmbedding({ taskType, input })` |

## Multimodal content

Both direct SDKs use provider-specific content shapes. `llm-ports` uses our [`ContentBlock` discriminated union](/concepts/content-blocks):

```ts
// Before (Anthropic)
{ role: "user", content: [
  { type: "text", text: "describe" },
  { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
]}

// After (llm-ports — adapter normalizes both directions)
{ role: "user", content: [
  { type: "text", text: "describe" },
  { type: "image", source: { kind: "base64", mediaType: "image/png", data: "..." } }
]}
```

The differences are:

- `kind` instead of `type` for the source discriminator
- `mediaType` (camelCase) instead of `media_type`

These are mechanical renames. The `image.source.url` form for URL images is identical.

## Tool calling

Direct SDK tool-calling differs significantly between providers. `llm-ports` flattens this:

```ts
import type { ToolDefinition } from "@llm-ports/core";
import { z } from "zod";

const searchEmails: ToolDefinition = {
  name: "searchEmails",
  description: "Search the inbox by query",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => { /* ... */ },
};

// Multi-turn agent loop, provider-agnostic:
const result = await llm.runAgent({
  taskType: "agent",
  instructions: "...",
  messages: [{ role: "user", content: "Find invoices from Acme" }],
  tools: { searchEmails },
  maxSteps: 5,
});
```

The adapter handles the per-provider translation: Anthropic's `tool_use` blocks, OpenAI's `tool_calls`, Ollama's tool format. You write the `ToolDefinition` once.

[Tool-use security primitives →](/guides/security)

## Reading next

- [Capability factories →](/capabilities/) — the next migration step after the port
- [Cost gating →](/guides/cost-gating) — the immediate payoff
