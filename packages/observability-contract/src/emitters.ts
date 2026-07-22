/**
 * Emitter helpers per Plan 58 v0.4 §4.13.
 *
 * Convenience constructors that assemble a full envelope + payload +
 * IDs + timestamps + source attribution into an
 * `ObservabilityEvent<TType, TData>` and forward it to an
 * `ObservabilitySink`.
 *
 * Non-port callers (per §4.13 standalone data contract commitment)
 * import these helpers and emit conformant events without any
 * dependency on `@llm-ports/core`. The canonical use case is ADW's
 * `ClaudeCodeDriver` subprocess path: it never constructs an LLM port,
 * but with these helpers it emits the same event schema as an
 * in-process port-routed call.
 *
 * The helpers are deliberately thin. They fill in the envelope
 * boilerplate (event_id, spec_version, occurred_at, emitted_at,
 * source) and delegate to the sink. They do NOT apply CapturePolicy
 * transforms (that is the caller's responsibility, as CapturePolicy
 * is a caller-side decision).
 */

import type { CorrelationContext, ObservabilityContext } from "./correlation.js";
import type { AnyObservabilityEvent, EventSource, ObservabilityEvent } from "./envelope.js";
import { EVALUATION_EVENT_TYPE, type EvaluationRef } from "./evaluation.js";
import { newEventId } from "./ids.js";
import type { LifecycleEventDataByType, LifecycleEventType } from "./lifecycle.js";
import type { ObservabilitySink } from "./sink.js";
import { SPEC_VERSION } from "./version.js";

/**
 * Static configuration for a batch of emissions. Consumers construct
 * one of these at setup time and reuse it across events.
 */
export interface EmitterConfig {
  /** The source identity carried on every event. Required. */
  source: EventSource;

  /** The sink events land in. Required. */
  sink: ObservabilitySink;

  /**
   * Optional: override `spec_version`. When omitted, the emitter
   * stamps the current contract SPEC_VERSION. Useful for testing
   * spec-version-migration paths.
   */
  spec_version?: string;

  /**
   * Optional: clock override for `occurred_at` and `emitted_at`.
   * Consumers running deterministic tests inject a fixed clock.
   * Default: () => new Date().toISOString().
   */
  now?: () => string;
}

/**
 * The default clock. Real wall time.
 */
const defaultNow = (): string => new Date().toISOString();

/**
 * Build an envelope + data pair without emitting. Useful for tests
 * that want to inspect what would be emitted, or for callers who
 * want to buffer events before flushing to a sink.
 */
export function buildEvent<TType extends string, TData>(
  config: Pick<EmitterConfig, "source" | "spec_version" | "now">,
  eventType: TType,
  correlation: CorrelationContext,
  data: TData,
  extras: Partial<Pick<ObservabilityEvent<TType, TData>, "trace_context" | "sequence">> = {},
): ObservabilityEvent<TType, TData> {
  const now = config.now ?? defaultNow;
  const timestamp = now();
  const event: ObservabilityEvent<TType, TData> = {
    spec_version: config.spec_version ?? SPEC_VERSION,
    event_id: newEventId(),
    event_type: eventType,
    occurred_at: timestamp,
    emitted_at: timestamp,
    source: config.source,
    operation_id: correlation.operation_id,
    data,
  };
  if (correlation.attempt_id !== undefined) event.attempt_id = correlation.attempt_id;
  if (correlation.parent_operation_id !== undefined) {
    event.parent_operation_id = correlation.parent_operation_id;
  }
  if (extras.trace_context !== undefined) event.trace_context = extras.trace_context;
  if (extras.sequence !== undefined) event.sequence = extras.sequence;
  return event;
}

/**
 * Emit a typed lifecycle event. Payload shape is inferred from the
 * event_type via `LifecycleEventDataByType`.
 */
