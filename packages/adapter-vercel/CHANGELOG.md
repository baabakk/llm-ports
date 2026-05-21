# @llm-ports/adapter-vercel

## 0.1.0-alpha.3

### Patch Changes

- fbbd507: Non-functional refactor: consumes shared utilities from `@llm-ports/core` instead of local duplicates.
  - `wrapError` → `wrapProviderError` (from core)
  - `stringifyPrompt` → `stringifyContentBlocks` (from core)
  - `extractJSON` and `tryParsePartialJSON` (from core)
  - Local `emitRetry` is now a thin wrapper around `emitRetryEvent` (from core)

  Public API unchanged. All 19 adapter-vercel tests pass identically.

- Updated dependencies [fbbd507]
  - @llm-ports/core@0.1.0-alpha.3

## 0.1.0-alpha.1

### Minor Changes

- Handle reasoning-model starvation and empty responses in the Vercel adapter.

  Reasoning models (Cerebras `gpt-oss-*`, OpenAI o-series, `gpt-5-nano`) often spend their entire output-token budget on hidden reasoning and return an empty visible text when called with a small `maxOutputTokens`. The adapter now detects this (empty text + `finishReason === "length"` + tokens consumed + a caller-supplied budget) and retries once with a 4× budget, mirroring `@llm-ports/adapter-openai`. The retry fires the new `onRetry` hook with `reason: "reasoning-starvation"`. Closes #4.

  `generateStructured` previously crashed on the same empty response: `JSON.parse("")` raised `SyntaxError`, which got wrapped as a generic `ProviderUnavailableError` and prevented the registry from making an intelligent fallback decision. The adapter now throws a typed `EmptyResponseError` (from `@llm-ports/core`) carrying `alias` + `modelId` so the registry can route to the next provider in the chain. Closes #5.

  Also wires `onRetry` for `validation-feedback` retries in `generateStructured` and adds a new `onRetry?: OnRetry` option to `VercelAdapterOptions`.

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- Initial alpha release.

  `llm-ports` is a TypeScript library implementing hexagonal-style ports & adapters for LLMs in production: multi-provider routing, USD-denominated cost gating, fallback chains, validation-failure recovery, and 7 capability factories (classify, score, draft, summarize, extract, plan, analyze).

  This alpha ships:
  - `@llm-ports/core` — `LLMPort` + `EmbeddingsPort` interfaces, `Registry` with task routing and fallback chains, USD cost computation with cache-discount support, in-memory budget + cost backends, `ContentBlock` discriminated union (text, image, audio, tool_use, tool_result), pluggable validation strategies, error class hierarchy.
  - `@llm-ports/capabilities` — 7 cognitive operation factories (`createClassifier`, `createScorer`, `createDrafter`, `createSummarizer`, `createExtractor`, `createPlanner`, `createAnalyzer`) with `onResult` / `onError` / `onBeforeCall` hooks, async resolver support for rubrics and personas.
  - `@llm-ports/adapter-anthropic` — direct `@anthropic-ai/sdk` adapter, prompt caching, vision, tool use.
  - `@llm-ports/adapter-openai` — OpenAI SDK adapter; `baseURL` covers 10+ OpenAI-compat providers (Azure, Groq, Together, Fireworks, DeepInfra, Perplexity, Cerebras, LiteLLM proxy). Runtime capability discovery (temperature locked, JSON mode, system message). Reasoning-model auto-recovery (OpenAI o-series + Cerebras gpt-oss). Transient-401 burst-protection retry for `sk-proj-*` keys.
  - `@llm-ports/adapter-ollama` — native Ollama adapter, model management (list/pull/delete/health), local-LLM workflows.
  - `@llm-ports/adapter-vercel` — bring-your-own-Vercel-models migration adapter; lets users on `@ai-sdk/*` adopt `llm-ports` plumbing without rewriting their SDK setup.

  Peer dependency: `zod >=3.24.0 <5`. Bring your own SDKs (`@anthropic-ai/sdk`, `openai`, `ollama`, `ai`).

  Pre-launch test plan summary: 211 offline tests pass, 22 of 26 live API tests pass (with 4 documented model-flakiness items), latency p99 0.85ms vs 5ms target, 0 doc-rot signals across 111 doc snippets, fresh tarball install verified.

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.0
