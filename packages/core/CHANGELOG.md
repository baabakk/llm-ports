# @llm-ports/core

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

- b00ff65: Session-scoped cost gating (closes issue #16).

  `Registry.openCostSession({ budgetUSD })` returns a `CostSession` that wraps an LLMPort with a hard USD cap independent of the per-provider hour/day/month gates. Throws `SessionBudgetExceededError` mid-loop when the cap is reached.

  ```ts
  const session = registry.openCostSession({ budgetUSD: 0.50 });
  const llm = session.getPort();
  try {
    for (const frame of screenCaptureFrames) {
      await llm.generateText({ taskType: "screen_analyze", prompt: [...] });
    }
  } finally {
    console.log("session spent:", session.totalSpentUSD());
    session.close();
  }
  ```

  Bumped to high priority by alpha.4's `ImageSource.detail = "high"` characterization: continuous screen-capture sessions can burn real money if left running unattended. The per-provider gates still apply on top; session budget is a hard backstop, not a replacement.

  Pre-check semantics: the check fires when `spentUSD >= budgetUSD`, so the _next_ call after the budget is reached throws. One small overshoot is possible (the call that crosses the budget runs to completion before its cost is counted). For tighter precision, set the session budget slightly below your hard cap.

  9 new tests in `@llm-ports/core`.

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

## 0.1.0-alpha.4

### Minor Changes

- f0885e6: Add optional `detail?: "auto" | "low" | "high"` field to `ImageSource` (both base64 and URL variants). Forwarded to OpenAI's `image_url.detail` to control the cost-vs-fidelity tradeoff:
  - `"low"` ~85 tokens regardless of image size; suitable for triage / broad classification
  - `"high"` ~170 tokens per 512×512 tile; needed for OCR and fine-grained reasoning
  - `"auto"` (default) lets OpenAI decide based on image size

  For screenshot-heavy or document-OCR workloads, switching to `"low"` for triage can cut per-image vision cost ~9x. The field is additive — existing call sites work unchanged.

  Other adapters (Anthropic, Ollama) ignore the field. Anthropic and Ollama have no equivalent knob in their respective image APIs.

  ```ts
  {
    type: "image",
    source: {
      kind: "base64",
      mediaType: "image/png",
      data: screenshotBase64,
      detail: "low",
    },
  }
  ```

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
