---
layout: home

hero:
  name: llm-ports
  text: Provider-agnostic LLM architecture for TypeScript
  tagline: |
    The library that assumes you're running LLMs in production at cost,
    not in a demo. Cost gating, fallback chains, capability factories,
    tool-use security primitives.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/baabakk/llm-ports

features:
  - icon: 🔌
    title: Two-file rule
    details: Only the adapter and the registry import from any LLM SDK. Your business code stays SDK-agnostic forever.
  - icon: 💵
    title: USD-denominated cost gating
    details: Set per-hour, per-day, per-month dollar caps per provider. Fallback chains pick the next provider when the cap trips.
  - icon: 🧱
    title: 17 capability factories
    details: classify, score, draft, summarize, extract, plan, analyze (v0.1) — configure once, call many times. 10 more in v0.2.
  - icon: 🌐
    title: 4 adapters, 14+ providers
    details: Anthropic, OpenAI (+10 compatible providers via baseURL), Ollama (local + model management), Vercel AI SDK migration helper.
  - icon: 🛡️
    title: Tool-use security primitives
    details: Mark tools destructive, requireConfirmation, set output size limits. Safety isn't an afterthought.
  - icon: ⚡
    title: Negligible overhead
    details: Mean p50 0.04 ms, max p99 0.47 ms framework overhead. 10x under the 5 ms target.
---

## 60 seconds

**1. Configure providers in `.env`:**

```bash
LLM_PROVIDER_FAST=anthropic|claude-haiku-4-5|cost:5/day
LLM_PROVIDER_SMART=anthropic|claude-sonnet-4-6-20250514|cost:50/day
LLM_TASK_ROUTE_TRIAGE=fast,smart
```

**2. Create the port once at app start:**

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

export const llm = createRegistryFromEnv({
  adapters: {
    anthropic: createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  },
}).getPort();
```

**3. Use anywhere in your codebase, no SDK imports:**

```ts
const result = await llm.generateText({
  taskType: "triage",
  prompt: "Classify this email: ...",
});
```

The registry picks the model per task, enforces the cost cap, walks to the next provider when a budget is exhausted, and reports per-call latency and USD cost. (In v0.1, fallback walks the chain on **budget gating** today — runtime-error fallback ships in v0.2; see the [multi-provider guide](/guides/multi-provider).)

## How it relates to other tools

| Tool | How `llm-ports` relates |
|------|-------------------------|
| [Vercel AI SDK](https://sdk.vercel.ai/) | Vercel unifies provider calls. `llm-ports` adds registry, fallback chains, USD cost gating, validation recovery, and capability factories on top. Use `@llm-ports/adapter-vercel` to keep your existing setup. |
| [LiteLLM](https://github.com/BerriAI/litellm) | Python-first HTTP proxy. `llm-ports` is TypeScript in-process — zero network hop, no extra service to deploy. Talks to LiteLLM via the OpenAI adapter with `baseURL`. |
| [Portkey](https://portkey.ai/) | Commercial hosted gateway. `llm-ports` is MIT, in-process, no vendor lock-in. The tradeoff: Portkey ships a hosted UI; `llm-ports` does not. |
| [LangChain.js](https://js.langchain.com/) | LangChain is a framework. `llm-ports` is a utility. Wrap LangChain LLM calls with a port for budget gating without adopting the whole framework. |
| [LlamaIndex.TS](https://ts.llamaindex.ai/) | LlamaIndex is retrieval-first. `llm-ports` handles LLM invocation; bring your own retrieval. They compose cleanly. |
| [Mastra](https://mastra.ai/) | Mastra is opinionated agent-first with built-in memory. `llm-ports` is unopinionated primitives beneath that layer. |

[Read the full positioning →](/why)
