# llm-ports: TypeScript LLM Abstraction Layer for Multi-Provider AI Systems

Provider-agnostic LLM architecture for TypeScript.

Switch providers without changing code.  
Avoid vendor lock-in.  
Control cost.  
Reuse prompts as capabilities.

Multi-provider routing • fallback chains • USD cost gating • capability factories • tool-use security • observability

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Status](https://img.shields.io/badge/status-pre--release-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-first-blue)

---

## The Problem

Most LLM applications break in predictable ways:

- SDK upgrades touch too many files
- Switching providers requires refactoring
- Prompt logic is duplicated across features
- Cost and routing logic are scattered
- Business logic becomes coupled to provider-specific SDKs

This is not just an SDK problem.

**It is an architecture problem.**

---

## The Solution

`llm-ports` applies the ports-and-adapters pattern to LLM systems.

> **Only two files in your codebase should know the LLM SDK exists.**

Everything else talks to a typed interface.

Instead of calling models directly, your application uses reusable capabilities:

- classify
- draft
- score
- summarize
- extract
- plan
- analyze

The LLM stops being a dependency you manage.  
It becomes infrastructure you configure.

---

## What You Get

- **Multi-provider LLM routing** across OpenAI, Anthropic, Ollama, Vercel AI SDK, and compatible providers
- **Fallback chains** when a provider fails or exceeds budget
- **USD-based cost gating** with hourly, daily, and monthly limits
- **Reusable prompt capabilities** so prompts are defined once and reused everywhere
- **Validation recovery** for structured output failures
- **Tool-use safety primitives** for destructive or confirmation-required actions
- **Observability hooks** for cost, latency, quality, and outcomes
- **TypeScript-first API** with full type support
- **No runtime dependency on LangChain, LlamaIndex, or heavy frameworks**

---

## 60 Second Setup

### 1. Configure providers in `.env`

```env
LLM_PROVIDER_FAST=anthropic|<model>|cost:50/day
LLM_PROVIDER_SMART=anthropic|<model>|cost:200/day
LLM_TASK_ROUTE_TRIAGE=fast,smart
```

### 2. Create the port once

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

export const llm = createRegistryFromEnv({
  adapters: {
    anthropic: createAnthropicAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    }),
  },
}).getPort();
```

### 3. Use it anywhere, with no SDK imports

```ts
const result = await llm.generateText({
  taskType: "triage",
  prompt: "Classify this email...",
});
```

The registry:

- selects the right model for the task
- enforces cost limits
- falls back through the provider chain on failure
- records usage, cost, and latency

---

## Capabilities: Reusable LLM Operations

Instead of duplicating prompt logic across files, define a capability once and reuse it.

```ts
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
    feedback: opinion only
    other: anything else
  `,
});
```

Now call it anywhere:

```ts
const result = await classifyIntent({ content: userMessage });
```

Example output:

```ts
{
  intent: "request",
  urgency: "high",
  reasoning: "The user is asking for a concrete action."
}
```

Why this matters:

- Improve a prompt once, and every call site benefits
- Keep behavior consistent across the system
- Make debugging and evaluation easier
- Keep business logic free from provider-specific SDK details

---

## Architecture Overview

Before:

```text
Application code
  ├─ direct SDK call
  ├─ direct SDK call
  ├─ direct SDK call
  └─ model router leaking SDK types
```

After:

```text
Application code
  ↓
Capabilities
  ↓
LLM Port
  ↓
Adapters and Provider Registry
  ↓
LLM providers
```

The key shift:

> Application code stops calling models directly. It calls capabilities.

---

## Packages

| Package | Purpose |
|--------|---------|
| `@llm-ports/core` | Port interfaces, registry, routing, cost gating, validation strategies, content blocks |
| `@llm-ports/capabilities` | Reusable LLM operation factories |
| `@llm-ports/adapter-openai` | OpenAI SDK adapter with `baseURL` support for compatible providers |
| `@llm-ports/adapter-anthropic` | Anthropic SDK adapter |
| `@llm-ports/adapter-ollama` | Ollama native adapter with model management |
| `@llm-ports/adapter-vercel` | Vercel AI SDK adapter for migration and compatibility |

