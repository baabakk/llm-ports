# llm-ports

Provider-agnostic LLM architecture for TypeScript. Multi-provider routing, USD-denominated cost gating, fallback chains, reusable capability factories, tool-use security primitives. Under 3000 lines total.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why

Most TypeScript LLM code imports provider SDKs directly, scattering `generateText()` calls across dozens of files. Every SDK upgrade breaks multiple files. Every provider switch is a refactor.

`llm-ports` fixes this with a clean ports-and-adapters pattern: only two files in your project import the LLM SDK. Everything else talks to a typed interface that supports multi-provider routing, USD cost gating, fallback chains, and reusable capability factories.

This is the library that assumes you're running LLMs in production at cost, not in a demo.

## 60 seconds

**1. Configure providers in `.env`:**

```
LLM_PROVIDER_FAST=anthropic|<your-model-id>|cost:50/day
LLM_PROVIDER_SMART=anthropic|<your-model-id>|cost:200/day
LLM_TASK_ROUTE_TRIAGE=fast,smart
```

**2. Create the port once at app start:**

```typescript
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

export const llm = createRegistryFromEnv({
  adapters: {
    anthropic: createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  },
}).getPort();
```

**3. Use anywhere, no SDK imports:**

```typescript
const result = await llm.generateText({
  taskType: "triage",
  prompt: "Classify this email: ...",
});
```

The registry picks the model per task, enforces cost limits, falls back through the provider chain on failure, and measures latency and cost for observability.

## Packages

| Package | Purpose |
|---------|---------|
| `@llm-ports/core` | Port interfaces, registry, cost/budget gating, validation strategies, content blocks |
| `@llm-ports/adapter-anthropic` | Direct Anthropic SDK adapter with prompt caching |
| `@llm-ports/adapter-openai` | OpenAI SDK adapter with `baseURL` support (covers 10+ compat providers) |
| `@llm-ports/adapter-vercel` | Vercel AI SDK adapter (migration path from existing Vercel users) |
| `@llm-ports/adapter-ollama` | Ollama native adapter with model management |
| `@llm-ports/capabilities` | 7 cognitive operation factories: classify, score, draft, summarize, extract, plan, analyze |
| `@llm-ports/observability` | Quality tracking hooks, sinks, deterministic edit-diff helpers |

## Capabilities example

Capability factories let you bind a schema, rubric, and hooks once, then call the configured function many times:

```typescript
import { createClassifier } from "@llm-ports/capabilities";
import { z } from "zod";

const IntentSchema = z.object({
  intent: z.enum(["question", "request", "complaint", "feedback", "other"]),
  urgency: z.enum(["low", "normal", "high"]),
  reasoning: z.string(),
});

export const classifyIntent = createClassifier({
  port: llm,
  schema: IntentSchema,
  schemaName: "user-intent",
  rubric: `
    question: asking for information
    request: wants something done
    complaint: reports a problem
    feedback: opinion, no action requested
  `,
});

const result = await classifyIntent({ content: userMessage });
// { intent: "request", urgency: "high", reasoning: "..." }
```

## Related tools

| Tool | How `llm-ports` relates |
|------|-------------------------|
| Vercel AI SDK | Vercel unifies provider calls. `llm-ports` adds registry, fallback chains, USD cost gating, validation recovery, capability factories on top. |
| LiteLLM | Python-first HTTP proxy. `llm-ports` is TypeScript in-process, zero network hop. Talks to LiteLLM via the OpenAI adapter with `baseURL`. |
| Portkey | Commercial hosted gateway. `llm-ports` is MIT, in-process, no vendor dependency. |
| LangChain.js | LangChain is a framework. `llm-ports` is a utility. Wrap LangChain's LLM calls with a port for budget gating and fallbacks. |
| LlamaIndex.TS | LlamaIndex is retrieval-first. `llm-ports` handles LLM invocation; bring your own retrieval. |
| Mastra | Mastra is agent-first with built-in memory. `llm-ports` is primitives beneath that layer. |

## Documentation

Full docs: [llm-ports.dev](https://llm-ports.dev) (coming v0.1).

- Getting Started
- Concepts: ports, adapters, task routing, cost vs request gating, content blocks, validation strategies
- Guides: multi-provider, local-to-cloud, cost gating, custom adapters, observability, security
- Capabilities (one page each)
- Adapters (one page each + feature matrix)
- Migration: from Vercel AI, from LangChain, from direct SDKs

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

See [SECURITY.md](./SECURITY.md) for the threat model and vulnerability reporting.

## License

MIT. See [LICENSE](./LICENSE).

---

**Status:** Pre-release. Scaffolding in progress; v0.1 target date: Week 14.
