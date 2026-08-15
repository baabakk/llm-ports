/**
 * `createOtelSink` — bridge every contract lifecycle event into OTel
 * spans + metrics per the OpenTelemetry gen_ai semantic conventions.
 *
 * The consumer constructs the sink at telemetry-setup time and passes
 * it to any `EmitterConfig.sink` slot the shared instrumentation
 * service expects (Registry, in-process adapter emit paths, non-port
 * standalone emitters). Every emitted `ObservabilityEvent` flows
 * through this sink and lands as:
 *
 *   * A span per operation (opened on `llm.operation.started`,
 *     closed on `.completed` / `.failed` / `.cancelled`).
 *   * Span attributes on `llm.attempt.completed` for model, usage,
 *     final latency (mapped to `gen_ai.*` semantic-convention keys).
 *   * Metric samples (input-token histogram, output-token histogram,
 *     operation-duration histogram, provider-cache-read-tokens
 *     histogram) — only when a Meter was supplied.
 *   * Span events (`agent.step.*`, `agent.tool.*`, `llm.stream.chunk`)
 *     as OTel `Span.addEvent` calls, correlated with the outer span
 *     by operation_id.
 *
 * The sink is entirely stateless from the caller's perspective — it
 * owns a private `Map<operation_id, Span>` internally to correlate
 * lifecycle events, and cleans that map when each operation
 * terminates. A pathological consumer that opens an operation but
 * never terminates it leaks one entry in the map per orphaned op;
 * that mirrors OTel's own behavior around unended spans.
 *
 * See the OpenTelemetry gen_ai semantic conventions:
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

import type {
  AgentStepCompletedData,
  AgentStepStartedData,
  AgentToolCalledData,
  AgentToolReturnedData,
  AnyObservabilityEvent,
  AttemptCompletedData,
  AttemptFailedData,
  ObservabilitySink,
  OperationFailedData,
  OperationStartedData,
  StreamChunkData,
} from "@llm-ports/observability-contract";
import {
  SPAN_STATUS_ERROR,
  SPAN_STATUS_OK,
  type Attributes,
  type Histogram,
  type Meter,
  type Span,
  type Tracer,
} from "./types.js";

export interface OtelSinkOptions {
  /**
   * OTel Tracer (or any object satisfying the minimal `Tracer`
   * interface) that spans open against.
   */
  tracer: Tracer;

  /**
   * Optional OTel Meter for the histogram + counter surface. When
   * omitted, metric samples are suppressed; span attribution still
   * runs so consumers who only want tracing pay no metric cost.
   */
  meter?: Meter;

  /**
   * Emit each `llm.stream.chunk` and `agent.*` event as a span event.
   * Default `true` — matches the alpha.30 plan's mapping. Disable to
   * keep span size bounded for high-chunk-count streams where the
   * aggregate `stream_stats` is enough.
   */
  emitStreamChunkEvents?: boolean;

  /**
   * Emit each `agent.step.*` and `agent.tool.*` event as a span event
   * under the outer operation span. Default `true`. Independent of
   * `emitStreamChunkEvents` because agent runs typically produce a
   * small handful of steps + tools (well below the "one span event
   * per chunk" volume concern that motivates the stream toggle).
   */
  emitAgentEvents?: boolean;
}

/**
 * Construct an ObservabilitySink that bridges contract events into
 * OpenTelemetry per the gen_ai semantic conventions. Consumers wire
 * it into an EmitterConfig's `sink` slot:
 *
 * ```ts
 * import { trace, metrics } from "@opentelemetry/api";
 * import { createOtelSink } from "@llm-ports/telemetry-otel";
 *
 * const otelSink = createOtelSink({
 *   tracer: trace.getTracer("my-app"),
 *   meter: metrics.getMeter("my-app"),
 * });
 * const registry = createRegistryFromEnv({
 *   ...,
 *   instrumentation: { config: { sink: otelSink, source: { library: "my-app", library_version: "1.0.0" } } },
 * });
 * ```
 */
