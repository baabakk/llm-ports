# @llm-ports/adapter-vercel

## 0.1.0-alpha.13

### Patch Changes

- Updated dependencies [7c27b2d]
  - @llm-ports/core@0.1.0-alpha.13

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies [1d78426]
  - @llm-ports/core@0.1.0-alpha.12

## 0.1.0-alpha.11

### Patch Changes

- c4e1825: Fix: `generateStructured` now accumulates token usage across `retry-with-feedback` rounds, so `result.usage` and `result.cost` reflect every SDK call, not just the final one.

  **The bug.** When `generateStructured` retried on a Zod-validation failure, `validationAttempts` correctly reported `2` (two real SDK calls happened), but `result.usage` was overwritten with only the SECOND call's tokens. Cost computation read from the overwritten usage, so the reported `result.cost.totalUSD` under-reported the truth by the cost of the first attempt. This was wrong in every retry path across all 5 adapters that implement `generateStructured`.

  ```ts
  // Before alpha.11:
  // 2 SDK calls. Call 1: 100 input / 25 output. Call 2: 150 input / 15 output.
  // Reported: { inputTokens: 150, outputTokens: 15, totalTokens: 165 }   ← only call 2

  // After alpha.11:
  // Reported: { inputTokens: 250, outputTokens: 40, totalTokens: 290 }   ← both calls
  ```

  **The fix.** All 5 generateStructured implementations now use `mergeTokenUsage(lastUsage, parseUsage(response))` inside the retry loop — the same pattern `runAgent` has used since alpha.0 to aggregate per-step usage. No public-API surface changed; the contract for `result.usage` is now "sum across all SDK calls", which is what callers always assumed.

  **Affected adapters:**
  - `@llm-ports/adapter-anthropic` (the original report site — Claude Haiku / Sonnet retry-with-feedback usage)
  - `@llm-ports/adapter-openai`
  - `@llm-ports/adapter-google`
  - `@llm-ports/adapter-ollama`
  - `@llm-ports/adapter-vercel`

  **Tests.** 3 new regression tests in `adapter-anthropic` covering: (a) first-attempt success reports just call 1, (b) retry success reports sum of both calls, (c) `result.cost.totalUSD` reflects the accumulated tokens. Same shape applies to the other 4 adapters; the runAgent paths already exercised `mergeTokenUsage` and continue to work.

  **Why this didn't show up in contract tests.** The shared contract suite asserts `result.validationAttempts >= 2` on the retry path but does not assert anything about cumulative usage — so the bug slipped through. Future addition.

  Closes a user report from 2026-05-26: `claude-haiku-4-5` and `claude-sonnet-4-5` calls were observed with `validationAttempts: 2` and ~832 total tokens (single-call-shaped), which the user correctly diagnosed as "the metric is meaningful but the usage field isn't summing".

## 0.1.0-alpha.9

### Patch Changes

