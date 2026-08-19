# Migrating from alpha.29 to alpha.30

> **Impact:** None — fully additive release. Bump peer deps. Opting into the new streaming, cache, agent-event, and OTel surfaces is optional.

## Install

```bash
pnpm add @llm-ports/core@alpha @llm-ports/observability-contract@alpha \
         @llm-ports/eval@alpha \
         @llm-ports/adapter-openai@alpha @llm-ports/adapter-anthropic@alpha \
         @llm-ports/adapter-google@alpha @llm-ports/adapter-ollama@alpha \
         @llm-ports/adapter-vercel@alpha @llm-ports/adapter-codex@alpha \
         @llm-ports/adapter-aider@alpha @llm-ports/capabilities@alpha \
         @llm-ports/telemetry-otel@alpha
```

Twelve publishable packages at `0.1.0-alpha.30`. One new package: [`@llm-ports/telemetry-otel`](/adapters/telemetry-otel).

## What actually changed

**In one sentence:** streaming calls now emit the full contract lifecycle with `stream_stats`; provider prompt-cache accounting folds into the canonical `CacheStats.provider_cache` shape at the Registry boundary; the three in-process adapters that own their `runAgent` loop (openai, anthropic, google) emit `agent.step.*` + `agent.tool.*` events; the two subprocess adapters (codex, aider) route their emission through the shared service instead of hand-rolling `sink.emit`; and a new `@llm-ports/telemetry-otel` companion package bridges every event to OpenTelemetry gen_ai spans + metrics.

**In slightly more detail:**

### Streaming instrumentation (§2.7)

`streamText` and `streamStructured` on the Registry now emit the same operation + attempt lifecycle as non-streaming methods:

- `llm.operation.started` — fires immediately when the caller invokes the stream method (before the first chunk).
- `llm.attempt.started` — fires when the winning provider opens its raw stream.
- `llm.attempt.failed` + `llm.fallback.selected` on provider failures at stream-open time.
- `llm.attempt.completed` — fires on natural stream close, with the new `AttemptCompletedData.stream_stats` field:
  - `ttft_ms` — time from stream-open to first chunk (the load-bearing new metric).
  - `total_stream_duration_ms` — first chunk to last chunk.
  - `chunk_count` — count of chunks yielded.
  - `inter_chunk_latency_p50_ms` / `inter_chunk_latency_p99_ms` — from real per-chunk timings. Omitted when only one chunk was yielded (no gaps to sample).
  - `termination: "complete" | "aborted" | "error"`.
- `llm.operation.completed` on success; `.failed` on mid-stream error; `.cancelled` when the consumer aborts.

Per-chunk events (`llm.stream.chunk`) fire only when `CapturePolicy.stream_chunk_capture === "full"` — a volume-sensitive opt-in. `chunk_content` on the per-chunk event is additionally gated by the content policy (matches the `response_preview` gate on non-streaming methods).

`AttemptCompletedData.response_char_count` and `.response_preview` land on every streamed attempt too, computed by buffering chunks in the outer wrapper. `response_char_count` sums chunk lengths; `response_preview` buffers the first `responsePreviewMaxChars` characters and is gated by the content policy.

See the [Streaming Observability concepts guide](/concepts/streaming) for wiring examples and the full field table.

### Provider cache normalization (§2.6)

The five in-process adapters already surfaced prompt-cache activity through `TokenUsage.cacheReadTokens` / `.cacheWriteTokens`. The Registry now folds those native counts into `CacheStats.provider_cache` on `llm.attempt.completed`:

| Provider | Native field | → `provider_cache.*` |
|---|---|---|
| OpenAI | `usage.prompt_tokens_details.cached_tokens` | `read_input_tokens` |
| Anthropic | `usage.cache_read_input_tokens` | `read_input_tokens` |
| Anthropic | `usage.cache_creation_input_tokens` | `write_input_tokens` |
| Google | `usageMetadata.cachedContentTokenCount` | `read_input_tokens` |
| Ollama / Vercel | (no cache surface) | field omitted |

Status enum falls out of one shared helper:
- `read >= input && input > 0` → `"hit"` (fully served from cache)
- `0 < read < input` → `"partial"` (prefix cached, tail fresh)
- `read == 0 && any field reported` → `"miss"` (cache consulted, no hit)
- neither field reported → `cache_stats` omitted (adapter silent)

`provider_reported: true` always accompanies the shape when it's constructed — absence of the field is silence, not "provider reported zero."

Streaming methods derive the same shape from `StreamCompleteMetadata.usage` inside the shared streaming close helper, so streamed attempts get the same `cache_stats` consumers see on non-streaming methods.

See the [Cache Control concepts guide](/concepts/cache) for the full mapping table + status semantics.

### Adapter-side agent-loop events (§2.5)