> `@llm-ports/observability` (quality tracking hooks, sinks, deterministic edit-diff helpers) is planned for v0.2.

---

## Examples

Seven runnable examples in [`examples/`](examples/), each its own pnpm workspace package with a README walking through the code:

| Example | What it shows |
|---|---|
| [`basic`](examples/basic/) | The smallest possible end-to-end. One adapter, one task type, one `generateText` call. The 60-second-setup demo. |
| [`multi-provider`](examples/multi-provider/) | Fallback chain (Anthropic primary → OpenAI backup), USD cost gating per provider, capability factory. |
| [`email-triage`](examples/email-triage/) | The most common production use case, condensed into ~150 lines. Inbound email → classify (intent + urgency + sentiment) → policy gate → draft brand-voiced reply → queue for human review. Capability composition story. |
| [`streaming-chat`](examples/streaming-chat/) | Express server with three routes: `POST /chat` (one-shot), `POST /chat/stream` (Server-Sent Events), `POST /chat/agent` (tool-augmented). The most common LLM UX patterns in ~30 lines of glue. |
| [`extract-from-pdf`](examples/extract-from-pdf/) | Document extraction: raw OCR'd invoice text → fully-typed structured object via Zod. Demonstrates `generateStructured`, validation-retry-with-feedback, and the `createExtractor` factory. |
| [`agent-with-approval`](examples/agent-with-approval/) | Tool-use agent with first-class security primitives. `destructive`, `requiresConfirmation`, `maxOutputBytes` flags + an approval-gate wrapper. The differentiation example. |
| [`migrate-from-vercel-ai`](examples/migrate-from-vercel-ai/) | Two migration paths for users on Vercel AI SDK: (a) wrap your existing model factories with `@llm-ports/adapter-vercel`, (b) replace `@ai-sdk/*` with native llm-ports adapters. Side-by-side before/after diffs. |

Each example is runnable from the monorepo root:

```bash
pnpm --filter @llm-ports/example-<name> start
```

Set the relevant API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) before running. Each example's README documents which keys it needs.

---

## Supported Use Cases

Use `llm-ports` when you need:

- multi-provider LLM routing
- LLM fallback chains
- TypeScript LLM abstraction
- OpenAI and Anthropic provider switching
- cost control for production LLM applications
- reusable prompt capabilities
- structured output validation and recovery
- tool-use security in agent workflows
- observability for LLM cost, latency, and quality
- vendor-neutral AI architecture

---

## When to Use This

Use `llm-ports` if:

- you use 2 or more LLM providers
- you may switch providers later
- SDK upgrades have caused multi-file changes
- prompt logic is duplicated
- cost control matters
- you want business logic decoupled from provider SDKs

Skip it if:

- you have 1 or 2 LLM calls
- you are only prototyping
- you are intentionally building around one provider-specific feature
- you want a full agent framework, memory layer, RAG framework, or hosted gateway

---

## Related Tools

| Tool | How `llm-ports` relates |
|------|--------------------------|
| Vercel AI SDK | Vercel unifies provider calls. `llm-ports` adds registry, fallback chains, USD cost gating, validation recovery, and capability factories on top. |
| LiteLLM | LiteLLM is a Python-first HTTP proxy. `llm-ports` is TypeScript and runs in-process with no extra network hop. |
| Portkey | Portkey is a commercial hosted gateway. `llm-ports` is MIT, in-process, and has no hosted dependency. |
| LangChain.js | LangChain is a framework. `llm-ports` is a lightweight architecture and control layer. |
| LlamaIndex.TS | LlamaIndex is retrieval-first. `llm-ports` handles LLM invocation, routing, fallback, and cost control. |
| Mastra | Mastra is agent-first with built-in memory and workflow primitives. `llm-ports` provides lower-level LLM primitives beneath that layer. |

