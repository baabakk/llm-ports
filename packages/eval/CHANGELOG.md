# @llm-ports/eval

## 0.1.0-alpha.30

### Patch Changes

- Updated dependencies
  - @llm-ports/observability-contract@0.1.0-alpha.30

## 0.1.0-alpha.29

### Patch Changes

- Alpha.29 — Runtime instrumentation (Registry-only) + fingerprint compute + evaluation store + SalesCoach task-type fix.

  Alpha.29 wires the alpha.28 observability contract into the actual retry/fallback paths inside the Registry, adds prompt-fingerprint compute at the Registry's call site, ships a new evaluation-storage package, and closes the SalesCoach-reported task-type case-mismatch bug in the Registry lookup.

  **Scope in this release (per `plans/alpha.29-runtime-instrumentation.md`).**
  - **Shared instrumentation service (`packages/core/src/instrumentation.ts`).** One module owns event construction, ID lifecycle, timing, and error handling for the contract lifecycle. Public API: `withOperation(instrumentation, params, work)` for the outer wrap, `withAttempt(opCtx, params, work)` for each provider attempt, `emitRetryScheduled` / `emitFallbackSelected` for Registry-only events, `startAttempt` / `completeAttempt` / `failAttempt` for the manual escape hatch, `maybeComputeFingerprint(opCtx, request)` for opt-in fingerprint compute. Sink failures are always caught to preserve the "observability never breaks the primary path" rule.
  - **Registry wire-up (`packages/core/src/registry/registry.ts`).** New `RegistryOptions.instrumentation?: Instrumentation`. When configured, `generateText`, `generateStructured`, and `runAgent` emit the full contract lifecycle: `llm.operation.started` → per-attempt `llm.attempt.started` + `llm.attempt.completed`/`.failed` → `llm.fallback.selected` on chain advancement → `llm.operation.completed`/`.failed`/`.cancelled`. Streams (`streamText`, `streamStructured`) are not instrumented yet; alpha.30 wires the streaming path.
  - **Registry-exclusive events.** `llm.attempt.retry_scheduled` and `llm.fallback.selected` fire from the Registry's fallback loop with `RetryReason` / `FallbackCause` from the contract's enums.
  - **Prompt fingerprint compute (`@llm-ports/observability-contract` + `@llm-ports/core`).** New optional `AttemptCompletedData.request_fingerprint` field on the contract's `attempt.completed` shape (also added to the Zod schema). New `Instrumentation.fingerprint?: FingerprintPolicy` opt-in on the shared service. When set, the Registry computes a `RequestFingerprint` once per operation (before any attempt runs) and attaches it to every `attempt.completed` emission. Off by default per the contract's `CapturePolicy.fingerprint` default. Deterministic: two calls with the same request produce identical `message_hash` and `request_hash`.
  - **`@llm-ports/eval@0.1.0` — new publishable package.** Durable storage for post-hoc evaluations (LLM-judge scores, human annotations, rule-based verdicts) keyed on the alpha.28 `EvaluationRef` shape. Ships an in-memory store (default, no dependencies) and an opt-in SQLite backend (peer-dep on `better-sqlite3`). Both implement the same `EvaluationStore` interface: `write`, `get`, `find` (with `EvaluationQuery` filters), `count`, `close`. Dedup semantics: `evaluation_id` primary; `idempotency_key` takes precedence when set. `toObservabilitySink(store)` bridges the store to the contract's `ObservabilitySink` — forwarded events with `event_type === "evaluation.recorded"` land in the store; all other events are silently ignored.
  - **SalesCoach task-type case-mismatch fix.** Root cause: `packages/core/src/registry/config.ts:85` lowercases and hyphenates env-var suffixes at parse time (`LLM_TASK_ROUTE_STRUCTURED_OUTPUT` → `"structured-output"`), but pre-alpha.29 the Registry's lookup did string-identity matching against the caller-supplied `taskType` and silently fell through to `"general"` on miss. Fix: new `normalizeTaskType` helper is now applied at both the parse site and the two Registry lookup sites (`selectModel` line 298, `selectViableChain` line 424), so uppercase-underscored and mixed-case task types all resolve to the same route. When the normalized lookup still misses and the fallback to `"general"` fires, a warn-once through the shared `WarningState` surfaces the silent drift. SalesCoach TD `TD-LLM-TASKTYPE-CASE-MISMATCH-SILENT-GENERAL-FALLBACK` closes when consumers bump to alpha.29.
  - **New helpers.** `warnOnce(state, key, message)` sits alongside `warnDeprecated` in `packages/core/src/utils/deprecation.ts` — same dedup + suppression + handler infrastructure, generic message shape.

  **Scope carved out (per plan §7 scope-adjustment, filed to `TECH-DEBT.md`).**
  - Adapter-level operation/attempt emission deferred to alpha.30. The plan's original model ("Registry wraps operations, adapters wrap attempts, `opCtx` flows through as a first-class argument") required either a breaking change to `LLMPort` method signatures or leaky abstraction through `withObservabilityContext`. Alpha.29 ships Registry-only instrumentation instead. Consumers who bypass the Registry and import a raw in-process adapter directly see no contract events yet. Filed as `TD-ALPHA29-ADAPTER-EMIT-DEFERRED` with two candidate designs for alpha.30 to pick between.
  - Provider cache normalization (§2.4) and agent step + tool events (§2.5) both require adapter-level emission and move to alpha.30 alongside the adapter wiring. Filed as `TD-ALPHA29-AGENT-STEP-EVENTS-DEFERRED`.
  - Streaming instrumentation (§2.5 / §5.3), OTel semconv adapter (§5.3), and persistence backends beyond SQLite (§5.4) all remain on the original alpha.30 / alpha.31 schedule.

  **Verification.** 88 new alpha.29 vitest cases across 4 test files. Core test suite 476/476 green (was 425 pre-alpha.29). Eval package 37/37 green. Full workspace test suite green with zero regressions across existing packages. `pnpm -r --workspace-concurrency=1 build` clean.

  **Non-breaking for existing consumers.** No public API removed. New surfaces are additive: `RegistryOptions.instrumentation`, `AttemptCompletedData.request_fingerprint`, `Instrumentation.fingerprint`. Existing callers see identical behavior when they don't opt into the new fields.

- Updated dependencies
  - @llm-ports/observability-contract@0.1.0-alpha.29
