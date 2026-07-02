# @llm-ports/capabilities

## 0.1.0-alpha.26

### Patch Changes

- Alpha.26 — API unification (canonical `messages` input). **BREAKING in alpha.27** — this release adds the canonical shape alongside the deprecated fields; alpha.27 removes the deprecated fields.

  **The change.** The four generation methods (`generateText` / `generateStructured` / `streamText` / `streamStructured`) now accept a canonical `messages: LLMMessage[]` input, aligning with `runAgent`'s existing shape and every provider's native protocol. The legacy `{ instructions, prompt }` shape is `@deprecated` and will be removed in alpha.27.

  ```ts
  // Before (alpha.25 and earlier)
  port.generateText({
    taskType: "triage",
    instructions: SYSTEM_PROMPT,
    prompt: userInput,
  });

  // After (alpha.26 mechanical, via shim — one-line change per site)
  import { toMessages } from "@llm-ports/core";
  port.generateText({
    taskType: "triage",
    messages: toMessages(SYSTEM_PROMPT, userInput),
  });

  // After (alpha.26 idiomatic, via helpers)
  import { sys, usr } from "@llm-ports/core";
  port.generateText({
    taskType: "triage",
    messages: [sys(SYSTEM_PROMPT), usr(userInput)],
  });

  // After (alpha.26 native multi-turn — previously unavailable)
  port.generateStructured({
    taskType: "interview-turn",
    schema: InterviewTurnSchema,
    messages: conversationHistory, // full context with alternating roles
  });
  ```

  **Why.** Every provider's actual API speaks `messages: Message[]` natively. The `{ instructions, prompt }` compression was a defensible design when most calls were single-turn, but consumers with multi-turn workloads (chat, interview agents, coaching workflows) had three bad workarounds — roll history into a `prompt` string (loses role fidelity), abuse `runAgent` with `tools: {}` (semantically broken), or reach past the port via `providerExtras` (kills the abstraction). None acceptable. Aligning the port with the underlying protocol fixes this and matches `runAgent`'s existing shape.

  **Migration shim + convenience helpers.** Ship in `@llm-ports/core`:
  - `toMessages(instructions?, prompt): LLMMessage[]` — mechanical migration for the legacy shape.
  - `sys(content: string): LLMMessage` — idiomatic system message constructor.
  - `usr(content: MessageContent): LLMMessage` — idiomatic user message constructor.

  **Four new errors** exported from `@llm-ports/core`:
  - `MessagesRequiredError` — neither `messages` nor `prompt` supplied.
  - `EmptyMessagesError` — `messages` array is empty.
  - `MessagesConflictError` — both `messages` AND legacy fields supplied (ambiguity is a caller bug).
  - `PromptRequiredError` — `toMessages()` called with no prompt.

  **Deprecation warning UX.** Single-line `console.warn` per method per Registry when the legacy shape is used. Method-only dedup — a consumer with 50 legacy call sites across all four methods gets 4 warnings total (one per method), enough signal to trigger a migration audit without flooding logs.

  Opt out for mid-migration:

  ```ts
  const registry = createRegistryFromEnv({
    suppressDeprecationWarnings: true, // alpha.26+; removed in alpha.27
  });
  ```

  Structured logging:

  ```ts
  const registry = createRegistryFromEnv({
    deprecationWarningHandler: (msg) => logger.warn({ deprecation: true, msg }),
  });
  ```

  **Registry-side normalization.** The `RegistryPort` normalizes both shapes before adapter dispatch: canonical → pass-through; legacy → synthesize `messages = toMessages(instructions, prompt)` + emit deduped warning. The adapter always sees `options.messages` after normalization.

  **Adapter changes.** `adapter-openai` reads from `options.messages` when set (Registry-normalized path), with a graceful fallback to `{ instructions, prompt }` for consumers that bypass the Registry and call the adapter directly. System-role messages at the start of the array are extracted and concatenated as `instructions` for consistent per-provider handling. Non-contiguous system messages pass through inline (OpenAI supports them as boundary markers).

  **runAgent unchanged.** It already accepted `messages`. Consumers using `runAgent` see zero migration impact.

  **Test coverage.** 881 tests pass across the workspace (was 864 at alpha.25; +17; zero regressions):
  - Helper + shim tests (toMessages, sys, usr, error paths)
  - Canonical messages-flow tests (Registry → adapter passing verbatim)
  - Legacy-path tests (deprecation warning fires, dedups, respects suppression)
  - Error-path tests (all four new errors)
  - All existing alpha.25 tests continue to pass unchanged

  **Timeline.**
  - **alpha.26** (this release): both shapes work. Deprecation warnings on legacy.
  - **alpha.27** (~2 weeks): legacy fields removed. TypeScript compilation error if consumers haven't migrated.

  See the [alpha.25 → alpha.26 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-25-to-alpha-26.md) for full details, worked examples for all four methods, and the FAQ.

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.26