export function createOtelSink(options: OtelSinkOptions): ObservabilitySink {
  const { tracer, meter } = options;
  const emitStreamChunkEvents = options.emitStreamChunkEvents ?? true;
  const emitAgentEvents = options.emitAgentEvents ?? true;

  const spans = new Map<string, Span>();

  // Metric instruments per the alpha.30 plan §2.8 mapping. Created
  // lazily on first use — a meter with a passthrough / no-op backend
  // still incurs the creation call, but avoiding it when meter is
  // undefined keeps the tracing-only path allocation-free.
  const inputTokensHist: Histogram | undefined = meter?.createHistogram(
    "gen_ai.client.token.usage",
    { unit: "{token}", description: "Token usage per LLM operation (dimensioned by direction)" },
  );
  const durationHist: Histogram | undefined = meter?.createHistogram(
    "gen_ai.client.operation.duration",
    { unit: "s", description: "Duration of the client LLM call in seconds" },
  );
  const cacheReadHist: Histogram | undefined = meter?.createHistogram(
    "gen_ai.client.cache.read_tokens",
    { unit: "{token}", description: "Tokens served from the provider prompt cache" },
  );

  return {
    emit(event: AnyObservabilityEvent): void {
      switch (event.event_type) {
        case "llm.operation.started":
          openOperationSpan(event.data as OperationStartedData, event.operation_id, tracer, spans);
          return;

        case "llm.attempt.completed":
          annotateSpanWithCompletion(
            event.data as AttemptCompletedData,
            event.operation_id,
            spans,
            inputTokensHist,
            durationHist,
            cacheReadHist,
          );
          return;

        case "llm.attempt.failed":
          annotateSpanWithFailure(event.data as AttemptFailedData, event.operation_id, spans);
          return;

        case "llm.operation.completed":
          closeOperationSpan(event.operation_id, spans, "ok");
          return;

        case "llm.operation.failed":
          closeOperationSpan(event.operation_id, spans, "error", (event.data as OperationFailedData).error);
          return;

        case "llm.operation.cancelled":
          closeOperationSpan(event.operation_id, spans, "cancelled");
          return;

        case "llm.stream.chunk":
          if (!emitStreamChunkEvents) return;
          addSpanEvent(event.operation_id, spans, "gen_ai.stream.chunk", chunkAttributes(event.data as StreamChunkData));
          return;

        case "agent.step.started":
          if (!emitAgentEvents) return;
          addSpanEvent(event.operation_id, spans, "gen_ai.agent.step.started", stepStartedAttributes(event.data as AgentStepStartedData));
          return;

        case "agent.step.completed":
          if (!emitAgentEvents) return;
          addSpanEvent(event.operation_id, spans, "gen_ai.agent.step.completed", stepCompletedAttributes(event.data as AgentStepCompletedData));
          return;

        case "agent.tool.called":
          if (!emitAgentEvents) return;
          addSpanEvent(event.operation_id, spans, "gen_ai.agent.tool.called", toolCalledAttributes(event.data as AgentToolCalledData));
          return;

        case "agent.tool.returned":
          if (!emitAgentEvents) return;
          addSpanEvent(event.operation_id, spans, "gen_ai.agent.tool.returned", toolReturnedAttributes(event.data as AgentToolReturnedData));
          return;

        default:
          // Unknown event types (retry_scheduled, fallback.selected, and
          // any future additions) — no-op. The consumer's real OTel
          // integration can layer on top if they want to trace these too.
          return;
      }
    },
  };
}

// ─── Span helpers ───────────────────────────────────────────────────

function openOperationSpan(
  data: OperationStartedData,
  operationId: string,
  tracer: Tracer,
  spans: Map<string, Span>,
): void {
  const span = tracer.startSpan(`gen_ai.${data.method}`, {
    attributes: {
      "gen_ai.operation.name": data.method,
      "gen_ai.task_type": data.task_type ?? "",
      "gen_ai.provider_chain": data.provider_chain.join(","),
    },
  });
  spans.set(operationId, span);
}

function annotateSpanWithCompletion(
  data: AttemptCompletedData,
  operationId: string,
  spans: Map<string, Span>,
  inputTokensHist: Histogram | undefined,
  durationHist: Histogram | undefined,
  cacheReadHist: Histogram | undefined,
): void {
  const span = spans.get(operationId);
  if (!span) return;

  const attrs: Attributes = {
    "gen_ai.request.model": data.final_model_id,
    "gen_ai.response.model": data.final_model_id,
    "gen_ai.usage.input_tokens": data.usage.inputTokens,
    "gen_ai.usage.output_tokens": data.usage.outputTokens,
    "gen_ai.usage.total_tokens": data.usage.totalTokens,
  };
  if (data.provider_response_id) {
    attrs["gen_ai.response.id"] = data.provider_response_id;
  }
  span.setAttributes(attrs);

  // Metrics — dimensioned by response model + token type per gen_ai semconv.
  const modelDim: Attributes = { "gen_ai.response.model": data.final_model_id };
  inputTokensHist?.record(data.usage.inputTokens, {
    ...modelDim,
    "gen_ai.token.type": "input",
  });
  inputTokensHist?.record(data.usage.outputTokens, {
    ...modelDim,
    "gen_ai.token.type": "output",
  });
  durationHist?.record(data.latency_ms / 1000, modelDim);

  const providerCacheRead = data.cache_stats?.provider_cache?.read_input_tokens;
  if (typeof providerCacheRead === "number" && providerCacheRead > 0) {
    cacheReadHist?.record(providerCacheRead, modelDim);
  }
}

