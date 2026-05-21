# @llm-ports/adapter-openai

## 0.1.0-alpha.3

### Patch Changes

- fbbd507: Non-functional refactor: consumes shared utilities from `@llm-ports/core` instead of maintaining local duplicates.
  - `wrapError` → `wrapProviderError` (from core)
  - `stringifyPrompt` → `stringifyContentBlocks` (from core)
  - `mergeUsage` → `mergeTokenUsage` (from core)
  - `extractJSON` and `tryParsePartialJSON` (from core; the streaming partial-parse now uses a proper bracket stack)
  - Local `emitRetry` is now a thin wrapper around `emitRetryEvent` (from core)
  - `capabilities.ts` now consumes `createCapabilityLearner` from core; OpenAI-specific error classifiers remain.

  Public API unchanged. No behavior change for users; all 95 adapter-openai tests pass identically.

- e5d058f: Add `KNOWN_REASONING_MODELS` static catalog. Pre-seeds the capability learner at port creation so the first call against well-known reasoning models skips the starvation-retry round-trip.

  Catalog covers:
  - OpenAI o-series (`o1*`, `o3*`, `o4*`)
  - OpenAI `gpt-5-nano*`
  - Cerebras `gpt-oss-*` (via `baseURL=https://api.cerebras.ai/v1`)
  - Clarifai `Qwen3_6-*` (via `baseURL=https://api.clarifai.com/v2/ext/openai/v1`); canonical ID `Qwen3_6-35B-A3B-FP8`
  - SambaNova `MiniMax-M2.7` (via `baseURL=https://api.sambanova.ai/v1`)

  Runtime learning still catches unknown reasoning models on first call; the catalog only saves the first-call round-trip for known ones. User-supplied `pricingOverrides[modelId].capabilities.reasoningModel` still overrides the catalog.

  The compat-providers table in `docs/adapters/openai.md` now lists Clarifai and SambaNova alongside Groq, Together, Fireworks, etc., with worked-example configs and concrete pricing:
  - Clarifai Qwen3.6 35B A3B FP8: $0.76 input / $0.43 output per 1M; 262k context (output cheaper than input — FP8 quantization quirk)
  - SambaNova MiniMax-M2.7: $0.60 input / $2.40 output per 1M; 197k context

  Exports added: `KNOWN_REASONING_MODELS` from `@llm-ports/adapter-openai` (read-only catalog). Public API otherwise unchanged.

- Updated dependencies [fbbd507]
  - @llm-ports/core@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- `generateStructured` now throws the typed `EmptyResponseError` (from `@llm-ports/core`, added in alpha.1) when the response text is empty after `executeChatRequest`'s built-in reasoning-starvation retry has fired. Previously the adapter would fall through to `JSON.parse("")` and raise `SyntaxError`, which got wrapped as a generic `ProviderUnavailableError` and prevented the registry from making intelligent fallback decisions (couldn't tell "provider broken" from "this model can't fit the schema in the budget"). Mirrors `@llm-ports/adapter-vercel`'s behavior shipped in alpha.1. The thrown `EmptyResponseError` carries `alias` and `modelId` so the registry can route to a fallback model. `wrapError()` is also updated to not double-wrap the new error.

## 0.1.0-alpha.1

### Minor Changes

- Add the `OnRetry` observability hook plus the `RetryEvent` / `RetryReason` types to `@llm-ports/core`. The hook fires whenever an adapter retries an in-flight request for a known transient reason: `transient-auth` (OpenAI project-key burst-protection 401), `capability-fallback` (model rejected temperature, json_object, or system message — drop and retry), `reasoning-starvation` (model spent its full output budget on hidden reasoning; retry with expanded budget), or `validation-feedback` (structured output failed schema; retry with a correction prompt). Called fire-and-forget — hook errors do NOT cancel the retry, and async hooks do NOT block it.

  Wires `onRetry` through all four retry sites in `@llm-ports/adapter-openai`: `withTransientAuthRetry` (embeddings), `executeChatRequest`, `executeChatStream`, and the validation-feedback loop inside `generateStructured`. Pass via `createOpenAIAdapter({ apiKey, onRetry })`. Closes #3.

  Also adds a typed `EmptyResponseError` to `@llm-ports/core` (used by the Vercel adapter; see the adapter-vercel changeset for #4 / #5).

### Patch Changes

- Convert `ToolDefinition.inputSchema` (Zod) to real JSON Schema before sending to the provider. Both adapters previously passed `{ type: "object", properties: {} }` to the model, which meant the model had no idea what arguments a tool actually took — tool use was effectively broken when the agent had to infer field names. Adapters now wire `zod-to-json-schema` (`target: "openAi"` for the OpenAI adapter, default standard JSON Schema for Anthropic) with `$refStrategy: "none"` to inline references. Non-Zod inputs still fall back to the safe `{}` shape. Closes #1.
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
