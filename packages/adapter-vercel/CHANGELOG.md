# @llm-ports/adapter-vercel

## 0.1.0-alpha.28

### Patch Changes

- Alpha.28 — Observability contract foundation + subprocess-driven agent adapters (Plan 58 §5.1).

  Alpha.28 is a **contract-foundation** release. It establishes the LLM observability data model as a standalone package that non-port callers can consume without pulling in the registry, wires the port surface to carry caller-supplied observability context, and mounts two subprocess-driven agent runtimes (codex, aider) behind the standard `LLMPort.runAgent` surface. Runtime instrumentation (adapters emitting events from live retry/fallback paths), streaming instrumentation, and persistence backends are deferred to alpha.29 → alpha.31.

  **New packages.**
  - `@llm-ports/observability-contract` — standalone data contract. Zero peer dependency on `@llm-ports/core`. Ships: the `ObservabilityEvent<TType, TData>` envelope with `spec_version` / `event_id` / `event_type` / `occurred_at` / `emitted_at` / `source` / `operation_id` / `attempt_id` / `parent_operation_id` / `trace_context` / `sequence` / `data`; `CorrelationContext` + `ObservabilityContext` (splits logical operation identity from physical attempt identity); the `ObservabilitySink { emit(event) }` interface plus `noopSink` and `createCollectingSink()`; W3C Trace Context + Baggage (string-header form, ≤64 members, ≤8192 bytes); nanoid-based `newEventId` / `newOperationId` / `newAttemptId` / `newEvaluationId`; 9 lifecycle event types (`llm.operation.started` / `attempt.started` / `attempt.completed` / `attempt.failed` / `operation.completed` / `operation.failed` etc.) + 4 agent-step event types; `ErrorInfo` shape + `CauseCategory` (8 values) + static `ERROR_TYPE_TO_CATEGORY` map; nested `CacheStats { provider_cache?, semantic_cache? }`; `RequestFingerprint` canonicalization rules v1 (NFC, LF, sorted keys, 16 allowed request keys) + `sha256Hex` / `hmacSha256Hex` (rejects <16 UTF-8 byte keys); `EvaluationRef` + `EvaluationTarget` discriminated union (7 kinds) + `EvaluationScore` discriminated union (4 types); `CapturePolicy` contract (content, fingerprint, baggage_allowlist, error_body_capture, stream_chunk_capture, redactor) + `DEFAULT_CAPTURE_POLICY` + `PERMISSIVE_CAPTURE_POLICY`; full Zod schema catalog + `eventSchemaFor()` factory; `buildEvent` / `emitLifecycleEvent` / `emitEvaluation` / `emitRaw` emitter helpers; golden vectors JSON for cross-implementation fingerprint validation.
  - `@llm-ports/adapter-codex` — subprocess-driven adapter for OpenAI Codex CLI. Wraps `codex exec --json --cd DIR -m MODEL -s SANDBOX PROMPT` as an in-process `LLMPort.runAgent` implementation. Parses codex's line-delimited JSON output for token usage + final text. Emits the 4-event contract lifecycle via a caller-supplied `ObservabilitySink`. `providerExtras.codex.workingDirectory` is required; `sandbox` / `autoApprove` / `model` / `imageFiles` are optional. `generateText` / `generateStructured` / `streamText` / `streamStructured` throw `AdapterInternalError`. **Shape A (passthrough governance)**: the operator supplies codex with its own OpenAI credentials via env vars or `~/.codex/auth.toml`; `@llm-ports` does NOT route codex's LLM traffic. The port owns lifecycle observability and orchestration.
  - `@llm-ports/adapter-aider` — subprocess-driven adapter for the Aider CLI. Wraps `aider --no-stream --yes-always --message "<prompt>" [files...]` with `cwd` set to the caller-supplied `workingDirectory`. Same 4-event lifecycle emission. `providerExtras.aider` accepts `files` / `model` / `editFormat` / `yesAlways` / `verbose` / `mapTokens`. Same non-runAgent method behavior as codex. Token usage + cost reported as zeros for alpha.28; richer accounting deferred to alpha.29 runtime instrumentation. Same Shape A passthrough governance.

  **Core additions (`@llm-ports/core`).**
  - **`withObservabilityContext(port, context)`** — Proxy-based scoped-port wrapper. Merges caller-supplied `CorrelationContext` + `TraceContext` + `Baggage` into a port-scoped context that adapters can retrieve via `getObservabilityContext(port)`. WeakMap-stored. Enables long-horizon agent runs to thread a single `operation_id` across many `attempt_id` retries + fallbacks. §4.2 of Plan 58.
  - **Three new typed error classes**: `CreditExhaustionError` (provider returned 402 / insufficient balance — walk-worthy for fallback), `ProviderMalformed400Error extends BadRequestError` (400 caused by the provider's request-schema drift, not caller error — walk-worthy for fallback), `AdapterInternalError` (adapter-internal JS runtime error — abort-worthy, not fallback-worthy).
  - **`defaultShouldFallback(err)` walk-table policy function** — canonical shouldFallback semantics. Walk-worthy: `RateLimitError`, `ServiceUnavailableError`, `CreditExhaustionError`, `ProviderMalformed400Error`, `ContextWindowExceededError`, `ContentPolicyViolationError`, `ImageTooLargeError`, `ContentBlockUnsupportedError`. Abort-worthy: `AuthenticationError`, generic `BadRequestError`, `AdapterInternalError`, `InvalidImageUrlError`, contract errors.

  **Core fixes.**
  - **TD-LLMP-16**: `wrapProviderError` now propagates `modelId` into `ContextWindowExceededError` and `ContentPolicyViolationError`, closing a gap where downstream retry decisions couldn't see which model tripped the constraint.
  - **TD-LLMP-17**: `runAgent` gets a defensive `tools: {}` default when the caller omits the field, and `wrapProviderError` isolates local JS runtime errors (`TypeError`, `ReferenceError`, `SyntaxError`) as `AdapterInternalError` rather than misclassifying them as provider errors.
  - **TD-LLMP-18**: `attemptValidationRepair` normalizes Unicode confusables (hyphens U+2010..U+2015 / U+2212 / U+FF0D → ASCII '-', curly quotes → ASCII, Unicode spaces → ASCII space) on `invalid_enum_value` retries before falling back to the reprompt path. Reduces retry loops when a provider emits visually-identical-but-code-point-distinct enum values.

  **Scope not in this release** (per Plan 58 §5.2–§5.4).
  - Runtime instrumentation (adapters emitting `attempt.completed` / `attempt.failed` / `operation.*` from live retry/fallback paths). Alpha.29.
  - Streaming instrumentation + full OpenTelemetry integration. Alpha.30.
  - Persistence backends (SQLite / ClickHouse / OTel exporter). Alpha.31.
  - BEPA + ADW cutovers to the new contract. Alpha.31.

  **Verification.** Full workspace build + typecheck green. Per-package tests: `@llm-ports/adapter-codex` 41/41 (12 shape + 29 internals); `@llm-ports/adapter-aider` 26/26 (12 shape + 14 internals); `@llm-ports/observability-contract` full Zod schema catalog + golden-vector cross-check. Zero regressions in existing packages.

  **Non-breaking for existing consumers.** No public API removed. New exports are additive. `withObservabilityContext` is optional; existing ports that don't opt in behave unchanged.

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.28

## 0.1.0-alpha.27

### Patch Changes

- Alpha.27 — Legacy fields removed. **BREAKING (removal).** The two-cycle deprecation window opened in alpha.26 is now closed.

  **Removed:**
  - `GenerateTextOptions.instructions?: string`
  - `GenerateTextOptions.prompt?: MessageContent`
  - Same three fields (`instructions?`, `prompt?`) from `GenerateStructuredOptions`, `StreamTextOptions`, `StreamStructuredOptions`.
  - Registry-side dual-population (`populateLegacyFieldsFromMessages`) that synthesized legacy fields from `messages` for alpha.26 backwards-compat.
  - The specific `warnDeprecatedLegacyInput` verb (replaced by generalized `warnDeprecated`; see below).

  **Required (was optional in alpha.26):**
  - `messages: LLMMessage[]` on all four generation methods.

  **Renamed (public helper):**
  - `warnDeprecatedLegacyInput(state, method)` → `warnDeprecated(state, details)`. New signature accepts a `DeprecationDetails` object (`{ what, where, removalVersion?, migrationUrl? }`). The runtime behavior is identical (method-only dedup, `suppressDeprecationWarnings`, `deprecationWarningHandler` routing); the new signature is domain-agnostic and reusable for any future deprecation cycle. `WarningState` + `createWarningState` unchanged.

  **New (error class):**
  - `NonContiguousSystemError extends LLMPortError`. Adapter-anthropic and adapter-google throw this when a system-role message appears mid-conversation (after any user or assistant message). Both providers structurally reject non-leading system messages via their top-level `system` / `systemInstruction` fields; the adapter fails loudly at the boundary rather than silent flattening. Ollama, Vercel, OpenAI pass mid-conversation system messages through inline (their providers tolerate them).

  **Adapter migration (Blocker 1 of the release):**

  All four legacy adapters (Ollama, Vercel, Anthropic, Google) now consume `options.messages` natively:
  - **Ollama** — pass-through via `toOllamaMessages(options.messages)`.
  - **Vercel** — `resolveMessagesForVercel` folds leading system into the SDK's top-level `system` field; per-message multimodal preserved.
  - **Anthropic** — `resolveMessagesForAnthropic` folds leading system into the top-level `system` field; throws `NonContiguousSystemError` on non-leading system.
  - **Google** — `resolveMessagesForGoogle` folds leading system into `systemInstruction`; throws `NonContiguousSystemError` on non-leading system.

  Adapter-openai already consumed `messages` natively as of alpha.26; the alpha.27 changes simplify its `resolveMessagesFromCallOptions` (no more legacy-shape fallback branch).

  **Migration for consumers who missed the alpha.26 window:**

  TypeScript now errors:

  ```
  error TS2353: Object literal may only specify known properties, and 'prompt' does not exist in type 'GenerateTextOptions'.
  ```

  Follow the [alpha.25 → alpha.26 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-25-to-alpha-26.md) for the migration paths, then bump to alpha.27:
  - Mechanical: `messages: toMessages(instructions, prompt)`.
  - Idiomatic: `messages: [sys(instructions), usr(prompt)]`.
  - Native multi-turn: `messages: conversationHistory`.

  Also see [alpha.26 → alpha.27 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-26-to-alpha-27.md).

  **Package versions:**

  Six publishable packages bumped to `0.1.0-alpha.27`. `@llm-ports/capabilities` stays at `0.1.0-alpha.26.1` (unchanged; migrated internally in the alpha.26.1 hotfix).

  **Test coverage:**

  886 tests pass across the workspace (was 888 at alpha.26.1; net delta from removing the 5 alpha.26 dual-shape tests + adding 4 new alpha.27 `warnDeprecated` tests). Zero regressions.

  **Timeline:**
  - alpha.26 (deprecation announced): 2026-07-02
  - alpha.26.1 (capabilities internal migration hotfix): 2026-07-03
  - alpha.27 (fields removed): 2026-07-22

  **Coming next:**
  - **Alpha.28** "Reliability + observability polish" — [Planning #64](https://github.com/baabakk/llm-ports/discussions/64) — target 2026-08-05
  - **Alpha.29** "Capability factory ergonomics" — [Planning #65](https://github.com/baabakk/llm-ports/discussions/65)
  - **Alpha.30** "Persistent backends + caching" — [Planning #66](https://github.com/baabakk/llm-ports/discussions/66)
  - **Alpha.31** "Local runtime + orchestration" — [Planning #67](https://github.com/baabakk/llm-ports/discussions/67)

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.27

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

- No behavior change. CacheControl is accepted but not forwarded through to the underlying Vercel AI SDK call. Bridged providers needing caching should be configured via the Vercel SDK directly. Version bump for workspace alignment.

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
