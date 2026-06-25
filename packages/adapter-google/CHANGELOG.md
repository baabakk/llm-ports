# @llm-ports/adapter-google

## 0.1.0-alpha.24

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.24

## 0.1.0-alpha.23

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.23

## 0.1.0-alpha.22

### Minor Changes

- `createGoogleAdapter` now accepts an optional `httpOptions` field that is forwarded verbatim to the underlying `@google/genai` `GoogleGenAI` constructor. Closes [llm-ports#46](https://github.com/baabakk/llm-ports/issues/46) (Q1 from the Dramma backend-proxy plan).

  ## Motivation

  Pre-alpha.22, `GoogleAdapterOptions` exposed only `apiKey`, `pricingOverrides`, `validationStrategy`, `imageSizeLimitBytes`, and `onRetry`. There was no way to redirect Gemini API calls away from the default `https://generativelanguage.googleapis.com/`. That blocks the canonical browser-app pattern of routing cloud LLM calls through a backend proxy that holds the real API key:

  ```
  browser bundle  →  POST https://your-app/api/llm/google/...  →  backend (real GEMINI_API_KEY)  →  Google
  ```

  `@google/genai` itself has supported this via `httpOptions.baseUrl` since at least 2.5.0. The adapter just wasn't forwarding the field.

  ## What changed

  ```ts
  const adapter = createGoogleAdapter({
    apiKey: process.env.DRAMMA_API_KEY!, // Bearer token for YOUR backend
    httpOptions: {
      baseUrl: "https://your-app.example/api/llm/google",
      // other HttpOptions fields: apiVersion, headers, timeout, retryOptions, ...
    },
  });
  ```

  The `HttpOptions` interface (re-exported from `@google/genai`) is also re-exported from `@llm-ports/adapter-google`, so consumers can type their override without adding `@google/genai` as a peer dep.

  ## Backwards compatibility

  Additive: callers who don't pass `httpOptions` see no behavior change. The conditional spread (`...(opts.httpOptions ? { httpOptions: opts.httpOptions } : {})`) means the field is also omitted from the constructor call when not supplied — matches the pre-alpha.22 wire shape exactly.

  ## Tests

  5 new tests in `tests/quirks/http-options-passthrough.test.ts`:
  - baseUrl forwarded to GoogleGenAI constructor
  - Full HttpOptions object (baseUrl + apiVersion + headers + timeout) forwarded verbatim
  - Constructor call unchanged when httpOptions omitted (no breaking change)
  - Constructor call unchanged when httpOptions explicitly undefined
  - HttpOptions type is reachable from the package surface (compile-time check)

  Plus a `vi.hoisted`-based test helper refactor that exposes the `GoogleGenAI` constructor mock so future tests can assert what the adapter passes through to the SDK.

## 0.1.0-alpha.21

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.21

## 0.1.0-alpha.20.1

### Patch Changes

- No code change. Version bump for workspace alignment with the alpha.20.1 migration-safeguards release.

## 0.1.0-alpha.20

### Minor Changes

- No behavior change. Same plumbing as adapter-anthropic. Version bump for workspace alignment.

## 0.1.0-alpha.19.1

### Patch Changes

- Wire CacheControl mode: preCreated to Gemini cachedContent. When set with cachedContentHandle, the adapter sets config.cachedContent on the generateContent call. Other modes are documented no-ops on Gemini. 7 new tests in tests/quirks/cache-control.test.ts.

## 0.1.0-alpha.19

### Patch Changes

- c0ef1d7: CacheControl shape commit. **Breaking** in alpha-line surface: `cost.cacheDiscountUSD` is renamed to `cost.cacheSavingsUSD` on every result object. The shape of `CacheControl` is locked so beta.0 ships the right abstraction over the three caching patterns the major providers expose.

  This is the third in the four-alpha shape-lock sequence before beta.0. The prior two (alpha.17 RerankPort + BackoffConfig + onRetry parity; alpha.18 typed-error taxonomy) close adapter-shape gaps; this one closes the provider-cache divergence gap. The two remaining alphas (alpha.20 BudgetScope + minute/session gating; alpha.21 observability hook signatures) close budget grammar and telemetry surface.

  ### New: `CacheControl` shape

  ```ts
  import type { CacheControl } from "@llm-ports/core";

  interface CacheControl {
    mode: "auto" | "manual" | "preCreated" | "off";
    ttlSeconds?: number;
    breakpoints?: Array<{ at: "tools" | "system" | "message-index"; index?: number }>;
    cachedContentHandle?: string;
    namespace?: string;
  }
  ```

  `cacheControl?` is now an optional field on every request option type: `GenerateTextOptions`, `GenerateStructuredOptions`, `StreamTextOptions`, `StreamStructuredOptions`, `RunAgentOptions`. Omitting it is equivalent to `{ mode: "auto" }`: the adapter does whatever its provider does by default.

  The four modes encode the field consensus across the three patterns:
  - **`auto`** — let the adapter decide per provider. Right default for most callers.
  - **`manual`** — caller supplies explicit `breakpoints` (Anthropic).
  - **`preCreated`** — caller supplies a `cachedContentHandle` returned from a prior `createCachedContent` call (Google Gemini).
  - **`off`** — caller opts out where the provider allows (Anthropic strips `cache_control` from message blocks).

  `namespace` partitions cache lookups by tenant or customer through caching proxies that support partition keys (Helicone's `Cache-Seed` header is the reference pattern).

  Per-provider behavior table:

  | Mode         | Anthropic                             | OpenAI                           | Google Gemini              |
  | ------------ | ------------------------------------- | -------------------------------- | -------------------------- |
  | `auto`       | place marker at last static block     | no-op (implicit cache always on) | no-op                      |
  | `manual`     | place markers at supplied breakpoints | no-op                            | no-op                      |
  | `preCreated` | no-op                                 | no-op                            | uses `cachedContentHandle` |
  | `off`        | strip `cache_control` from blocks     | no-op (no API)                   | no-op (no API)             |
  | `ttlSeconds` | 300 or 3600                           | ignored                          | passed through             |

  Per-mode adapter behaviors mature across beta minors. The **shape** itself is stable as of alpha.19.

  ### Breaking change: `cost.cacheDiscountUSD` → `cost.cacheSavingsUSD`

  Every result object (`GenerateTextResult`, `GenerateStructuredResult`, `AgentResult`) whose `.cost` previously carried `cacheDiscountUSD` now carries `cacheSavingsUSD`. The semantics are unchanged: USD the caller saved on this call by hitting prompt cache, versus paying the full input rate. The field is still optional and only set when the provider returned cache telemetry (`cacheReadTokens > 0`).

  The rename is not gradual. The old name does not exist in alpha.19. TypeScript will catch every read site. Runtime code that hand-rolled a `result.cost.cacheDiscountUSD` reference will resolve to `undefined`.

  Rationale: "discount" implied a vendor-applied price reduction (Anthropic's cache_control billing tier, OpenAI's automatic cache). The field is actually the **caller-visible** dollar amount they did not pay. OpenInference's emerging `llm.cost.cache_savings` convention and Helicone's dashboard vocabulary already use "savings" for the same concept. Aligning the field name removes a small wrong implication and makes the cross-tool wire-up trivial.

  ### Migration

  See `docs/migration/alpha-18-to-alpha-19.md` for the step-by-step. Summary:

  ```diff
  - if (result.cost.cacheDiscountUSD !== undefined) {
  -   metrics.cacheSavings.record(result.cost.cacheDiscountUSD);
  - }
  + if (result.cost.cacheSavingsUSD !== undefined) {
  +   metrics.cacheSavings.record(result.cost.cacheSavingsUSD);
  + }
  ```

  Optionally start setting `cacheControl` on requests; Anthropic users get `mode: "manual"` breakpoint placement, OpenAI users get a `namespace` partition forwarded through proxies, Google users get `mode: "preCreated"` cached-content handles. Adapters that don't act on the field today still accept it without crashing, so setting it now is forward-compatible.

  ### Test stats

  626 tests passing across the workspace (up from 615 in alpha.18). 11 new tests in `packages/core/tests/cache-control.test.ts` cover the shape lock and the field rename. Two existing cost tests updated to the new field name.

  ### Docs
  - New: `docs/concepts/cache.md` — locked shape, per-provider behavior, when fields are honored vs ignored.
  - New: `docs/migration/alpha-18-to-alpha-19.md` — migration steps + breaking-change disclosure.
  - Updated: `docs/v0-1-status.md` — alpha.19 row added to closed-issues table.

  ### What did not change
  - Adapter factories, the `Registry`, `createXxxAdapter` signatures, environment variable names, routing tokens.
  - `TokenUsage.cacheReadTokens` and `TokenUsage.cacheWriteTokens`.
  - Existing default behavior on every adapter (alpha.18 callers who omitted `cacheControl` see identical behavior on alpha.19).
  - Adapter conformance test suite (unchanged).
  - The typed error taxonomy from alpha.18.

- Updated dependencies [c0ef1d7]
  - @llm-ports/core@0.1.0-alpha.19

## 0.1.0-alpha.18

### Patch Changes

- Typed-error taxonomy commit. **Breaking** in alpha-line surface: `ContextWindowExceededError` no longer matches `instanceof ProviderUnavailableError`; 5xx errors now classify to `ServiceUnavailableError` (the typed base) rather than `ProviderUnavailableError` (which is now reserved for unknown-status fallbacks).

  This is the largest single correctness fix in the v0.1 line. The change closes the architectural bug named in the BEPA-internal master plan: previously, a 400 context-window overflow was wrapped as `ProviderUnavailableError`, which caused the registry to fall back to another provider that would fail the same way. The new taxonomy correctly classifies 400-class errors as `BadRequestError` subclasses so consumers can route them to a larger-window model explicitly rather than retrying blindly.

  ### New typed-error hierarchy

  ```
  LLMPortError                                  // common base for instanceof checks
  ├── BadRequestError                           // 400-class root (client-fixable)
  │   ├── ContextWindowExceededError            // prompt too long for model
  │   └── ContentPolicyViolationError           // content filter rejected the request
  ├── AuthenticationError                       // 401/403 (NOT retryable to same provider)
  ├── RateLimitError                            // 429 with optional retryAfterMs
  ├── BudgetExceededError                       // port-internal cap exhausted (unchanged)
  ├── SessionBudgetExceededError                // CostSession exhausted (unchanged)
  ├── ServiceUnavailableError                   // 503 root (transient)
  │   ├── ProviderUnavailableError              // SDK error or unreachable; reparented
  │   └── EmptyResponseError                    // model returned empty visible text; reparented
  ├── NoProvidersAvailableError                 // entire chain exhausted (unchanged)
  ├── ValidationError                           // structured-output Zod failure (unchanged)
  ├── ContentBlockUnsupportedError              // unchanged
  ├── ConfigError                               // unchanged
  ├── ImageTooLargeError                        // unchanged
  └── InvalidImageUrlError                      // unchanged
  ```

  All classes now extend `LLMPortError` (which extends `Error`). Use `e instanceof LLMPortError` to catch any library error.

  ### New typed-error matchers

  ```ts
  import { errorMatchers } from "@llm-ports/core";

  // Field consensus (matches LiteLLM content_policy_fallbacks / context_window_fallbacks pattern)
  errorMatchers.rateLimit(e); // RateLimitError only
  errorMatchers.transient(e); // RateLimitError + ServiceUnavailableError subclasses
  errorMatchers.default(e); // Anything except BadRequest + Authentication (recommended)
  errorMatchers.all(e); // Every LLMPortError subclass
  ```

  ### `wrapProviderError` now classifies HTTP-shaped SDK errors

  The shared helper detects status codes and message patterns and produces the right typed class:

  ```
  status 400 + "context length" / "tokens" message → ContextWindowExceededError
  status 400 + "content policy" / "safety" message → ContentPolicyViolationError
  status 400 + other                               → BadRequestError
  status 401 / 403                                 → AuthenticationError
  status 429 + Retry-After header                  → RateLimitError(retryAfterMs)
  status 500 / 502 / 503 / 504                     → ServiceUnavailableError
  no status (network reset, parse error, etc.)     → ProviderUnavailableError (fallback)
  ```

  `Retry-After-Ms` (Anthropic) and `Retry-After` (seconds or HTTP-date) are parsed.

  ### Breaking change disclosure

  Consumers branching on `instanceof ProviderUnavailableError` after a 5xx SDK error will need to update to `instanceof ServiceUnavailableError` (or check both). Consumers branching after a 400 context-window error will need to check `instanceof BadRequestError` or `instanceof ContextWindowExceededError` rather than `instanceof ProviderUnavailableError`. Consumers branching after a 401 will need `instanceof AuthenticationError`.

  This is the breakage the master plan deliberately surfaced in alpha (not beta).

  ### alpha.17 close-out items rolled in

  Per `TD-LLMPORTS-ALPHA17-CLOSEOUT`:
  1. **`packages/adapter-ollama/tests/quirks/on-retry-hook.test.ts`** — 5 tests verifying `onRetry` fires for the validation-feedback retry path with the right shape, that hook errors don't cancel the retry, and that async hooks work fire-and-forget.
  2. **`packages/adapter-google/tests/quirks/on-retry-hook.test.ts`** — 4 tests with the same shape for adapter-google.
  3. **`docs/v0-1-status.md`** — closed-issues table gains 4 rows for alpha.17 + alpha.18 items (RerankPort skeleton, BackoffConfig, onRetry parity, typed-error taxonomy with breaking-change call-out).
  4. **`docs/adapters/google.md`** — new `onRetry?: OnRetry` documented with a Langfuse / Phoenix wiring example.
  5. **`docs/adapters/ollama.md`** — same documentation pattern.
  6. **`packages/adapter-google/README.md`** — Supported features table gains the onRetry hook row.
  7. **`packages/adapter-ollama/README.md`** — same.

  ### Test stats

  615 tests passing across the workspace (up from 577 in alpha.17). 29 new error-taxonomy tests + 5 ollama onRetry hook tests + 4 google onRetry hook tests. Several alpha.17-era adapter-openai tests updated to assert the new typed classes (4 quirks files).

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.18

## 0.1.0-alpha.17

### Minor Changes

- First alpha of the v0.1 line approved by Babak per the BEPA-internal `RELEASE-PLAN-0.1.0-roadmap-to-1.0.md`. This release ships 5 small additive items plus the `RerankPort` skeleton that adapter-cohere will implement against in beta.0.

  ### `RerankPort` skeleton in `@llm-ports/core`

  New port interface in `packages/core/src/ports/rerank-port.ts`. Sibling of `LLMPort` and `EmbeddingsPort`. Reranking is a separate computational primitive from chat completion (Cohere Rerank-3, Voyage AI rerank-2, Jina Reranker, Mixedbread mxbai-rerank all ship dedicated rerank APIs that are not chat-shaped). Modeling it as its own port matches the field (LlamaIndex `BaseNodePostprocessor`, LangChain `DocumentCompressor`).

  ```ts
  export interface RerankInput {
    query: string;
    documents: string[];
    topN?: number;
    signal?: AbortSignal;
    forceProviderAlias?: string;
    providerExtras?: Record<string, unknown>;
  }

  export interface RerankedDocument {
    index: number;
    relevanceScore: number;
    document: string;
  }

  export interface RerankResult {
    results: RerankedDocument[];
    usage: TokenUsage;
    cost: CostUsage;
    modelId: string;
    providerAlias: string;
  }

  export interface RerankPort {
    rerank(input: RerankInput): Promise<RerankResult>;
  }
  ```

  Six design decisions locked per the BEPA-internal release plan: single query per call (no batching), document text echoed in output, score normalized to `[0, 1]`, long-document handling via `providerExtras` (Cohere `max_chunks_per_doc`, Voyage `truncation`, etc.), multimodal docs out of scope for now, reranker model selection at adapter construction.

  `TokenUsage` extended with `searchUnits?` (Cohere bills per search unit) and `rerankedDocuments?` (telemetry). Both optional; unused by `LLMPort` and `EmbeddingsPort` calls.

  No adapter implementation yet — first ships in `@llm-ports/adapter-cohere` for beta.0.

  ### Jittered exponential backoff config

  New `BackoffConfig` and `JitterStrategy` types in `@llm-ports/core` plus a pure-function `computeBackoffDelay(attempt, config, prevDelay, rng)` helper. Adapters consume this when computing sleep duration between retries.

  ```ts
  type JitterStrategy = "none" | "full" | "equal" | "decorrelated";

  interface BackoffConfig {
    initialDelayMs?: number; // default 200
    maxDelayMs?: number; // default 10000
    multiplier?: number; // default 2
    jitter?: JitterStrategy; // default "decorrelated"
  }
  ```

  Decorrelated jitter is the default per AWS Architecture Blog "Exponential Backoff And Jitter" (2015); it preserves average backoff while breaking up retry storms most aggressively. The shape matches Genkit's middleware retry config so users migrating from Genkit see a familiar API.

  10 new unit tests in `packages/core/tests/backoff.test.ts`.

  ### `onRetry` parity: adapter-google + adapter-ollama

  Wire `emitRetryEvent` at the validation-feedback retry sites in `adapter-google` and `adapter-ollama`, matching the existing wiring in `adapter-openai` and `adapter-anthropic`. Both adapters' options interfaces gain an optional `onRetry?: OnRetry` field. Consumers can now wire observability uniformly across all four adapters:

  ```ts
  const adapter = createGoogleAdapter({
    apiKey: process.env.GOOGLE_API_KEY!,
    onRetry: (event) => {
      span.addEvent("llm.retry", {
        reason: event.reason,
        attempt: event.attempt,
        modelId: event.modelId,
      });
    },
  });
  ```

  Closes the parity gap named in the BEPA-internal A01 CLAUDE.md "onRetry plumbing" section.

  ### `validationAttempts` regression contract test strengthened

  `packages/adapter-contract-tests/src/suite.ts` now asserts the exact value rather than a `>=` lower bound. First-try success must report `validationAttempts === 1`; one retry must report `=== 2`. This pins the fix for `TD-LLMPORTS-VALIDATION-ATTEMPTS` (resolved alpha.11) so a regression can never re-introduce the "overwrites instead of accumulates" bug.

  ### Boundary-examples documentation pass

  `@llm-ports/capabilities` README gains a "Lifting hand-rolled VOCABULARY blocks into `boundaryExamples`" section showing the before/after migration pattern and the `Resolvable<TInput, string>` shape for per-input vocabularies.

  ### `forceProviderAlias` budget-bypass property

  Already correct in code since alpha.7 (`Registry.selectByAlias` runs budget + cost checks before resolving) and already covered by `packages/core/tests/force-provider.test.ts` lines 163 and 192. No code change needed; the master plan item is closed by verifying the existing tests pin the property explicitly with the comment "caller can't use forceProviderAlias to bypass a hard cap."

  ### Workspace test summary

  577 tests passing (up from 567 in alpha.16). 10 new backoff tests + the strengthened `validationAttempts` assertions. No regressions.

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.17

## 0.1.0-alpha.16

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.16

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

### Minor Changes

- 286f132: Gemini parity: multi-turn `runAgent` + native `responseSchema`.

  **`runAgent` is now multi-turn.** alpha.5–alpha.8 shipped a single-turn shim that ignored `maxSteps > 1` and surfaced no `toolCalls`. The adapter now translates `options.tools` to Gemini's `Tool[]` shape (function declarations with JSON Schema, OpenAPI 3.0 subset, via `zod-to-json-schema`), loops the chat / function-call / function-response cycle until the model returns text only (`terminationReason: "completed"`) or `maxSteps` is reached (`terminationReason: "max_steps"`), and reports the full `toolCalls` array + aggregated usage across steps. Parallel function calls (Gemini emits multiple in a single turn) are executed and their responses are returned together, matching Gemini's required protocol.

  **`generateStructured` now uses native `responseSchema`** for constrained-decoding when the Zod schema converts cleanly to Gemini's accepted JSON Schema dialect. The adapter passes `config.responseSchema` + `config.responseMimeType: "application/json"` so Gemini constrains decoding to the schema before tokens are produced. Zod validation, the alpha.5 repair pass, and `retry-with-feedback` remain the safety net (Gemini's schema enforcement is best-effort).

  When the schema contains features Gemini's responseSchema does not accept (`oneOf`, `allOf`, `not`, `$ref` — note: `anyOf` IS accepted; `z.discriminatedUnion` produces `anyOf` and stays on the native path), the adapter falls back to the prompted-JSON path with a one-time `console.warn` per (model, feature) pair. Output is still correct in either case — only the constrained-decoding guarantee differs.

  **New dependency:** `zod-to-json-schema ^3.23.5` (already a transitive dep via adapter-openai / adapter-anthropic).

  **New exported helpers** (mostly used internally; exported for advanced testing):
  - `_resetSchemaFallbackWarnings()` — test-only Set reset.

  Closes the two v0.2-commitments listed in alpha.5's release notes for `adapter-google`. 13 new tests (7 multi-turn + 6 native responseSchema).

- 286f132: Runtime model discovery: `LLMPort.listModels()` + `Registry.checkPricingFreshness()` (closes [#9](https://github.com/baabakk/llm-ports/issues/9)).

  **`LLMPort.listModels?(): Promise<ProviderModelInfo[]>`.** New optional method on every LLMPort. Returns the models the provider currently exposes via its catalog API. Implemented in:

  | Adapter             | Source                                                         | Pricing exposed?                                   |
  | ------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
  | `adapter-openai`    | `client.models.list()`                                         | No (just IDs + `owned_by`)                         |
  | `adapter-anthropic` | direct fetch to `/v1/models` (SDK <0.39 lacks `client.models`) | No                                                 |
  | `adapter-google`    | `client.models.list()` from `@google/genai`                    | No (Gemini surfaces context window, not USD rates) |
  | `adapter-ollama`    | `client.list()` (locally running models)                       | No (local; free)                                   |

  `adapter-vercel` does NOT implement it: the underlying `LanguageModel` is opaque per-provider and there's no uniform discovery surface.

  **`Registry.checkPricingFreshness()`.** Compares each adapter's bundled `*_PRICING` table against the provider's live catalog and reports:
  - `addedModels`: live IDs not in the bundled table (newly launched models you can opt into via `pricingOverrides`)
  - `removedModels`: bundled IDs the provider no longer exposes (likely deprecated)
  - `priceDrift`: per-model rate differences when the API surfaces pricing (today: none; future-proofs the report)
  - `skipped`: adapters without `listModels()` or whose call failed (with reason)

  Use in CI or a scheduled job to get a heads-up when a provider quietly changes its catalog. The bundled tables remain the source of truth for cost computation; this method does NOT auto-update them.

  ```ts
  const report = await registry.checkPricingFreshness();
  for (const a of report.checked) {
    if (a.addedModels.length > 0) {
      console.warn(`[${a.adapter}] new models available: ${a.addedModels.join(", ")}`);
    }
    if (a.removedModels.length > 0) {
      console.warn(
        `[${a.adapter}] bundled models no longer exposed: ${a.removedModels.join(", ")}`,
      );
    }
  }
  ```

  **New core exports:** `ProviderModelInfo`, `PricingFreshnessReport`, `PricingFreshnessAdapterReport`.

  4 new core tests for `checkPricingFreshness`.

### Patch Changes

- Updated dependencies [286f132]
  - @llm-ports/core@0.1.0-alpha.9

## 0.1.0-alpha.8

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

- b00ff65: New native Google Gemini adapter (closes issue #14). Built on the unified `@google/genai` SDK (v2.x).

  **What it does that OpenAI-compat baseURL doesn't:**
  - Full multimodal: image content blocks pass through as `inlineData` (base64) or `fileData` (URL), NOT degraded to text placeholders.
  - Native `systemInstruction` as a top-level field instead of prepended user message (preserves Gemini's intended behavior).
  - Bundled pricing for Gemini 2.5 (pro / flash / flash-lite) and Gemini 2.0 (flash / flash-lite). Compat-baseURL users had to supply their own.
  - Image-block boundary validation (size + URL scheme) wired in alpha.5, consistent with adapter-anthropic and adapter-openai.

  **v0.1 alpha scope:**
  - `generateText` — full
  - `generateStructured` — prompted JSON + Zod + alpha.5 repair pass. (Native `responseSchema` constrained-decoding lands in v0.2.)
  - `streamText` / `streamStructured` — full
  - `runAgent` — single-turn shim (multi-turn native function-calling lands in v0.2, matching adapter-vercel's v0.1 shape)

  **Out of scope for v0.1 (each filed for v0.2):**
  - Embeddings (`gemini-embedding-001`)
  - Explicit context caching (Gemini's `cachedContent`)
  - Code execution tool (built-in code interpreter)

  **Install:**

  ```bash
  pnpm add @llm-ports/core @llm-ports/adapter-google @google/genai zod
  ```

  19 content-translation tests + 12 contract conformance tests.

### Patch Changes

- Updated dependencies [b00ff65]
- Updated dependencies [b00ff65]
- Updated dependencies [b00ff65]
  - @llm-ports/core@0.1.0-alpha.5
