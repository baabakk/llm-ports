# @llm-ports/core

## 0.1.0-alpha.3

### Minor Changes

- fbbd507: New shared utilities for adapter authors. Replaces helpers that were duplicated 3-4x across adapter packages with single canonical versions:
  - `emitRetryEvent(onRetry, event)` — fire-and-forget invocation of the observability hook. Swallows hook errors, never blocks retries.
  - `createCapabilityLearner()` — factory for per-model capability discovery. Returns `{ get, remember, _reset, seedFromCatalog, hasLearned }`. Adapters provide their own provider-specific error classifiers and static catalogs.
  - `buildLearningIssueUrl(event)` + `emitFirstLearningWarning(event)` — pre-filled GitHub New Issue URL for runtime-learned capability constraints. Fires once per (modelId, capability) per process via `console.warn`. Zero telemetry.
  - `wrapProviderError(alias, err)` — idempotent error wrapper. Passes typed framework errors (`ProviderUnavailableError`, `EmptyResponseError`, `ValidationError`) through unchanged.
  - `stringifyContentBlocks(content)` — `MessageContent` → string.
  - `extractJSON(raw)` — parse JSON out of markdown-fenced or prose-wrapped text.
  - `tryParsePartialJSON(buffer)` — best-effort partial JSON parse for streaming. Now uses a proper bracket stack to close in correct reverse order (fixes a bug from the per-adapter copies that broke on inputs like `{"items": [1, 2, 3`).
  - `mergeTokenUsage(a, b)` — add `TokenUsage` values, preserving cache + reasoning token fields.

  Also adds an optional `capability?: string` field to `RetryEvent` so observability stacks can distinguish capability-fallback reasons.

  Non-breaking. Existing imports unchanged; new exports are additive.

## 0.1.0-alpha.1

### Minor Changes

- Add the `OnRetry` observability hook plus the `RetryEvent` / `RetryReason` types to `@llm-ports/core`. The hook fires whenever an adapter retries an in-flight request for a known transient reason: `transient-auth` (OpenAI project-key burst-protection 401), `capability-fallback` (model rejected temperature, json_object, or system message — drop and retry), `reasoning-starvation` (model spent its full output budget on hidden reasoning; retry with expanded budget), or `validation-feedback` (structured output failed schema; retry with a correction prompt). Called fire-and-forget — hook errors do NOT cancel the retry, and async hooks do NOT block it.

  Wires `onRetry` through all four retry sites in `@llm-ports/adapter-openai`: `withTransientAuthRetry` (embeddings), `executeChatRequest`, `executeChatStream`, and the validation-feedback loop inside `generateStructured`. Pass via `createOpenAIAdapter({ apiKey, onRetry })`. Closes #3.

  Also adds a typed `EmptyResponseError` to `@llm-ports/core` (used by the Vercel adapter; see the adapter-vercel changeset for #4 / #5).

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
