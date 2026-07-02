# @llm-ports/adapter-openai

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

### Minor Changes

- Catalog architectural redesign + Cerebras pricing. The catalog stops being load-bearing for correctness.

  ## Behavioral fingerprinting (the architectural fix)

  `createOpenAIAdapter({ fingerprintCache })` — opt-in cross-process cache that skips the first-call discovery penalty for reasoning models without static catalog entries. Bundled backends:
  - `InMemoryFingerprintCache` — Map; lifetime is the current process
  - `FileFingerprintCache(path)` — atomic JSON file; survives restarts
  - Bring-your-own backend (Redis, S3, KV) via the `FingerprintCacheBackend` interface

  Every successful response is inspected for reasoning signals and written to the cache for free. On port creation for a known model, the cache is read and the learner is seeded. The four CoT field conventions from the [June 2026 reasoning-model survey](https://github.com/baabakk/llm-ports/blob/main/docs/research/reasoning-models-survey-2026-06.md) are all caught:
  - `usage.completion_tokens_details.reasoning_tokens` → OpenAI native
  - `message.reasoning` → Cerebras, Groq, SambaNova
  - `message.reasoning_content` → DeepInfra, Parasail (vLLM substrate)
  - `<think>...</think>` inline in `content` → legacy R1 distills

  Standalone helper `fingerprintModel(client, modelId)` for CI warm-starts.

  ## Catalog freeze policy

  `KNOWN_REASONING_MODELS` docstring rewritten to make the optimization-only framing explicit. The catalog is now FROZEN — new reasoning models are caught by runtime detection (alpha.22, correctness) or the fingerprint cache (alpha.24, performance). PRs adding regex entries no longer accepted.

  Existing entries (OpenAI o-series, gpt-5-nano, gpt-oss family, Qwen3.6, MiniMax-M2.7, MiMo-V) stay — they capture the stable production families with no false positives.

  ## Cerebras pricing entries

  Two production models added to `OPENAI_PRICING`:
  - `gpt-oss-120b`: $0.35 / $0.75 per 1M (HIGH confidence — primary docs)
  - `zai-glm-4.7`: $2.25 / $2.75 per 1M (MEDIUM confidence — third-party only; Cerebras's model page redirects pricing to a generic page)

  Cerebras's catalog has shrunk; the previous Qwen3-235B/32B, Llama-3.1/3.3, DeepSeek-R1-distill, Llama-4-Scout entries are 404 as of June 2026.

  ## Public API additions

  ```ts
  export {
    buildFingerprintKey,
    fingerprintModel,
    FileFingerprintCache,
    InMemoryFingerprintCache,
    inspectResponseForFingerprint,
    normalizeModelId, // promoted from internal
    parseHarmonyToolCalls, // promoted from internal
    type FingerprintCacheBackend,
    type ModelFingerprint,
  } from "@llm-ports/adapter-openai";
  ```

  ## Tests
  - 25 new fingerprint tests (analyzer + 2 backends + adapter integration + error swallowing)
  - 2 new Cerebras pricing tests
  - 247 adapter-openai tests total (was 220; +27, 0 regressions)

  ## Backwards compatibility

  All changes additive. When `fingerprintCache` is undefined (default), the adapter behaves identically to alpha.23. The catalog still pre-seeds the existing well-known cases.

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.24

## 0.1.0-alpha.23

### Minor Changes

- Three additions, all empirically grounded in ADW's 2026-06-19 multi-team agentic-build-loop diagnostic. Together they address the two failure modes the diagnostic surfaced (harmony tool-call mis-channeling on DeepInfra-served gpt-oss; prose-only responses with tools available on mimo-parasail and similar) at the adapter layer.

  ## ASK 1 — Harmony tool-call extraction

  `parseHarmonyToolCalls(reasoningContent)` extracts one or more tool calls from a harmony-formatted `message.reasoning_content` string. Wired into `fromOpenAIAssistantMessage` (now accepts `reasoning_content`) and `runAgent` (now forwards the field). When the standard `tool_calls` array is empty AND `reasoning_content` contains a parseable harmony tool call, the call is hoisted into the executable path with zero extra LLM calls.

  **Closes the DeepInfra gpt-oss harmony tool-use gap that alpha.22 left open.** Pre-alpha.23, runAgent treated harmony tool intent in `reasoning_content` as an empty assistant turn and terminated. Post-alpha.23, the tool call executes the same as a standard one.

  **Returns null gracefully** when reasoning_content is empty, prose chain-of-thought, bare JSON without a tool name (the empirical "{path: '', depth: 3}" probe case), or contains malformed JSON inside a harmony marker. The zero-tool-call rescue (ASK 2) handles the prose-only case via a corrective retry.

  Emits `onRetry` with reason `"harmony-tool-call-extracted"` on success for observability.

  ## ASK 2 — Zero-tool-call corrective rescue

  When the model returns a clean completion (`finish_reason: "stop"` or `"length"`) with prose content, empty `tool_calls`, and the request had a tools array — the adapter retries once with a corrective system message asking the model to use the standard tool_calls format rather than describing intent in prose.

  **Closes the mimo-parasail prose case from ADW's diagnostic.** Pre-alpha.23, mimo returned ~69 tokens of prose with zero tool_calls, runAgent terminated as `completed`, ADW orchestration promoted empty stubs to main. Post-alpha.23, the rescue gives the model one corrective shot before termination.

  **Discriminators prevent over-firing:**
  - No tools in request → text response is the correct shape; skip
  - `tool_calls` populated → standard tool-use success; skip
  - Empty content → reasoning starvation case; handled by `reasoningStarvedResponse`
  - `reasoning_content` populated → harmony case; handled by ASK 1 above
  - `req.messages` includes a `tool` role message → the model is summarizing tool results, not failing to call tools; skip

  Single-shot retry only. If the rescue also returns prose, the consumer's orchestration is responsible for handling it (e.g., comparing planned-file-list against actual-written at the workflow level).

  Emits `onRetry` with reason `"zero-tool-call-prose-retry"` for observability.

  ## ASK 3 — Telemetry tags

  The two new retry reasons (`"harmony-tool-call-extracted"` and `"zero-tool-call-prose-retry"`) are added to `@llm-ports/core`'s `RetryReason` union. Consumers can filter the existing `onRetry` hook on these values to distinguish "was rescued via harmony extraction" vs "was rescued via prose corrective retry" vs "clean zero-output (failover candidate)".

  ## Tests
  - 13 new tests for ASK 1 (harmony extraction across all parser branches + runAgent integration + telemetry emission)
  - 8 new tests for ASK 2 (rescue fires correctly + 5 discriminator regression guards + single-shot guarantee + telemetry emission)
  - 220 adapter-openai tests total (was 199; +21, 0 regressions in the other 18 quirks suites)

  ## What this does NOT fix

  The Case B "under-production" pattern (model makes some tool calls then stops with the planned manifest incomplete) is not addressed by the adapter. The adapter sees a clean multi-call completion; only the orchestration knows the manifest is incomplete. ADW (and similar agentic orchestrators) should add a "planned ≠ written" guard at the workflow layer.

  ## Empirical sources
  - ADW Development_Logs.md commit b1eeee2 — DeepInfra harmony tool-use diagnostic
  - ADW production wedge incident 2026-06-19T15:40 UTC — mimo silent prose-only completion
  - Babak's raw 2-turn DeepInfra probe — empirical evidence of the `reasoning_content` shape
  - llm-ports#46 / discussion #50 — design discussion

  ## Backwards compatibility

  All three additions are additive. Existing callers see no API surface changes. Pre-existing tests that mocked one response and expected the loop to terminate-as-completed on prose now receive the rescue retry's request too — three tests across two existing files updated to use `mockResolvedValue` (instead of `mockResolvedValueOnce`) so the rescue retry has a target. Test intent (schema conversion correctness; termination logic) preserved.

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.23

## 0.1.0-alpha.22

### Minor Changes

- Reasoning-model architecture cleanup: model-ID normalization + runtime detection broadening. Both changes are additive (no breaking changes); together they make the catalog stop needing per-(model × provider) regex variants and let runtime detection catch provider-specific response shapes the previous narrow assumptions missed.

  ## Why this exists (one-paragraph backstory)

  ADW's 2026-06-19 instrumentation of the multi-team agentic build loop discovered that DeepInfra-hosted `gpt-oss-120b` was silently failing as a reasoning model in alpha.21. Two root causes:
  1. The catalog pattern `/^gpt-oss-/i` is anchored at `^` and can't match the namespaced model ID `openai/gpt-oss-120b` (DeepInfra prefixes provider/owner). The model isn't recognized as reasoning → budget multiplier isn't applied → first call starves on hidden chain-of-thought.
  2. Runtime detection requires `finish_reason === "length"` and looks at `message.reasoning` only. DeepInfra's gpt-oss serving returns `finish_reason: "stop"` and exposes the harmony channel as `message.reasoning_content` (different field name). Both safety nets miss the failure.

  The fix isn't another regex — that's catalog-debt-by-another-name. The fix is architectural: normalize model IDs to canonical names before catalog/learner lookup, and broaden runtime detection to handle the response-shape variance.

  ## What changed

  ### 1. Model-ID normalization

  New `normalizeModelId(modelId)` helper in `capabilities.ts`: strips a provider/namespace prefix, returning the canonical name (the substring after the last `/`). Model IDs without `/` pass through unchanged.

  Examples:
  - `gpt-oss-120b` → `gpt-oss-120b` (OpenAI-native; unchanged)
  - `openai/gpt-oss-120b` → `gpt-oss-120b` (DeepInfra/Groq form)
  - `deepseek-ai/DeepSeek-V4-Flash` → `DeepSeek-V4-Flash`
  - `XiaomiMiMo/MiMo-V2.5` → `MiMo-V2.5` (Parasail form)
  - `google/gemma-4-31B-it` → `gemma-4-31B-it`

  Every internal call to the capability learner (`seedKnownConstraints`, `getEffectiveCapabilities`, `rememberConstraint`) normalizes the model ID first. The catalog's anchored patterns (`/^gpt-oss-/i`, `/^qwen3[._-]?6/i`, `/^minimax[-_]?m2[._]7/i`, etc.) now correctly match the canonical name regardless of which provider serves it.

  The raw model ID is still used in SDK request bodies — DeepInfra expects `openai/gpt-oss-120b`, not `gpt-oss-120b`. Normalization is scoped to the capability-learning layer only.

  **Architectural payoff:** the same canonical model served by two providers (Cerebras `gpt-oss-120b` and DeepInfra `openai/gpt-oss-120b`) now shares learned state. A constraint learned at runtime for one is visible to the other.

  ### 2. Broadened runtime reasoning detection

  `learnFromResponse` now reads three reasoning signals (was two):
  - `usage.completion_tokens_details.reasoning_tokens > 0` (existing — OpenAI o-series, gpt-5-nano)
  - `choices[0].message.reasoning` populated (existing — Cerebras gpt-oss-\*)
  - `choices[0].message.reasoning_content` populated (NEW — DeepInfra harmony serving)

  `reasoningStarvedResponse` relaxes the `finish_reason` guard:
  - Pre-alpha.22: required `finish_reason === "length"` (OpenAI native + Cerebras pattern)
  - Post-alpha.22: accepts `length` OR `stop` (DeepInfra's gpt-oss harmony returns `stop`)

  The starvation discriminator is now "empty visible output (no content, no executable tool_calls) AND any reasoning signal AND finish was either length or stop." This catches the empirical DeepInfra-gpt-oss pattern without false-positiving on models that legitimately finish with stop.

  `reasoningStarvedResponse` also now checks `message.tool_calls`: if the model emitted executable tool calls, the response is NOT starved (even if `content` is empty), regardless of reasoning signal. Genuine tool-use successes are not retried.

  ## What this DOES NOT do

  The DeepInfra-served gpt-oss tool-use case is not fully fixed by this release. Even with the budget correct and starvation observable, the tool-call intent lands in `message.reasoning_content` rather than `message.tool_calls`. Until the adapter parses the harmony channel for tool calls (a separate research-first workstream), `runAgent` against DeepInfra-served gpt-oss still won't execute the model's intended tool calls. **For tool-use workloads against gpt-oss, route to Cerebras.** This will be addressed in a future release after harmony-format research; tracked in a follow-up issue.

  ## Backwards compatibility

  All changes are additive at the call-site level. The normalized-vs-raw model ID distinction is internal to the capability-learning layer; SDK requests continue to use raw IDs. Existing tests against OpenAI-native and Cerebras-served model IDs pass unchanged (197 adapter-openai tests, 0 regressions).

  ## Tests

  22 new tests:
  - 15 model-ID normalization tests (including namespace stripping for each provider variant, catalog matching with normalized IDs, shared learner state across canonical-equivalent IDs, user-supplied capability precedence)
  - 7 runtime detection broadened tests (DeepInfra harmony shape recognition, finish=stop rescue, OpenAI o-series regression, no-spurious-rescue regressions)

  Plus a new mock-SDK helper `buildDeepInfraHarmonyResponse` that mirrors ADW's empirically-captured DeepInfra gpt-oss response shape.

  ## Empirical motivation
  - ADW Development_Logs.md commit b1eeee2 — code-grounded root cause of the deepseek + gpt-oss DeepInfra tool-loop failures
  - Raw 2-turn DeepInfra probe (2026-06-19): `finish: "stop"`, `content: ""`, `tool_calls: []`, `reasoning_content: "{\"path\":\"\",\"depth\":3}\n"`
  - See llm-ports#46 / discussion #49 for the architectural critique that drove the design

## 0.1.0-alpha.21

### Minor Changes

- Three additions, all empirically grounded in ADW's 2026-06-18 Structured-Output Reliability report:

  ## 1. Per-call `strict?: boolean` plumbing

  `generateStructured` and `streamStructured` now honor a per-call `strict?: boolean` from `GenerateStructuredOptions` / `StreamStructuredOptions`. Precedence:
  1. `options.strict` (per-call; highest)
  2. `ctx.useStrictResponseFormat` (adapter-level, set at construction)
  3. `autoDetectStrictResponseFormat(baseURL)` (default applied to step 2 if the user didn't supply `useStrictResponseFormat`)

  Adapters across other packages either honor or silently ignore the per-call field (matching the type contract on `@llm-ports/core`). See llm-ports#46.

  ## 2. Strict-mode allowlist extended to DeepInfra + Parasail

  `autoDetectStrictResponseFormat` now defaults strict ON for `api.deepinfra.com` and `api.parasail.io` baseURLs, joining the existing list (OpenAI native, Cerebras, Groq, SambaNova).

  Empirical verification (2026-06-18, 8 calls per provider on the same flat schema):

  | Provider                 | `json_object` (alpha.20.1 default)  | strict (alpha.21 default) |
  | ------------------------ | ----------------------------------- | ------------------------- |
  | DeepInfra deepseek-flash | 2 validation retries / 8            | 0 retries / 8             |
  | DeepInfra gemma-31b      | **8/8 retries** (one on every call) | 0 retries / 8             |
  | Parasail mimo            | 3 validation retries / 8            | 0 retries / 8             |

  See llm-ports#47.

  ## 3. Three new bundled pricing entries

  `OPENAI_PRICING` now includes three compat-provider models in active production use against the verified-OK provider matrix:
  - `deepseek-ai/DeepSeek-V4-Flash` ($0.10 / $0.20 per 1M tokens; DeepInfra)
  - `google/gemma-4-31B-it` ($0.10 / $0.20 per 1M tokens; DeepInfra)
  - `XiaomiMiMo/MiMo-V2.5` ($0.14 / $0.28 per 1M tokens; Parasail)

  Consumers using these models against the OpenAI-compat adapter no longer need to maintain a parallel `pricingOverrides` table for them. Neither DeepInfra nor Parasail publishes a discounted cache-read tier today; the `cacheReadPer1M` field is intentionally omitted.

  See llm-ports#48.

  ## Backwards compatibility

  All three changes are additive. Existing adapters constructed against allowlisted baseURLs (OpenAI native, Cerebras, Groq, SambaNova) behave identically. Adapters explicitly opting OUT via `useStrictResponseFormat: false` are unchanged. Pricing additions are pure-additive; no override behavior changes.

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

- No behavior change. Documented that all CacheControl modes are no-ops on OpenAI: the implicit prompt cache is always on with no API to influence it. Forward-compatible: callers can write against the shape today; OpenAI-compat providers (Cerebras, Groq, etc.) inherit the same documented no-op behavior. Version bump for workspace alignment.

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

## 0.1.0-alpha.15

### Minor Changes

- e1cd8c5: `useStrictResponseFormat` auto-detect extended to SambaNova (`api.sambanova.ai`). Empirically verified — MiniMax-M2.7 with strict mode forced on jumped from **0/10 → 10/10** schema-valid on a nested production scoring schema (BEPA A/B harness, 2026-05-27).

  ## What changed

  Single-line addition to `autoDetectStrictResponseFormat`:

  ```ts
  if (baseURL.includes("api.sambanova.ai")) return true;
  ```

  Default for SambaNova users:

  | Before alpha.15                                           | After alpha.15                                 |
  | --------------------------------------------------------- | ---------------------------------------------- |
  | `useStrictResponseFormat: false` (must opt in explicitly) | `useStrictResponseFormat: true` (auto-enabled) |

  ## Why

  A BEPA A/B probe forced `useStrictResponseFormat: true` on a SambaNova adapter pointed at MiniMax-M2.7 and re-ran the same 10-job nested-schema test that produced 0/10 in alpha.13. Result: **10/10 schema-valid, 3987ms avg latency, $0.041 total cost across 10 calls.** SambaNova accepts strict `response_format: json_schema` and constrains decoding properly — the documentation was just silent about it.

  Without the auto-detect, every SambaNova user with a non-trivial nested schema sees the same broken-by-default pattern OpenAI native users saw before alpha.14: invented enum values, flat strings where objects expected, retry-with-feedback tax on every call.

  ## Breaking change for what

  Users whose Zod schemas use **open shapes** that can't accept `additionalProperties: false` (`z.record(...)`, model-extends-allowed schemas) on a SambaNova adapter will hit the rejection. Opt out:

  ```ts
  const sambanova = createOpenAIAdapter({
    apiKey: process.env.SAMBANOVA_API_KEY!,
    baseURL: "https://api.sambanova.ai/v1",
    useStrictResponseFormat: false, // opt out
  });
  ```

  Runtime capability learning also catches the rejection: `jsonModeUnsupported: true` is remembered after the first 400.

  ## Tests

  1 flipped entry in the `autoDetectStrictResponseFormat` `it.each` matrix (SambaNova flipped from `false` → `true`); 1 new integration test (SambaNova auto-enables in adapter construction); 1 new "stays opt-in" coverage replaced with Together AI as the new unknown-compat exemplar. 144 adapter-openai tests passing.

  ## Closes
  - BEPA-internal `TD-APPLICATIONS-SCORING-SCHEMA-STRICT-MULTIPROVIDER` sub-task 3 (SambaNova strict-mode probe). Sub-task 1 (OpenAI native + Groq) was closed by alpha.14. Sub-task 2 (Anthropic structured-output discipline) is structural library work that lands in v0.2.

  ## Discovered by

  BEPA Upwork-scoring A/B harness re-run with explicit `useStrictResponseFormat: true` override on SambaNova, 2026-05-27. Probe script: `scripts/upwork-ab-test.ts`.

## 0.1.0-alpha.14

### Minor Changes

- da17ec8: `useStrictResponseFormat` auto-detect expanded to OpenAI native + Groq. **Default behavior change**: `generateStructured` against OpenAI native (no `baseURL`) or Groq (`api.groq.com`) now uses strict `response_format: { type: "json_schema", strict: true }` instead of classic `{ type: "json_object" }`.

  ## Why

  A real BEPA A/B harness against 5 production models × 10 Upwork jobs showed only Cerebras gpt-oss-120b satisfied the (intentionally nested) BEPA scoring schema 100% of the time. OpenAI native `gpt5-4-nano` + `gpt5-5` returned 0/10 — `recommendation` came back as objects, scores got flattened to top-level keys, enum strings got invented. The fix was a one-line flag (`useStrictResponseFormat: true`) the users didn't know they needed.

  Generalizing: every llm-ports user calling `generateStructured` against OpenAI native or Groq with a non-trivial nested schema was silently paying a **2× cost + 2× latency** tax on retry-with-feedback rounds, because the default sent classic `json_object` mode. Strict json_schema mode has been GA on OpenAI's gpt-4o / gpt-5 / o-series since August 2024 and verified on Groq's `openai/gpt-oss-120b` per their docs. There is no scenario where the un-strict path produces better results on a well-formed schema.

  ## What auto-enables

  | Condition                                                                                           | Default in alpha.14+                                                    |
  | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
  | `baseURL` unset (OpenAI native)                                                                     | **`useStrictResponseFormat: true`**                                     |
  | `baseURL` contains `api.openai.com`                                                                 | **`useStrictResponseFormat: true`**                                     |
  | `baseURL` contains `api.cerebras.ai`                                                                | `useStrictResponseFormat: true` (existing — alpha.9)                    |
  | `baseURL` contains `api.groq.com`                                                                   | **`useStrictResponseFormat: true`**                                     |
  | `baseURL` contains anything else (SambaNova, Together, Fireworks, Clarifai, LiteLLM, Ollama compat) | `useStrictResponseFormat: false` (unchanged — set explicitly to enable) |

  ## Breaking change for what

  Users whose Zod schemas use **open shapes** that can't accept `additionalProperties: false`:
  - `z.record(...)`
  - Schemas where the model is allowed to add extra fields
  - Schemas with computed/optional sections

  These users will see strict-mode rejection from the provider on the first call after upgrade. **Opt out**: set `useStrictResponseFormat: false` explicitly:

  ```ts
  const adapter = createOpenAIAdapter({
    apiKey: process.env.OPENAI_API_KEY!,
    useStrictResponseFormat: false, // opt out of the new default
  });
  ```

  The adapter's runtime capability learning also catches the rejection — `jsonModeUnsupported: true` is remembered after the first 400 and subsequent calls fall back to prompted JSON. So even users who don't know about the opt-out will recover after one wasted round-trip.

  ## Bug fix bundled

  `learnConstraintsFromError` now also triggers `jsonMode: false` learning when a `response_format` rejection happens on the `strictResponseSchema` path (alpha.9 only triggered on the legacy `jsonMode: true` path). This means a model that rejects `response_format` of either kind now gets `jsonModeUnsupported: true` remembered after one failure, regardless of which `response_format` shape the adapter sent.

  ## Tests

  15 new tests (`autoDetectStrictResponseFormat` direct unit tests covering 10 baseURL shapes + 5 integration tests covering OpenAI native, Groq, Cerebras, SambaNova, opt-out). Total adapter-openai tests: 143 (up from 128). Total workspace: 552.

  ## New export

  `autoDetectStrictResponseFormat(baseURL: string | undefined): boolean` — the predicate, exported for users who build adapter instances programmatically and want to inherit the same default logic.

  ## Discovered by

  BEPA A/B harness on Upwork scoring (2026-05-26T20:45 -07:00). The harness file ([`scripts/upwork-ab-test.ts`](https://github.com/baabakk/BEPA)) is reusable; if you want to re-run it against any combination of llm-ports models, drop your model IDs in and `pnpm tsx scripts/upwork-ab-test.ts`. Pre-alpha.14: 1/5 models satisfied a non-trivial nested schema. Post-alpha.14: 3-4/5 expected.

## 0.1.0-alpha.13

### Patch Changes

- Updated dependencies [7c27b2d]
  - @llm-ports/core@0.1.0-alpha.13

## 0.1.0-alpha.12

### Minor Changes

- 1d78426: Add `reasoningEffort?: "low" | "medium" | "high"` to all 5 `*Options` interfaces. Forwarded as `reasoning_effort` on OpenAI-shape SDK calls.

  Applies to OpenAI native `o3` / `o4-mini` / `gpt-5-nano` / `gpt-5` and to OpenAI-compat providers that honor the parameter — notably **Groq's `openai/gpt-oss-120b`**, which gates reasoning quality on this knob without offering separate model IDs per effort level.

  ```ts
  const groq = createOpenAIAdapter({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
    displayName: "groq",
  });

  const port = registry.getPort();
  const result = await port.generateText({
    taskType: "complex-reasoning",
    prompt: "...",
    reasoningEffort: "high", // ← controls internal CoT depth
  });
  ```

  **Threaded through every call shape.** `generateText`, `generateStructured`, `streamText`, `streamStructured`, and `runAgent` (every loop step) all forward the field when set.

  **Silently ignored** by adapters whose providers don't honor it — adapter-anthropic, adapter-google, adapter-ollama, adapter-vercel. The call still succeeds at the provider's default effort level. No per-model gating in v0.1 for adapter-openai either: if a user sets `reasoningEffort` on a non-reasoning model and the provider doesn't accept it, the SDK call may reject — runtime capability learning (`jsonModeUnsupported`-style) would be the right reaction, but a v0.2 follow-up.

  5 new tests; 508 tests passing across the workspace.

  Closes BEPA-side tech debt `TD-LLMPORTS-REASONING-EFFORT`.

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

- 286f132: Add `useStrictResponseFormat` option for OpenAI / Cerebras strict JSON Schema mode.

  `generateStructured` can now emit `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }` instead of classic `response_format: { type: "json_object" }`. With strict mode the provider constrains decoding to the exact schema before tokens are produced, so invalid JSON or missing fields are impossible (modulo provider bugs).

  ```ts
  const adapter = createOpenAIAdapter({
    apiKey: process.env.CEREBRAS_API_KEY!,
    baseURL: "https://api.cerebras.ai/v1",
    useStrictResponseFormat: true,
  });
  ```

  **Auto-detection.** When `baseURL` contains `api.cerebras.ai` the flag enables itself, because Cerebras's gpt-oss / Qwen3.6 tiers silently ignore the classic `json_object` mode and require strict JSON Schema for reliable structured output. Set `useStrictResponseFormat: false` explicitly to override.

  **Schema conversion.** Zod schemas are translated via `zod-to-json-schema` (`target: "openAi"`, `$refStrategy: "none"`), then post-processed to add `additionalProperties: false` on every nested object — a hard requirement of strict mode that the SDK does not auto-inject.

  **Compatibility.** When omitted (and `baseURL` is not Cerebras), behavior is identical to alpha.8 — classic `json_object` mode. Models that don't support strict mode (and report it via the runtime-learning `jsonModeUnsupported` capability) still see the same fallback path.

  5 new unit tests.

### Patch Changes

- 286f132: Add `dangerouslyAllowBrowser?: boolean` option to `adapter-openai` and `adapter-anthropic` (closes [#32](https://github.com/baabakk/llm-ports/issues/32)).

  Both SDKs refuse to construct in a browser environment unless the flag is explicitly passed; the adapters now forward the option, unblocking BYO-key / proxy-token / trusted-internal-tool use cases. When the option is omitted (or `false`), the SDK constructor receives no `dangerouslyAllowBrowser` field — same as alpha.8 behavior, so server-side users see no change.

  `adapter-vercel` gets a README note pointing users at the `@ai-sdk/*` LanguageModel construction site, where the equivalent flag lives in that adapter's architecture.

  `adapter-google` and `adapter-ollama` are not affected: `@google/genai` runs in browsers by design; `adapter-ollama` is local-daemon and the browser concern is CORS at the daemon, not an SDK flag.

  5 new unit tests (3 for adapter-openai, 2 for adapter-anthropic).

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
