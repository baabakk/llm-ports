# @llm-ports/telemetry-otel

OpenTelemetry semantic-conventions bridge for `@llm-ports/observability-contract`. Wraps any `ObservabilitySink` slot to turn every contract lifecycle event into OTel spans + metrics per the [OTel gen_ai semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

## Install

```
pnpm add @llm-ports/telemetry-otel @llm-ports/observability-contract
```

Zero runtime dependencies. The package type-checks against a minimal `Tracer` / `Meter` interface (subset of `@opentelemetry/api` v1). Any object satisfying that shape works — your real `@opentelemetry/api` tracer, an SDK-specific tracer, or a test double.

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
  env: process.env,
  adapters: { /* your adapters */ },
  instrumentation: {
    config: {
      sink: otelSink,
      source: { library: "my-app", library_version: "1.0.0" },
    },
  },
});
```

Every `generateText` / `generateStructured` / `streamText` / `streamStructured` / `runAgent` call now produces:

- A span per operation (`gen_ai.<method>`, e.g. `gen_ai.generateText`), open for the duration of the operation.
- Span attributes `gen_ai.operation.name`, `gen_ai.task_type`, `gen_ai.provider_chain`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens`, `gen_ai.response.id`.
- Histogram samples on `gen_ai.client.token.usage` (dimensioned by input / output token type), `gen_ai.client.operation.duration` (seconds), `gen_ai.client.cache.read_tokens` (when provider cache read > 0). Only recorded when a `meter` is passed.
- Span events for `agent.step.*` (LLM turns), `agent.tool.*` (tool calls with sha256 digests of arguments + results), and `llm.stream.chunk` (per-chunk streaming events when the capture policy enables per-chunk emission).
- Span status: OK on `llm.operation.completed`, ERROR + `recordException` on `.failed`, ERROR + `"cancelled"` message on `.cancelled`.

## Options

```ts
createOtelSink({
  tracer,              // required — any Tracer-shaped object
  meter,               // optional — omit for tracing-only mode
  emitStreamChunkEvents: true,  // default — set false for high-chunk-count streams
  emitAgentEvents: true,        // default — set false to skip agent span events
});
```

## Semantic-conventions mapping

| Contract event                          | OTel treatment                                               |
| --------------------------------------- | ------------------------------------------------------------ |
| `llm.operation.started`                 | `startSpan("gen_ai.<method>")` + attributes                  |
| `llm.attempt.completed`                 | `setAttributes` on the open span + histogram samples          |
| `llm.attempt.failed`                    | `recordException` on the open span                            |
| `llm.operation.completed`               | `setStatus(OK)` + `end()`                                     |
| `llm.operation.failed`                  | `recordException` + `setStatus(ERROR)` + `end()`             |
| `llm.operation.cancelled`               | `setStatus(ERROR, "cancelled")` + `end()`                    |
| `llm.stream.chunk`                      | `addEvent("gen_ai.stream.chunk", chunkData)`                 |
| `agent.step.started` / `.completed`     | `addEvent("gen_ai.agent.step.started" / ".completed", ...)`  |
| `agent.tool.called` / `.returned`       | `addEvent("gen_ai.agent.tool.called" / ".returned", ...)`    |

Unknown event types (`llm.attempt.retry_scheduled`, `llm.fallback.selected`, and future additions) are silently dropped by this sink — layer your own custom sink on top if you want to trace them too.

## Versioning

Alpha until the observability contract and gen_ai semconv both stabilize. Contract changes shipped in later alphas may prompt corresponding sink updates.
