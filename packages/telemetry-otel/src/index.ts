/**
 * @llm-ports/telemetry-otel — OpenTelemetry semantic-conventions
 * bridge for @llm-ports/observability-contract. Ships one factory
 * (`createOtelSink`) that turns any `ObservabilitySink` slot into an
 * OTel-emitting adapter, plus the minimal Tracer / Meter type surface
 * that lets consumers pass either their real `@opentelemetry/api`
 * instances or any structurally-equivalent test doubles.
 */

export { createOtelSink } from "./sink.js";
export type { OtelSinkOptions } from "./sink.js";

export {
  SPAN_STATUS_ERROR,
  SPAN_STATUS_OK,
} from "./types.js";
export type {
  AttributeValue,
  Attributes,
  Counter,
  CounterOptions,
  Histogram,
  HistogramOptions,
  Meter,
  Span,
  SpanOptions,
  SpanStatus,
  SpanStatusCode,
  Tracer,
} from "./types.js";
