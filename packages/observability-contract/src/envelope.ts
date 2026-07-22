/**
 * Canonical event envelope for @llm-ports observability.
 *
 * Every event emitted by the contract wraps a payload in this envelope.
 * The envelope carries versioning, identity, timing, source attribution,
 * correlation, and W3C Trace Context; the payload varies per event type.
 *
 * The envelope is generic over the event type name (as a discriminated
 * union tag) and the payload shape. Downstream consumers switch on
 * `event_type` to narrow the payload.
 *
 * Design decisions locked in for alpha.28 per Plan 58 v0.4 §4.1:
 *
 *   - Dual timestamps (`occurred_at` + `emitted_at`) distinguish when the
 *     event happened at the source from when the emitter produced the
 *     event. Matters for late-arriving evaluations per §4.9.
 *   - `spec_version` on every event lets sinks refuse or migrate events
 *     emitted against an older contract version.
 *   - `event_id` is nanoid; sinks dedup at the wire level.
 *   - `sequence` handles multi-emitter interleaving within an operation.
 *   - Correlation fields (`operation_id`, `attempt_id`,
 *     `parent_operation_id`) are first-class in the envelope, not in the
 *     payload, so cross-event correlation is uniform.
 */

import type { TraceContext } from "./trace-context.js";

/**
 * Identifier for the emitter of an event. Sinks can attribute events to
 * instrumentation libraries and diagnose emitter bugs.
 */
export interface EventSource {
  /** e.g. "@llm-ports/core" or "@llm-ports/observability-contract" */
  library: string;
  library_version: string;
  /** e.g. "adapter-anthropic" or "registry" or "custom-adapter" */
  component?: string;
  /** e.g. "node@22.11" or "bun@1.1.30" */
  runtime?: string;
}

/**
 * The canonical envelope. Generic over event type name and payload shape.
 *
 * @typeParam TType - The literal event type name (e.g. "llm.operation.started")
 * @typeParam TData - The payload shape specific to that event type
 */
export interface ObservabilityEvent<TType extends string, TData> {
  /** Contract package version this event conforms to, e.g. "0.1.0-alpha.28" */
  spec_version: string;

  /** nanoid; primary key for dedup at any sink */
  event_id: string;

  /** Discriminated union tag; consumers switch on this */
  event_type: TType;

  /** ISO-8601 with timezone; when the event happened at the source */
  occurred_at: string;

  /** ISO-8601 with timezone; when the emitter produced the event */
  emitted_at: string;

  /** Emitter identity */
  source: EventSource;

  /** Correlation: one logical operation (see correlation.ts) */
  operation_id: string;

  /** Correlation: one physical provider attempt within an operation */
  attempt_id?: string;

  /** Correlation: set when this operation was spawned by another */
  parent_operation_id?: string;

  /** W3C Trace Context (traceparent + tracestate) */
  trace_context?: TraceContext;

  /** Monotonic within an operation, for ordering multi-emitter events */
  sequence?: number;

  /** Event-specific payload */
  data: TData;
}

/**
 * A convenience alias for events whose type parameter is not yet narrowed.
 * Useful when sinks receive events they may not understand and need to
 * pass them through opaquely.
 */
export type AnyObservabilityEvent = ObservabilityEvent<string, unknown>;
