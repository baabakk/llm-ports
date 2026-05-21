# @llm-ports/adapter-anthropic

## 0.1.0-alpha.3

### Minor Changes

- fbbd507: Fix: adapter forwards `temperature` to Claude models that reject it ([#12](https://github.com/baabakk/llm-ports/issues/12)).

  The adapter now learns at runtime when a model rejects `temperature` (Anthropic returns 400 "temperature is deprecated for this model" on newer reasoning Claude). On detection, the adapter strips the parameter, retries the call, and remembers the constraint for the rest of the process so subsequent calls skip the bad parameter.

  Five things ship together:
  - **Runtime learning + retry.** Single retry per call on `temperatureLocked` detection. Subsequent calls in the process apply the constraint up front.
  - **Static catalog.** `claude-opus-4-5` and `claude-sonnet-4-5` are pre-seeded so first-call discovery is skipped for these known cases. Extend by editing `KNOWN_TEMPERATURE_REJECTORS` in `src/capabilities.ts`.
  - **`onRetry` plumbing.** Brings adapter-anthropic to parity with adapter-openai and adapter-vercel. New `AnthropicAdapterOptions.onRetry` option. Fires with `reason: "capability-fallback", capability: "temperatureLocked"` on every learning retry.
  - **Click-to-file URL on first learning.** `console.warn` with a pre-filled GitHub New Issue URL the user can click to file a report. Maintainers see signal only when users take explicit action. No telemetry.
  - **SDK version compatibility warning.** Surfaces "upgrade us or downgrade them" when the installed `@anthropic-ai/sdk` is outside the tested range (`>=0.32.0 <0.50.0`).

  Also refactors the adapter to consume shared utilities from `@llm-ports/core` (no behavior change beyond the bug fix above; net deletion of ~150 lines of duplicated helpers).

  15 new tests (8 temperature-rejection + 7 SDK version check). All 29 existing tests still pass. Closes #12.

### Patch Changes

- Updated dependencies [fbbd507]
  - @llm-ports/core@0.1.0-alpha.3

## 0.1.0-alpha.1

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
