# @llm-ports/telemetry-otel

## 0.1.0-alpha.30

### Patch Changes

- Alpha.30 — Streaming instrumentation, adapter-side emission, provider-cache normalization, OpenTelemetry bridge, and SalesCoach call-plan hardening.

  Alpha.30 closes the alpha.29 carve-outs, adds streaming lifecycle emission with `stream_stats`, normalizes provider prompt-cache accounting into the contract's `CacheStats.provider_cache` shape at the Registry boundary, ships adapter-side agent-loop events on the three in-process adapters that own their tool-use loop, refactors the two subprocess adapters (codex, aider) off hand-rolled `sink.emit` blocks onto the shared instrumentation service, and introduces `@llm-ports/telemetry-otel` as a new companion package that bridges every contract event into OpenTelemetry gen_ai spans + metrics.

  **Also in-scope from SalesCoach's alpha.29-shipped TDs.** The auth-track and timeout-track fixes (§2.1 / §2.2 / §2.3 of the alpha.30 plan) shipped in earlier alpha.30 pre-release commits: `defaultShouldFallback` walks on `AuthenticationError` iff `!hasEverAuthenticated`, `probeCredentials` gains an opt-in two-tier `probeWithGenerationFallback` mode, per-attempt timeout is a 4-step precedence chain (call → task → Registry → undefined), and diagnostic fields (`response_char_count`, `response_preview` gated by `CapturePolicy`) land on every `llm.attempt.completed`. SalesCoach's `TD-LLM-AUTH-ERROR-KILLS-THE-WHOLE-CHAIN` and `TD-CALLPLAN-CHAIN-TIMEOUT-STARVATION` both close on bump.

  **Scope in this release** (per `plans/alpha.30-adapter-emission-streaming-otel-and-callplan-hardening.md`).

  **§2.4 Adapter-emission scaffold.** `resurrectOperationContext(port)` retrieves the running `OperationContext` when the Registry (or a direct-caller `withObservabilityContext`) plumbed one down via an opaque `operation_handle` on `ObservabilityContext`. `withObservabilityContext`'s proxy now binds methods to the receiver (the wrapped proxy) so `this` inside an adapter method resolves to the instance the context is registered against — that's what makes `resurrectOperationContext(this)` inside `runAgent` walk back to the outer op. Non-breaking: destructured method calls still work because the receiver at bind time is the proxy.

  **§2.5 Codex + aider refactor.** Both subprocess adapters now compose `withOperation` + `withAttempt` from `@llm-ports/core` instead of duplicating `sink.emit(buildEvent(...))` blocks. `AttemptWorkResult` is populated with usage, cost, `responseCharCount`, `responsePreviewSource`; `opCtx.resultSummary = { exit_code }` preserves the pre-refactor codex/aider signal on `llm.operation.completed`. Spawn errors wrap as `AdapterInternalError` inside the withAttempt work so emitted `llm.attempt.failed` events keep `cause_category: "port_internal"`; external behavior (caller sees `ProviderUnavailableError` re-throw) is unchanged. **Closes** `TD-ALPHA29-ADAPTER-EMIT-DEFERRED`.

  **§2.5 Agent-loop events (openai, anthropic, google).** The three in-process adapters that own their runAgent tool-use loop now call `resurrectOperationContext(this)` at the top and emit `agent.step.started` + `agent.step.completed` per LLM turn and `agent.tool.called` + `agent.tool.returned` per tool call. Digests use SHA-256 (via a new `sha256Hex` re-export from `@llm-ports/core`) so tool arguments + results are content-free by default. All events land under the outer operation_id so aggregating sinks see the full step + tool tree under one span. **Closes** `TD-ALPHA29-AGENT-STEP-EVENTS-DEFERRED`.

  **§2.6 Provider-cache normalization.** Native `TokenUsage.cacheReadTokens` / `.cacheWriteTokens` fields fold into `CacheStats.provider_cache` on `llm.attempt.completed` via one shared helper: `read >= input && input > 0` → `"hit"`; `0 < read < input` → `"partial"`; `read == 0 && any field reported` → `"miss"`; neither field reported → omit. OpenAI (`prompt_tokens_details.cached_tokens`), Anthropic (`cache_read_input_tokens` + `cache_creation_input_tokens`), and Google (`cachedContentTokenCount`) all funnel through the same shape. Consumers no longer need per-adapter branching on cache accounting.

  **§2.7 Streaming instrumentation.** `streamText` / `streamStructured` on the Registry now emit the same operation + attempt lifecycle as non-streaming methods, with `AttemptCompletedData.stream_stats` attached to the natural-completion `llm.attempt.completed`: `ttft_ms`, `total_stream_duration_ms`, `chunk_count`, `inter_chunk_latency_p50_ms` / `_p99_ms` (from real per-chunk timings; percentiles omit when only one chunk was yielded), and `termination: "complete" | "aborted" | "error"`. New `llm.stream.chunk` event fires per chunk when `CapturePolicy.stream_chunk_capture === "full"`; `chunk_content` on the event is additionally gated by the content policy (matches the `response_preview` gate). TTFT is measured from the first pull on the outer wrapper — accurately captures adapter setup + first-token latency.

  Streaming needed a manual-hatch pair to complement the wrap-around form since completion is spread across consumer iteration: `startOperation`, `completeOperation`, `failOperation`, `cancelOperation` compose with the existing `startAttempt` / `completeAttempt` / `failAttempt` hatches. `withOperation` is refactored to use them internally so both wrap-around and streaming callers share one emission path.

  Provider cache derivation for streams reads `StreamCompleteMetadata.usage` inside the shared `closeStreamedAttempt` helper so streamed attempts land the same `cache_stats` consumers see on non-streaming methods.

  **§2.8 `@llm-ports/telemetry-otel@0.1.0-alpha.30` — new publishable package.** `createOtelSink({ tracer, meter? })` bridges every contract lifecycle event into OTel spans + metrics per the [gen_ai semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Zero runtime dependencies — the package declares its own minimal `Tracer` / `Meter` interfaces as a strict subset of `@opentelemetry/api` v1, and consumers pass their real OTel tracer / meter (structural match). Metrics are optional: pass `meter` to emit `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, `gen_ai.client.cache.read_tokens`; omit for tracing-only mode. Stream chunks and agent events map to `Span.addEvent("gen_ai.stream.chunk", ...)` and `Span.addEvent("gen_ai.agent.step.*"/".tool.*", ...)`; toggle via `emitStreamChunkEvents` / `emitAgentEvents` (default true, disable to bound span size for high-chunk-count streams).

  **Verification.** 60+ new alpha.30 vitest cases across 5 new test files:
  - `has-ever-authenticated.test.ts` (17 cases) — §2.1 auth policy.
  - `probe-credentials-and-auth-fallback-cause.test.ts` (15 cases) — §2.1 probe + walk cause.
  - `timeout-granularity.test.ts` (10 cases) — §2.2 / §2.3 timeout precedence chain.
  - `diagnostic-fields.test.ts` (12 cases) — §2.3 response_char_count + response_preview.
  - `adapter-emission-scaffold.test.ts` (8 cases) — §2.4 opaque handle + resurrect.
  - `agent-event-helpers.test.ts` (13 cases) — §2.5 four helpers.
  - `stream-stats.test.ts` (14 cases) — §2.7 contract additions.
  - `stream-instrumentation.test.ts` (13 cases) — §2.7 core-side wrap.
  - `cache-normalization.test.ts` (9 cases) — §2.6 provider-cache normalization.
  - `agent-events-integration.test.ts` (3 cases) — §2.5 end-to-end resurrection.
  - `@llm-ports/telemetry-otel` `sink.test.ts` (15 cases) — §2.8 OTel semconv mapping.

  Core 577/577 (was 425 at start of alpha.29). Contract 309/309. Codex 41/41. Aider 26/26. OpenAI 247/247. Anthropic 76/76. Google 63/63. Telemetry-OTel 15/15. Ollama 40/40. Vercel 24/24. Capabilities 72/72. Eval 37/37. Migrate 9/9. Full workspace green.

  **Non-breaking for existing consumers.** No public API removed. Every new surface is additive: `AttemptWorkResult.streamStats`, `AttemptWorkResult.cacheStats`, `AttemptMetrics.cacheStats`, four manual operation hatches, four agent-event emit helpers, `resurrectOperationContext`, `emitStreamChunk`, `sha256Hex` / `hmacSha256Hex` re-exports from core. The `withObservabilityContext` proxy binding change from target to receiver preserves the behavior every existing test exercises (recorder-style method-call verification) — the change only opens the door for adapters to resurrect the outer op context via `this`.

- Updated dependencies
  - @llm-ports/observability-contract@0.1.0-alpha.30