---

## Known Limitations in Alpha

`llm-ports` is pre-release. The core architecture is stable and the offline regression suite is comprehensive (200+ tests, latency p99 under 1 ms, no doc-rot detected across 110+ snippets). Some adapter and agent paths are still being hardened.

Known limitations:

- Tool schemas in `runAgent` are still being tightened. The Zod-to-JSON-Schema conversion is currently a stub for the OpenAI and Anthropic adapters, so models receive less structural type information for tool inputs than the Zod schema describes. The looser tool-call shape works, but model accuracy on parameter names depends more on the tool description string than on the schema.
- The Vercel adapter does not yet apply the reasoning-model headroom multiplier that `adapter-openai` does. Reasoning models (OpenAI o-series, Cerebras gpt-oss, etc.) used through the Vercel adapter may require manually setting `maxOutputTokens` 5-10x higher than expected.
- The Vercel adapter's `generateStructured` path currently throws `SyntaxError: Unexpected end of JSON input` on the rare empty-response edge case, instead of a clearer typed error. Same root cause as the bullet above.
- No `onRetry` observability hook yet. The OpenAI adapter retries internally on capability-rejection, transient-401 burst protection, and reasoning-starved responses; consumers can't currently observe these. Quality-tracking still works through `onResult` on capability factories.
- Some provider-specific edge cases (Cerebras compat baseURL, Groq, Together AI, Fireworks) may require a `pricingOverrides` entry to match the registry's pricing-validation step. Bundled pricing tables cover OpenAI, Anthropic, and Ollama by default.

These are tracked openly in [GitHub issues](https://github.com/baabakk/llm-ports/issues). Please open an issue if you hit an adapter-specific failure.

---

## Installation

Pre-release. Packages are not yet on the npm `latest` tag.

When v0.1 is released:

```bash
npm install @llm-ports/core
```

Install adapters as needed:

```bash
npm install @llm-ports/adapter-anthropic
npm install @llm-ports/adapter-openai
npm install @llm-ports/adapter-ollama
npm install @llm-ports/capabilities
```

Peer dependency: `zod >=3.24.0 <5`. Bring your own SDKs (`@anthropic-ai/sdk`, `openai`, `ollama`, `ai`).

---

## Documentation

Documentation site (auto-deployed from `docs/` on every push to `main`):

https://baabakk.github.io/llm-ports/

Pages:

- Getting Started
- Concepts: ports, adapters, task routing, cost gating, content blocks, validation strategies
- Guides: multi-provider routing, local-to-cloud, cost control, custom adapters, observability, security
- Capabilities: one page per capability
- Adapters: one page per adapter and feature matrix
- Migration: from Vercel AI SDK, LangChain.js, and direct provider SDKs

---

## Security

Tool use without a threat model is dangerous.

`llm-ports` treats security as a first-class part of the API:

- destructive tool markers
- confirmation-required actions
- max output byte limits
- redaction capability
- explicit guidance for prompt injection and tool abuse

See [SECURITY.md](./SECURITY.md).

---

## Contributing

Contributions are welcome after the initial v0.1 scaffolding lands.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Status

Pre-release.

Current target:

- v0.1: core, adapters, cost gating, 7 capability factories
- v0.2: expanded capabilities and observability package
- v0.3: additional adapters and markdown skill format evaluation

---

## Follow Releases

`llm-ports` is pre-release. To get notified when v0.1 lands on the `latest` tag (and for every minor release after):

1. Click the **Watch** button at the top of the [GitHub repo](https://github.com/baabakk/llm-ports)
2. Choose **Custom**
3. Enable **Releases**

You'll get an email or notification only when a real version ships. No PR or commit noise.

