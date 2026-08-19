# `@llm-ports/telemetry-otel`

OpenTelemetry semantic-conventions bridge for `@llm-ports/observability-contract`. Wraps any `ObservabilitySink` slot to turn every contract lifecycle event into OTel spans + metrics per the [gen_ai semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

Introduced in [`0.1.0-alpha.30`](/migration/alpha-29-to-alpha-30). Companion package pattern, opt-in — not baked into `@llm-ports/core`.

## Install

```bash
pnpm add @llm-ports/telemetry-otel@alpha
```

**Zero runtime dependencies.** The package declares its own minimal `Tracer` / `Meter` interfaces as a strict subset of `@opentelemetry/api` v1. Consumers pass their real OTel tracer / meter (structural match) — no shim, no version-locked peer dep. Consumers who don't use OTel pay zero install cost.

## Use

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
    config: {
      sink: otelSink,
      source: { library: "my-app", library_version: "1.0.0" },
    },
  },
});
```

Every `generateText` / `generateStructured` / `streamText` / `streamStructured` / `runAgent` call now flows into OTel spans + metrics per the semconv mapping table below.

## Options

```ts
createOtelSink({
  tracer,                        // required — any Tracer-shaped object
  meter,                         // optional — omit for tracing-only mode
  emitStreamChunkEvents: true,   // default — set false for high-chunk-count streams
  emitAgentEvents: true,         // default — set false to skip agent span events
});
```

**Tracing-only mode** — omit `meter` and only spans emit. No histogram samples.

**High-chunk-count streams** — set `emitStreamChunkEvents: false` to skip the per-chunk `Span.addEvent(...)` calls. Aggregate `stream_stats` still lands on the span's completion attributes.

**Agent-event volume control** — set `emitAgentEvents: false` to skip per-step + per-tool span events. Aggregate operation-level attribution stays.

## Semantic-conventions mapping

Every contract event maps as follows:

| Contract event | OTel treatment |
|---|---|
| `llm.operation.started` | `startSpan("gen_ai.<method>")` with `gen_ai.operation.name`, `gen_ai.task_type`, `gen_ai.provider_chain` attributes. |
| `llm.attempt.completed` | `setAttributes` on the open span: `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens`, `gen_ai.response.id` (when present). Histogram samples: `gen_ai.client.token.usage` (input + output samples, dimensioned by `gen_ai.token.type`), `gen_ai.client.operation.duration` (seconds), `gen_ai.client.cache.read_tokens` (when provider cache read > 0). |
| `llm.attempt.failed` | `recordException(errorInfo)` on the open span. |
| `llm.operation.completed` | `setStatus(OK)` + `end()`. |
| `llm.operation.failed` | `recordException(errorInfo)` + `setStatus(ERROR, message)` + `end()`. |
| `llm.operation.cancelled` | `setStatus(ERROR, "cancelled")` + `end()`. |
| `llm.stream.chunk` | `addEvent("gen_ai.stream.chunk", chunkData)`. Only emits when `emitStreamChunkEvents` is true. |
| `agent.step.started` / `.completed` | `addEvent("gen_ai.agent.step.started" / ".completed", stepData)`. Only emits when `emitAgentEvents` is true. |
| `agent.tool.called` / `.returned` | `addEvent("gen_ai.agent.tool.called" / ".returned", toolData)` — includes sha256 digests of arguments + results. Only emits when `emitAgentEvents` is true. |

Unknown event types (`llm.attempt.retry_scheduled`, `llm.fallback.selected`, future additions) are silently dropped — layer your own custom sink on top if you want to trace them too.

## Metric surface

Three histograms, created lazily on sink construction when `meter` is supplied:

- **`gen_ai.client.token.usage`** (`{token}`) — one sample per direction (`gen_ai.token.type: "input" | "output"`) per attempt, dimensioned by `gen_ai.response.model`.
- **`gen_ai.client.operation.duration`** (`s`) — one sample per attempt (`latency_ms / 1000`), dimensioned by `gen_ai.response.model`.
- **`gen_ai.client.cache.read_tokens`** (`{token}`) — one sample per attempt where `cache_stats.provider_cache.read_input_tokens > 0`, dimensioned by `gen_ai.response.model`.

The `unit` + `description` fields on the created histograms follow the OTel gen_ai stable-metrics naming.

## Span lifecycle

`createOtelSink` owns a private `Map<operation_id, Span>` to correlate lifecycle events across the operation. Entries are populated on `llm.operation.started`, updated by every intra-operation event (attempt.*, stream.chunk, agent.*), and cleaned on operation terminators (`.completed` / `.failed` / `.cancelled`). A well-terminated operation stream never leaks; a pathological orphaned operation (no terminator) leaks one entry per orphan — matches OTel's own behavior around unended spans.

Operation IDs are reusable after termination: reopening `op_1` after it completed produces a NEW span (not a resurrection of the closed one). The internal map's `delete` on terminator ensures this.

## Structural type-checking

If you're not using `@opentelemetry/api` (custom telemetry SDK, test spy, etc.), pass any object satisfying these shapes:

```ts
interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
}

interface Span {
  setAttribute(key: string, value: AttributeValue): void;
  setAttributes(attributes: Attributes): void;
  addEvent(name: string, attributes?: Attributes): void;
  recordException(exception: { message: string; name?: string; stack?: string }): void;
  setStatus(status: SpanStatus): void;
  end(): void;
}

interface Meter {
  createHistogram(name: string, options?: HistogramOptions): Histogram;
  createCounter(name: string, options?: CounterOptions): Counter;
}

interface Histogram {
  record(value: number, attributes?: Attributes): void;
}
```

The full type surface is exported for reuse: `Tracer`, `Span`, `SpanOptions`, `SpanStatus`, `SpanStatusCode`, `Meter`, `Histogram`, `HistogramOptions`, `Counter`, `CounterOptions`, `Attributes`, `AttributeValue`, `SPAN_STATUS_OK`, `SPAN_STATUS_ERROR`.

## Composing with other sinks

Sinks are single-input, single-output. To fan out to both OTel and (say) a collecting sink for offline eval capture, wrap them:

```ts
import { createCollectingSink } from "@llm-ports/observability-contract";

const otelSink = createOtelSink({ tracer, meter });
const captureSink = createCollectingSink();

const fanOutSink = {
  emit(event) {
    otelSink.emit(event);
    captureSink.emit(event);
  },
};

const registry = createRegistryFromEnv({
  // ...
  instrumentation: { config: { sink: fanOutSink, source } },
});
```

The order matters: `otelSink.emit` throws-safe (spans + metrics stay independent), but any custom sink you compose should also swallow its own errors so a downstream failure doesn't break the primary LLM call.

## Versioning

Alpha until the observability contract and OTel gen_ai semconv both stabilize. Contract changes in later alphas may prompt corresponding sink updates. The sink follows the same alpha-tag versioning as the rest of the workspace.

## Related

- [Observability concepts](/concepts/observability) — the full lifecycle event catalog + capture policy.
- [Streaming concepts](/concepts/streaming) — `stream_stats` + per-chunk event details.
- [Cache Control](/concepts/cache) — `cache_stats.provider_cache` mapping.
- [alpha.29 → alpha.30 migration](/migration/alpha-29-to-alpha-30) — where this sink was introduced.