- 286f132: Add `dangerouslyAllowBrowser?: boolean` option to `adapter-openai` and `adapter-anthropic` (closes [#32](https://github.com/baabakk/llm-ports/issues/32)).

  Both SDKs refuse to construct in a browser environment unless the flag is explicitly passed; the adapters now forward the option, unblocking BYO-key / proxy-token / trusted-internal-tool use cases. When the option is omitted (or `false`), the SDK constructor receives no `dangerouslyAllowBrowser` field — same as alpha.8 behavior, so server-side users see no change.

  `adapter-vercel` gets a README note pointing users at the `@ai-sdk/*` LanguageModel construction site, where the equivalent flag lives in that adapter's architecture.

  `adapter-google` and `adapter-ollama` are not affected: `@google/genai` runs in browsers by design; `adapter-ollama` is local-daemon and the browser concern is CORS at the daemon, not an SDK flag.

  5 new unit tests (3 for adapter-openai, 2 for adapter-anthropic).

- Updated dependencies [286f132]
  - @llm-ports/core@0.1.0-alpha.9

## 0.1.0-alpha.8

### Minor Changes

- 6b6f139: Vercel adapter parity with the direct adapters. Closes three v0.1-status gaps that previously had the adapter shipping visibly degraded relative to `adapter-anthropic` / `adapter-openai` / `adapter-google`.

  **Multi-turn `runAgent`.** Previously single-turn — `maxSteps > 1` was ignored. Now wires Vercel AI SDK's native `tools` + `maxSteps` agent loop: the SDK invokes tool `execute` functions between steps and feeds results back to the model, looping until either the model emits text without tool calls (`terminationReason: "completed"`) or `stepsTaken >= maxSteps` (`terminationReason: "max_steps"`). Per-step usage is aggregated across the agent loop.

  **Full multimodal.** Previously image / audio content blocks downgraded to `[image content]` placeholder strings. Now translates to Vercel's `MessagePart[]` shape:
  - base64 images → `{ type: "image", image: "data:<mt>;base64,<data>" }`
  - URL images → `{ type: "image", image: <URL> }`
  - base64 audio → `{ type: "file", data, mimeType }`

  The adapter switches between the simpler `prompt: string` path (text-only) and the `messages` path (multimodal) automatically based on content shape. The `imageContentSupport` flag on the contract test suite flips from `"none"` to `"base64+url"`; image conformance tests now actually exercise the wire format instead of skipping.

  **Bundled pricing.** New `VERCEL_PRICING` table covering OpenAI / Anthropic / Google models via `@ai-sdk/*`. The `pricing` adapter option is now OPTIONAL; user-supplied entries merge on top of the bundled defaults. The bundle table mirrors the direct adapters' tables (same per-model rates, since underlying providers charge identically regardless of SDK layering). For uncommon `@ai-sdk/*` providers (LMStudio, OpenRouter, perplexity-ai, custom routes), users still supply their own entries.

  **New exports**: `VERCEL_PRICING`, `lookupVercelPricing`.

  Public API is additive — existing call sites with `pricing` supplied still work.

### Patch Changes

- 6b6f139: Docs polish across all 5 adapter READMEs (closes [#7](https://github.com/baabakk/llm-ports/issues/7)). Every adapter README now follows the canonical section template:

  ```
  # @llm-ports/adapter-<name>
  <tagline>

  ## Install
  ## Configure
  ## Adapter options
  ## Bundled pricing
  ## Supported features
  ## Content blocks supported
  ## Cancellation
  <adapter-specific sections>
  ## Reading next
  ```

  Adapter-specific sections (Anthropic's temperature handling, OpenAI's compat-providers + known reasoning models, Ollama's local-to-cloud flip + model management, Google's "why over OpenAI-compat baseURL", Vercel's "when to use vs direct") sit between Cancellation and Reading next. Public-facing behavior unchanged.

  Per-example `.env.example` files added to all 10 examples (closes [#8](https://github.com/baabakk/llm-ports/issues/8)) so new users can `cp .env.example .env` then fill in their keys without grepping the source for `process.env.*`.

  No code changes; package version bumps via this changeset because the README is published to npm as the package landing page.

## 0.1.0-alpha.7

### Patch Changes

- c805169: Two registry-surface improvements that close long-standing v0.1 gaps:

  **Registry runtime fallback** — the registry now walks the task's fallback chain on errors matching a configurable predicate. Previously the chain was walked ONLY on budget gating; runtime errors (5xx, network failures, transient outages wrapped as `ProviderUnavailableError`) failed the call instead of trying the next provider. This was the largest functional gap in v0.1 per the status doc.

  ```ts
  const registry = createRegistryFromEnv({
    adapters: {
      /* ... */
    },
    // runtimeFallback: "default", // walks on ProviderUnavailableError (the default)
    // runtimeFallback: "none",    // disables; preserves v0.1 behavior
    // runtimeFallback: { shouldFallback: (err) => err instanceof MyCustomError }, // custom
  });
  ```

  Cost recording happens ONLY on the successful provider. The chain walk respects per-provider budget gates — if `fast` is over budget AND fails, the registry walks to `backup`. Streaming methods walk only on synchronous stream-creation failure (not mid-iteration), since switching providers mid-stream would emit a confusing mix.

  **`forceProviderAlias` per-call option** (closes [#15](https://github.com/baabakk/llm-ports/issues/15)) — every `*Options` interface gains `forceProviderAlias?: string`. Setting it routes directly to the named provider, bypassing the `LLM_TASK_ROUTE_*` lookup. Per-provider budget gates still apply (so you can't bypass a hard cap); runtime fallback does NOT engage (caller explicitly picked this provider, falling back would defeat the point). Useful for toolbars where the operator picks the model, or for one-off "use the expensive model for this single call" patterns.

  ```ts
  await llm.generateText({
    taskType: "describe",
    prompt: "...",
    forceProviderAlias: userSelectedProvider, // bypasses task routing
  });
  ```

  **New exports** from `@llm-ports/core`: `Registry.selectByAlias()`, `Registry.selectViableChain()`, `Registry.shouldFallback`.

  **Adapter patch bumps**: no code change — adapters pick up the new `forceProviderAlias` field on `*Options` automatically via core's peer-dep type re-export.

  13 new tests (8 runtime-fallback + 5 forceProviderAlias). The `registry-edges.test.ts` test that documented "runtime ProviderUnavailableError propagates and does NOT trigger fallback (TD-LLMP-09)" has been inverted to assert the new behavior.

- Updated dependencies [c805169]
  - @llm-ports/core@0.1.0-alpha.7

## 0.1.0-alpha.6

### Minor Changes

- 34cd6cd: Add `signal?: AbortSignal` to all 5 `*Options` interfaces (closes [#24](https://github.com/baabakk/llm-ports/issues/24)).

  Previously the only abort mechanism was a consumer-side `Promise.race` against a timeout, which stops awaiting the promise but doesn't actually cancel the in-flight HTTP request — the LLM call keeps running and bills tokens. With `signal` threaded through to the provider SDK, `controller.abort()` now cancels the in-flight fetch.

  ```ts
  const controller = new AbortController();
  const promise = llm.generateText({
    taskType: "screen_analyze",
    prompt: [...],
    signal: controller.signal,
  });
  // User clicks cancel:
  controller.abort();
  // promise rejects with signal.reason; the HTTP request to the provider is cancelled.
  ```

  **Per-adapter behavior (declared via contract suite's new `signalSupport` flag):**

  | Adapter                        | `signalSupport`    | What it does                                                                                                                                                                              |
  | ------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `@llm-ports/adapter-openai`    | `"entry+inflight"` | Entry-time check + signal threaded as 2nd-arg request options on `client.chat.completions.create`                                                                                         |
  | `@llm-ports/adapter-anthropic` | `"entry+inflight"` | Entry-time check + signal threaded into `client.messages.create` (non-streaming) AND `client.messages.stream`                                                                             |
  | `@llm-ports/adapter-google`    | `"entry+inflight"` | Entry-time check + signal threaded into `client.models.generateContent` config                                                                                                            |
  | `@llm-ports/adapter-vercel`    | `"entry+inflight"` | Entry-time check + Vercel's `abortSignal` field on `generateText` / `streamText`                                                                                                          |
  | `@llm-ports/adapter-ollama`    | `"entry-only"`     | Entry-time check only. ollama-js SDK doesn't expose a per-call signal yet — only a coarse `client.abort()` that cancels all in-flight requests on the client. Tracking upstream for v0.7+ |

  **New core export:** `throwIfAborted(signal)` helper. Honors `signal.reason` (modern AbortController convention); falls back to a generic `DOMException("AbortError")`.

  **New contract test capability:** `ContractTestContext.signalSupport: "none" | "entry-only" | "entry+inflight"`. Adapters declare their support level; the conformance suite runs entry-time abort tests against `generateText`, `generateStructured`, and `runAgent` for any adapter that declares `"entry-only"` or higher.

  **`runAgent` extra:** all 5 adapters' agent loops re-check `throwIfAborted(options.signal)` between steps so cancellation mid-loop propagates (not just at the entry point).

  Public API additive only. Existing call sites that omit `signal` are unchanged.

  21 new tests (6 unit + 3 contract × 5 adapters).

### Patch Changes

- Updated dependencies [34cd6cd]
  - @llm-ports/core@0.1.0-alpha.6

## 0.1.0-alpha.5

### Minor Changes

- b00ff65: Image-block boundary validation (closes issues #19, #20, #21 from the image-pipeline audit).

  **New errors** in `@llm-ports/core`:
  - `ImageTooLargeError(alias, imageIndex, byteSize, limitBytes)` — base64 image exceeds the provider's per-image byte limit
  - `InvalidImageUrlError(alias, url, reason)` — URL-form image with `file://`, `data:`, missing scheme, or other bad shape

  **New helpers** in `@llm-ports/core`:
  - `validateImageBlocks(blocks, opts)` — call at the adapter boundary on every outgoing `ContentBlock[]`
  - `validateImageUrl(url, alias, allowFileUrl)` — standalone URL-shape check

  **Per-adapter boundary checks** wired in every port method (`generateText`, `generateStructured`, `streamText`, `streamStructured`, `runAgent`) with adapter-specific defaults:

  | Adapter             | Default `imageSizeLimitBytes` | Source                                  |
  | ------------------- | ----------------------------- | --------------------------------------- |
  | `adapter-anthropic` | 5 MB                          | Anthropic's documented per-image limit  |
  | `adapter-openai`    | 20 MB                         | OpenAI's documented per-image limit     |
  | `adapter-ollama`    | unset (model-dependent)       | Ollama itself doesn't enforce           |
  | `adapter-vercel`    | 20 MB                         | Matches the underlying SDK's image path |
  | `adapter-google`    | 20 MB (new package)           | Gemini's documented inline limit        |

  **Assistant `image_url` decoding** in `adapter-openai`: `fromOpenAIAssistantMessage` now decodes any `image_url` content part in an assistant response back to an `ImageBlock` (data URI → base64, http(s) → URL). Previously these were silently dropped (commented "very rare"). Zero models emit this today, but future-proofs the round-trip.

  17 new tests in `@llm-ports/core` + 3 new tests in `@llm-ports/adapter-openai`.

### Patch Changes

- b00ff65: Two-layer validation hardening that reduces retry-with-feedback round-trips:

  **Layer 1 — `extractJSON()` falls back to `jsonrepair`** when plain `JSON.parse` fails. Catches trailing commas, single quotes, smart quotes, unquoted keys, Python `None`/`True`/`False`, comments, missing braces, and most other LLM syntactic quirks before paying for a retry. Gated on "input has `{` or `[`" so prose-only input still throws cleanly.

  **Layer 2 — `attemptValidationRepair()` ported from BEPA** runs between Zod `safeParse` failure and the retry-with-feedback step. Deterministic, schema-driven repair of 6 patterns:
  1. `null` where a non-null type is expected → delete key (lets `.optional()` succeed)
  2. string `"9"` where `number` expected → coerce to `9`
  3. string `"true"`/`"false"` where `boolean` expected → coerce to `true`/`false`
  4. number `9` where `string` expected → coerce to `"9"`
  5. enum case/whitespace drift (`"HIGH"`) → `.toLowerCase().trim()` (`"high"`)
  6. `null` in optional union → delete key

  Wired into `generateStructured` on every adapter. Each match avoids an LLM retry round-trip.

  Compatible with both Zod v3 (`invalid_enum_value`) and Zod v4 (`invalid_value`).

  20 new tests in `@llm-ports/core` (8 jsonrepair + 12 repair-validation).

- Updated dependencies [b00ff65]
- Updated dependencies [b00ff65]
- Updated dependencies [b00ff65]
  - @llm-ports/core@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- f0885e6: Add image-content-block conformance tests to the shared contract suite. Closes a gap where a new adapter could ship with broken image handling and the conformance suite would still pass.

  The contract suite now includes two conditional tests under `image content blocks (conditional)`:
  1. `generateText accepts a base64 ImageBlock in the prompt`
  2. `generateText accepts a URL ImageBlock in the prompt`

  Each test gates on a new `ContractTestContext.imageContentSupport` flag:
  - `"base64"` — Ollama (URL form is not supported by the underlying API)
  - `"url"` — none today
  - `"base64+url"` — Anthropic, OpenAI
  - `"none"` / undefined — Vercel (v0.1 degrades images to placeholder strings)

  Each per-adapter `contract.test.ts` now declares its support level. Total contract-suite tests per adapter went from 8 to 10.

- Updated dependencies [f0885e6]
  - @llm-ports/core@0.1.0-alpha.4

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