## 0.1.0-alpha.25

### Patch Changes

- Alpha.25 — Observability surface + reliability hardening. Three additive features, zero breaking changes.

  **1. `refs?: Record<string, ArtifactRef>` on every call (issue #53).** A consumer-owned, keyed map of artifact references that flows through to every observability event (`onCost`, `onTokenUsage`, `onFallback`, `onCacheHit`, `onValidationRetry`) unchanged. Perfect for prompt versioning, cost attribution by tenant / project / experiment / session, or any versioned-artifact identity you want stamped onto trace. Not validated, not sent to the model, not read by adapters — pure trace metadata.

  ```ts
  import type { ArtifactRef } from "@llm-ports/core";
  port.generateStructured({
    taskType: "extract",
    prompt: input,
    schema: MySchema,
    refs: {
      prompt: { key: "extractor-v3", version: 3, hash: "sha256:..." },
      tenant: { key: "acme-corp" },
      session: { key: "sess-abc123" },
    },
  });
  ```

  **2. `runtimeFallback: "aggressive"` preset (issue #54, LP-REQ-01).** The opinionated classifier three consumers rebuilt by hand (BEPA Plan 29, HomeSignal, SalesCoach Plan 30). Walks the chain on `RateLimitError`, `EmptyResponseError`, `ContextWindowExceededError`, `BadRequestError` matching credit-exhaustion body patterns, and raw 5xx status codes — in addition to the default `ProviderUnavailableError`. Does NOT walk on `AuthenticationError`, generic `BadRequestError`, or `ContentPolicyViolationError`. Exports `aggressiveShouldFallback` and `AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS` for reuse.

  ```ts
  const registry = createRegistryFromEnv({
    adapters: {
      /* ... */
    },
    runtimeFallback: "aggressive", // NEW
  });
  ```

  **3. Streamed cost surfacing (issue #55).** `onCost` and `onTokenUsage` now fire once per stream at natural completion for `streamText` and `streamStructured`. Adapter-openai enables it by default via `stream_options: { include_usage: true }`; opt out with `createOpenAIAdapter({ streamUsage: false })` on compat providers that reject the field. Mid-stream errors and consumer-cancelled streams (via `AbortSignal`) do NOT emit — matches the "cost recorded only on success" contract. Other adapters follow in patch releases.

  **Test coverage.** 864 tests pass across the workspace (was 828; +36; zero regressions):
  - 8 refs tests
  - 23 aggressive-fallback tests (positive + negative per error class + Registry integration)
  - 5 streamed-cost tests

  **Alpha.26 planning.** The next release will be a **BREAKING API unification**: the four generation methods (`generateText` / `generateStructured` / `streamText` / `streamStructured`) will move from `{ instructions, prompt }` to a canonical `messages: LLMMessage[]` input. A `toMessages()` migration shim lands in alpha.26; removal in alpha.27. See the alpha.26 planning discussion for the full plan.

  See the [alpha.24 → alpha.25 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-24-to-alpha-25.md) for full details.

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.25

## 0.1.0-alpha.24

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.24

## 0.1.0-alpha.23

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.23

## 0.1.0-alpha.21

### Minor Changes

- The five structured-output capability factories (`createClassifier`, `createScorer`, `createExtractor`, `createAnalyzer`, `createPlanner`) now accept and forward an optional per-call `strict?: boolean` to the underlying `LLMPort.generateStructured` call.

  ```ts
  const classify = createClassifier({ port, schema: ClosedShape, schemaName: "intent" });

  // Force strict mode for this call (e.g. because the operator knows the
  // schema is closed and the adapter's default is json_object).
  const result = await classify({ content: "...", strict: true });
  ```

  `createSummarizer` and `createDrafter` are NOT updated because they call `generateText`, not `generateStructured` — strict mode is a structured-output concept and would be a no-op there.

  Same precedence as the core port surface: per-call > adapter-level > auto-detect. Adapters that don't implement strict mode silently ignore the hint.

  See llm-ports#46 and the alpha.21 `@llm-ports/core` changelog entry.

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.21

## 0.1.0-alpha.20.1

### Patch Changes

- No code change. Version bump for workspace alignment with the alpha.20.1 migration-safeguards release.

## 0.1.0-alpha.20

### Minor Changes

- No behavior change. `budgetScope` flows through to the underlying port call because capabilities forward all per-call options; documenting the alpha.20 plumbing here. Version bump for workspace alignment.

## 0.1.0-alpha.19.1

### Patch Changes

- Plumb `cacheControl` through all 7 capability factories (createClassifier, createScorer, createExtractor, createDrafter, createSummarizer, createAnalyzer, createPlanner). Each accepts `cacheControl?: CacheControl` on its per-call input and forwards it to the underlying `port.generateStructured` / `port.generateText` call. `CapabilityEvent.cost.cacheSavingsUSD` propagated on `onResult`. 11 new tests in tests/cache-control-passthrough.test.ts.

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

### Patch Changes

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

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.17

## 0.1.0-alpha.16

### Minor Changes

- Add `providerExtras?: Record<string, unknown>` to all 5 `*Options` interfaces. Per-call escape hatch for provider-specific request fields the port doesn't model. Shallow-merged into the SDK request body **after** the typed port fields, so callers can override the typed defaults.

  ```ts
  // vLLM serving Qwen3-Reasoning — engage thinking via chat_template_kwargs
  const vllm = createOpenAIAdapter({
    apiKey: "EMPTY",
    baseURL: "http://localhost:8000/v1",
    displayName: "vllm",
  });
  const port = vllm.createLLMPort("Qwen/Qwen3-235B-A22B-Thinking", "vllm");

  const result = await port.generateText({
    taskType: "complex-reasoning",
    prompt: "Solve this step by step: ...",
    providerExtras: {
      chat_template_kwargs: { enable_thinking: true },
    },
  });
  ```

  **Common patterns the field unlocks:**
  - vLLM `chat_template_kwargs` (Qwen3 `enable_thinking`, DeepSeek `thinking`)
  - vLLM guided decoding (`guided_json`, `guided_grammar`, `guided_regex`)
  - SGLang structured output (`regex`, `ebnf`, `choices`)
  - Together AI / Fireworks knobs (`repetition_penalty`, `prompt_truncate_len`, `top_a`, `mirostat_tau`)

  **Threaded through every call shape AND every capability factory.** All 5 port methods (`generateText`, `generateStructured`, `streamText`, `streamStructured`, `runAgent`) and all 7 capability factories (`createClassifier`, `createScorer`, `createExtractor`, `createPlanner`, `createAnalyzer`, `createDrafter`, `createSummarizer`) propagate `providerExtras` from per-call input to the underlying port call.

  **Vendor-neutral by design.** Chose `providerExtras` over `chatTemplateKwargs` (vLLM-specific) or `providerOptions: { vllm: {...} }` (redundant — our adapter is already per-provider). The library doesn't endorse any one OSS-serving runtime in the public type signature; worked examples in `docs/adapters/openai.md` cover vLLM AND SGLang.

  **Caller-overridable typed fields.** Position matters: `providerExtras` shallow-merges AFTER typed fields like `reasoning_effort`, `response_format`, `tools`. So a caller passing `{ providerExtras: { reasoning_effort: "high" } }` along with `reasoningEffort: "low"` ends up with `reasoning_effort: "high"` on the wire (escape hatch wins). The port does not validate `providerExtras` values; field semantics are provider-specific.

  15 new tests (6 adapter-openai quirks + 9 capability passthrough); 567 tests passing across the workspace.

  Addresses the gap for frontier OSS models served via vLLM (Qwen3-Reasoning, DeepSeek-V3.2, Llama 4 Reasoning, gpt-oss-120b) and SGLang where per-model template variables gate reasoning behavior that the cross-provider port surface intentionally doesn't model. Closes the alpha.16 design ticket.

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.16

## 0.1.0-alpha.13

### Minor Changes

- 7c27b2d: Capability factories now thread `reasoningEffort` (per-factory) and `signal` / `forceProviderAlias` (per-call) through to the underlying `port.generateStructured` / `port.generateText` call. Closes a real gap discovered after alpha.12: `createScorer({ reasoningEffort: "high" })` silently dropped the option because the factory didn't pass it through.

  **Per-factory** (set once at `Create*Config`, applies to every call):

  ```ts
  const score = createScorer({
    port,
    schema: ScoreSchema,
    schemaName: "lead-score",
    rubric,
    reasoningEffort: "high", // ← new in alpha.13
  });
  ```

  **Per-call** (passed in the input arg, varies per invocation):

  ```ts
  const controller = new AbortController();
  const result = await score({
    content: "...",
    signal: controller.signal, // ← new in alpha.13
    forceProviderAlias: "expensive", // ← new in alpha.13
  });
  ```

  All 7 factories updated: `createClassifier`, `createScorer`, `createExtractor`, `createPlanner`, `createAnalyzer`, `createDrafter`, `createSummarizer`. 13 new tests in `capability-passthrough.test.ts`.

  ### `attemptValidationRepair` — two new patterns + expanded enum decorator handling

  Pattern 5 (enum case-mismatch) now strips a wider range of LLM-output decorators before normalizing:
  - Markdown bold/italic: `"**low**"`, `"__low__"`, `"*low*"`, `"_low_"` → `"low"`
  - Code fences: ``"`low`"`` → `"low"`
  - Wrapping quotes: `'"low"'`, `"'low'"` → `"low"`
  - Trailing punctuation: `"Low."`, `"HIGH!"`, `"medium,"` → `"low"` / `"high"` / `"medium"`
  - Compound: `"**LOW**."` → `"low"` (strip-loop iterates until stable)

  Pattern 7 (NEW): stringified JSON where object/array expected. When the model double-encodes a nested field (`reasoning: "{\"experience\": ...}"` for an `object`-typed slot), the repair pass now `JSON.parse`s it once — but only if the string both starts/ends with `{}` (or `[]`) AND parses cleanly into the expected shape. No risk of garbage substitution on plain prose.

  Pattern 8 (NEW): array-with-single-object where object expected. `person: [{ name: "X" }]` for an `object`-typed `person` slot → unwrap to `{ name: "X" }`. Skipped for multi-element arrays (ambiguous).

  11 new repair-validation tests; total repair test count 29.

  ### Test totals

  537 tests passing across the workspace (was 508).

  ### Closes
  - BEPA-internal `TD-LLMPORTS-CAPABILITIES-REASONING-EFFORT`

### Patch Changes

- Updated dependencies [7c27b2d]
  - @llm-ports/core@0.1.0-alpha.13

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies [1d78426]
  - @llm-ports/core@0.1.0-alpha.12

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies [286f132]
  - @llm-ports/core@0.1.0-alpha.9

## 0.1.0-alpha.7

### Patch Changes

- Updated dependencies [c805169]
  - @llm-ports/core@0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- Updated dependencies [34cd6cd]
  - @llm-ports/core@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies [b00ff65]
- Updated dependencies [b00ff65]
- Updated dependencies [b00ff65]
  - @llm-ports/core@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- Updated dependencies [f0885e6]
  - @llm-ports/core@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- Updated dependencies [fbbd507]
  - @llm-ports/core@0.1.0-alpha.3

## 0.1.0-alpha.1

### Patch Changes

- Docs: surface the implicit task types used by capability factories. Each factory (`createClassifier`, `createScorer`, `createDrafter`, `createSummarizer`, `createExtractor`, `createPlanner`, `createAnalyzer`) defaults to a specific `taskType` (`classify`, `score`, `draft`, ...). If your `.env` only declares a single `LLM_TASK_ROUTE_*` entry and you call a capability without overriding `taskType`, the registry throws `NoProvidersAvailableError`. The getting-started guide now shows the catch-all pattern (`LLM_TASK_ROUTE_GENERAL=fast,smart`), and the task-routing concept page documents per-capability defaults and how to override them. No API change — the `taskType?: string` config option already existed. Closes #6.
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