export function emitLifecycleEvent<TType extends LifecycleEventType>(
  config: EmitterConfig,
  eventType: TType,
  correlation: CorrelationContext,
  data: LifecycleEventDataByType[TType],
  extras?: Partial<Pick<ObservabilityEvent<TType, LifecycleEventDataByType[TType]>, "trace_context" | "sequence">>,
): void | Promise<void> {
  const event = buildEvent(config, eventType, correlation, data, extras);
  return config.sink.emit(event);
}

/**
 * Emit an evaluation event. The evaluator constructs an EvaluationRef
 * (target + score + provenance) and this helper wraps it in an
 * envelope keyed on the target's addressable ID.
 *
 * For `target.kind = "operation"` or `"attempt"`, the envelope's
 * `operation_id` / `attempt_id` are set from the target. For other
 * target kinds (response, agent_step, trace, session, artifact),
 * the caller MUST supply a `correlation` object; the envelope's
 * operation_id comes from there.
 */
export function emitEvaluation(
  config: EmitterConfig,
  ref: EvaluationRef,
  correlation?: CorrelationContext,
  extras?: Partial<Pick<ObservabilityEvent<typeof EVALUATION_EVENT_TYPE, EvaluationRef>, "trace_context" | "sequence">>,
): void | Promise<void> {
  const derived = deriveCorrelationFromRef(ref, correlation);
  const event = buildEvent(config, EVALUATION_EVENT_TYPE, derived, ref, extras);
  return config.sink.emit(event);
}

/**
 * Given an EvaluationRef and an optional supplemental correlation,
 * return the correlation context to stamp on the envelope. For
 * operation- and attempt-kind targets, the target's id is the
 * operation_id / attempt_id. For other target kinds, the supplemental
 * correlation is required.
 */
function deriveCorrelationFromRef(
  ref: EvaluationRef,
  supplemental?: CorrelationContext,
): CorrelationContext {
  switch (ref.target.kind) {
    case "operation":
      return {
        operation_id: ref.target.id,
        ...(supplemental?.parent_operation_id !== undefined && {
          parent_operation_id: supplemental.parent_operation_id,
        }),
      };
    case "attempt":
      if (!supplemental?.operation_id) {
        throw new Error(
          "emitEvaluation: target.kind='attempt' requires a supplemental " +
            "correlation with an operation_id (the attempt's parent operation).",
        );
      }
      return {
        operation_id: supplemental.operation_id,
        attempt_id: ref.target.id,
      };
    case "response":
    case "agent_step":
    case "trace":
    case "session":
    case "artifact":
      if (!supplemental?.operation_id) {
        throw new Error(
          `emitEvaluation: target.kind='${ref.target.kind}' requires a supplemental ` +
            "correlation with an operation_id.",
        );
      }
      return {
        operation_id: supplemental.operation_id,
        ...(supplemental.attempt_id !== undefined && { attempt_id: supplemental.attempt_id }),
      };
  }
}

/**
 * Derive a `CorrelationContext` from a caller-provided
 * `ObservabilityContext`. Consumers who plumbed context via
 * `withObservabilityContext(port, context)` in the port world can use
 * this to produce the same correlation shape for non-port emissions.
 *
 * When `context.operation_id` is provided, it is preserved. Otherwise
 * the caller MUST supply a fresh operation_id via the fallback
 * argument.
 */
export function correlationFromContext(
  context: ObservabilityContext,
  fallback: { operation_id: string; attempt_id?: string },
): CorrelationContext {
  return {
    operation_id: context.operation_id ?? fallback.operation_id,
    ...(fallback.attempt_id !== undefined && { attempt_id: fallback.attempt_id }),
    ...(context.parent_operation_id !== undefined && {
      parent_operation_id: context.parent_operation_id,
    }),
    ...(context.conversation_id !== undefined && { conversation_id: context.conversation_id }),
  };
}

/**
 * Emit a raw envelope. Consumers building framework-specific integrations
 * (e.g. wrapping a subprocess adapter, forwarding from a middleware
 * chain) use this to bypass the type-safe helpers when they've
 * already assembled the envelope themselves.
 */
export function emitRaw(config: EmitterConfig, event: AnyObservabilityEvent): void | Promise<void> {
  return config.sink.emit(event);
}