The three in-process adapters that own their runAgent tool-use loop — openai, anthropic, google — now call `resurrectOperationContext(this)` at the top of `runAgent` and thread the returned `OperationContext` through four emit helpers:

Per LLM turn:
- `agent.step.started` (with `step_index`, `step_type: "llm"`)
- LLM call runs
- `agent.step.completed` (with `duration_ms`, `usage`, `cost`)

Per tool call:
- `agent.tool.called` (with `tool_name`, `tool_call_id`, `arguments_digest: sha256Hex(rawArgs)`)
- `def.execute(args)` runs
- `agent.tool.returned` (with `result_digest`, `duration_ms`, optional `error: ErrorInfo` on failure)

All events share the outer `operation_id`, so an aggregating sink sees the full step + tool tree stitched under one span.

**How it works.** `withObservabilityContext(port, ctx)` wraps the port in a proxy that carries an opaque `operation_handle`. `resurrectOperationContext(port)` walks back from that handle to the running `OperationContext`. Inside the adapter's runAgent method, `this` resolves to the wrapped proxy (alpha.30 changed the proxy binding from target to receiver) so `resurrectOperationContext(this)` returns the outer op. No breaking change: destructured calls still work because the receiver at bind time is the proxy.

Consumers who bypass the Registry and import a raw adapter directly still see the events fire — if they've wrapped the port themselves with `withObservabilityContext`, `resurrectOperationContext` finds the outer op; if not, the emit helpers no-op and everything runs unchanged.

### Codex + aider adapters refactored to shared service (§2.5)

Both subprocess adapters previously hand-rolled `sink.emit(buildEvent(...))` blocks for every lifecycle event. They now compose `withOperation` + `withAttempt` from `@llm-ports/core` like every other emit path:

```ts
return await withOperation(
  instrumentation,
  { taskType, method: "runAgent", providerChain: [alias] },
  async (opCtx) => {
    return withAttempt(
      opCtx,
      { providerAlias: alias, modelId: model ?? "(codex-default)" },
      async () => {
        const outcome = await spawnCodex({ /* ... */ });
        opCtx.resultSummary = { exit_code: outcome.exitCode };
        return {
          value: /* AgentResult */,
          usage, cost, modelId,
          responseCharCount: finalText.length,
          responsePreviewSource: finalText,
        };
      },
    );
  },
);
```

Spawn errors wrap as `AdapterInternalError` inside the withAttempt work so emitted `llm.attempt.failed` events keep the pre-refactor `cause_category: "port_internal"` classification. Callers still see `ProviderUnavailableError` on the outside — external behavior is unchanged.

### `@llm-ports/telemetry-otel@0.1.0-alpha.30` — new companion package (§2.8)