function annotateSpanWithFailure(
  data: AttemptFailedData,
  operationId: string,
  spans: Map<string, Span>,
): void {
  const span = spans.get(operationId);
  if (!span) return;
  span.recordException({
    message: data.error.message ?? data.error.error_type,
    name: data.error.error_type,
  });
}

function closeOperationSpan(
  operationId: string,
  spans: Map<string, Span>,
  status: "ok" | "error" | "cancelled",
  err?: { error_type: string; message?: string },
): void {
  const span = spans.get(operationId);
  if (!span) return;
  if (status === "ok") {
    span.setStatus({ code: SPAN_STATUS_OK });
  } else if (status === "error") {
    const message = err?.message ?? err?.error_type ?? "operation failed";
    if (err) {
      span.recordException({ message, name: err.error_type });
    }
    span.setStatus({ code: SPAN_STATUS_ERROR, message });
  } else {
    // cancelled — record as error with an explicit message so downstream
    // filters can distinguish cancellation from other terminal errors.
    span.setStatus({ code: SPAN_STATUS_ERROR, message: "cancelled" });
  }
  span.end();
  spans.delete(operationId);
}

function addSpanEvent(
  operationId: string,
  spans: Map<string, Span>,
  name: string,
  attributes: Attributes,
): void {
  const span = spans.get(operationId);
  if (!span) return;
  span.addEvent(name, attributes);
}

// ─── Event-attribute mappers ────────────────────────────────────────

function chunkAttributes(data: StreamChunkData): Attributes {
  const attrs: Attributes = {
    "gen_ai.stream.chunk_index": data.chunk_index,
    "gen_ai.stream.chars_in_chunk": data.chars_in_chunk,
    "gen_ai.stream.time_since_start_ms": data.time_since_start_ms,
  };
  if (typeof data.chunk_content === "string") {
    attrs["gen_ai.stream.chunk_content"] = data.chunk_content;
  }
  return attrs;
}

function stepStartedAttributes(data: AgentStepStartedData): Attributes {
  const attrs: Attributes = {
    "gen_ai.agent.step_index": data.step_index,
    "gen_ai.agent.step_type": data.step_type,
  };
  if (data.tool_name) attrs["gen_ai.agent.tool_name"] = data.tool_name;
  return attrs;
}

function stepCompletedAttributes(data: AgentStepCompletedData): Attributes {
  const attrs: Attributes = {
    "gen_ai.agent.step_index": data.step_index,
    "gen_ai.agent.duration_ms": data.duration_ms,
  };
  if (data.usage) {
    attrs["gen_ai.usage.input_tokens"] = data.usage.inputTokens;
    attrs["gen_ai.usage.output_tokens"] = data.usage.outputTokens;
  }
  return attrs;
}

function toolCalledAttributes(data: AgentToolCalledData): Attributes {
  return {
    "gen_ai.agent.tool_name": data.tool_name,
    "gen_ai.agent.tool_call_id": data.tool_call_id,
    "gen_ai.agent.arguments_digest": data.arguments_digest,
  };
}

function toolReturnedAttributes(data: AgentToolReturnedData): Attributes {
  const attrs: Attributes = {
    "gen_ai.agent.tool_name": data.tool_name,
    "gen_ai.agent.tool_call_id": data.tool_call_id,
    "gen_ai.agent.result_digest": data.result_digest,
    "gen_ai.agent.duration_ms": data.duration_ms,
  };
  if (data.error) {
    attrs["gen_ai.agent.error_type"] = data.error.error_type;
    attrs["gen_ai.agent.error_message"] = data.error.message;
  }
  return attrs;
}
