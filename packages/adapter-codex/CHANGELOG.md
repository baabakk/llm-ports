# @llm-ports/adapter-codex

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
  - @llm-ports/observability-contract@0.1.0-alpha.28