`createOtelSink({ tracer, meter? })` bridges every contract event to OpenTelemetry gen_ai spans + metrics per the [gen_ai semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Zero runtime dependencies — the package declares a minimal `Tracer` / `Meter` subset of `@opentelemetry/api` v1 and consumers pass their real OTel tracer / meter (structural match).

```ts
import { trace, metrics } from "@opentelemetry/api";
import { createOtelSink } from "@llm-ports/telemetry-otel";
import { createRegistryFromEnv } from "@llm-ports/core";

const otelSink = createOtelSink({
  tracer: trace.getTracer("my-app"),
  meter: metrics.getMeter("my-app"),
});

const registry = createRegistryFromEnv({
  env: process.env as Record<string, string>,
  adapters: { /* ... */ },
  instrumentation: {
    config: { sink: otelSink, source: { library: "my-app", library_version: "1.0.0" } },
  },
});
```

Mapping: `llm.operation.started` opens a span (`gen_ai.<method>` name, `gen_ai.operation.name` attribute); `llm.attempt.completed` sets `gen_ai.request.model` / `gen_ai.response.model` / `gen_ai.usage.*` attributes AND records `gen_ai.client.token.usage` (input + output histograms), `gen_ai.client.operation.duration` (seconds), `gen_ai.client.cache.read_tokens` (when provider cache read > 0); `llm.stream.chunk` and `agent.*` events map to `Span.addEvent(...)`; terminators set span status.

Metrics are optional (omit `meter` for tracing-only mode). Two toggles: `emitStreamChunkEvents` and `emitAgentEvents` (default true; disable per-chunk emission for high-chunk-count streams).

Full details in the [`@llm-ports/telemetry-otel` adapter guide](/adapters/telemetry-otel).

### SalesCoach call-plan hardening (from earlier alpha.30-prep)

Two SalesCoach production TDs close on this bump — the fixes shipped in the alpha.30-prep commits before the public alpha.30 tag:

- **`TD-LLM-AUTH-ERROR-KILLS-THE-WHOLE-CHAIN`.** `defaultShouldFallback` now takes an optional `ShouldFallbackContext` (`providerAlias`, `hasEverAuthenticated`) and walks on `AuthenticationError` only when the provider has never authenticated in the current process. A dead position-4 key at chain-open falls forward with a distinct `FallbackCause.provider_authentication_never_established`; a mid-flight auth failure on a previously-authenticated provider aborts. `Registry.probeCredentials(chain?, options?)` gains an opt-in two-tier `probeWithGenerationFallback` mode for adapters where `listModels` is authoritative but not exhaustive.
- **`TD-CALLPLAN-CHAIN-TIMEOUT-STARVATION`.** `resolvePerAttemptTimeoutMs(taskType, callOverride)` implements a 4-step precedence chain: call override → task-declared `defaultPerAttemptTimeoutMs` → Registry-declared `perAttemptTimeoutMs` → undefined. A single global 15 s cap no longer starves later chain positions on long-tail tasks.

Consumers on the alpha.28+ default preset (`runtimeFallback` unset) automatically get the ctx-aware `AuthenticationError` walk. Consumers who want the full alpha.28 `defaultShouldFallback` walk-table with the alpha.30 ctx-aware auth handling should switch to `{ shouldFallback: defaultShouldFallback }` explicitly.

## Migration steps

There are no code changes required. The migration is:

1. Update `package.json` peer deps for every `@llm-ports/*` you consume:
   - `"@llm-ports/core": "^0.1.0-alpha.30"`
   - `"@llm-ports/observability-contract": "^0.1.0-alpha.30"`
   - Every adapter you use, and `@llm-ports/capabilities`, `@llm-ports/eval` (if adopted).
   - **Optional:** `"@llm-ports/telemetry-otel": "^0.1.0-alpha.30"` if you want the OTel semconv bridge.
2. `pnpm install`.
3. `pnpm build` — confirm nothing broke.

That's it for the mechanical migration. Wiring the streaming / cache / agent / OTel surfaces is opt-in and can happen at your own pace.

## Behavioral notes to watch

- **Streaming callers already using `RegistryOptions.instrumentation`.** You'll start seeing `llm.operation.*`, `llm.attempt.*`, and (when `stream_chunk_capture === "full"`) `llm.stream.chunk` events for every `streamText` / `streamStructured` call. If your sink expected zero events on streams pre-alpha.30, adjust downstream filtering.
- **`llm.attempt.completed` on non-streaming calls now carries `cache_stats.provider_cache` for OpenAI / Anthropic / Google when the provider reported cache activity.** If you had a bespoke consumer-side mapping from `usage.cacheReadTokens` to your own cache-stats shape, keep it in place — the new field is additive, not a replacement.
- **runAgent calls through the Registry now emit `agent.step.*` + `agent.tool.*` events between `llm.attempt.started` and `llm.attempt.completed`.** If you had a sink that assumed the only events under an operation were the lifecycle events, the volume goes up (one step + tool pair per LLM turn + tool call). Aggregate consumers benefit from richer per-step attribution.
- **`withObservabilityContext` proxy binding changed from target to receiver.** Every existing test that passes today continues to pass; the change opens the door for `resurrectOperationContext(this)` to work inside adapter methods. If you have a custom adapter that relied on `this` inside its method resolving to the underlying port (rather than the wrapped proxy) — most adapters don't reference `this` at all — audit that pattern.

## Deferred to alpha.31

- Persistence backends for `@llm-ports/eval` beyond SQLite (Postgres, ClickHouse).
- Evaluation-workflow tooling (batch runners, LLM-judge templates).

## When to consider adopting

- **You use streaming and want per-stream TTFT / chunk-count / p50/p99 latency metrics.** Bump; the new fields land automatically on `llm.attempt.completed` when instrumentation is wired.
- **You want provider-cache hit / miss / partial dashboards.** Bump; `cache_stats.provider_cache` lands on every `llm.attempt.completed` from OpenAI / Anthropic / Google when they report cache activity.
- **You run agentic workloads (`runAgent`) and want per-step + per-tool attribution.** Bump; the three in-process adapters emit the events automatically.
- **You want to ship telemetry to OpenTelemetry.** Bump + `pnpm add @llm-ports/telemetry-otel@alpha`; `createOtelSink({ tracer, meter })` and pass it in `instrumentation.config.sink`.
- **You had `AuthenticationError` from a dead API key aborting your whole chain.** Bump; the ctx-aware fallback policy walks past dead keys at chain-open.
- **You had a global per-attempt timeout starving long-tail chain positions.** Bump; declare `defaultPerAttemptTimeoutMs` on the offending task or pass `perAttemptTimeoutMs` at the call site.

## Downgrade / rollback

Trivial: revert the version pins to `0.1.0-alpha.29`, remove `@llm-ports/telemetry-otel` from your deps if you added it. Nothing else to undo. All alpha.30 additions are additive — no shape breakage on any existing event or return value.
