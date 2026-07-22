/**
 * @llm-ports/observability-contract — public API.
 *
 * Standalone data contract for LLM observability. Zero peer dependency
 * on `@llm-ports/core`; non-port callers import types + emitter helpers
 * from here directly and emit conformant events to any
 * `ObservabilitySink` without needing to construct an LLM port.
 *
 * Alpha.28 initial exports (Plan 58 v0.4 §5.1). Subsequent alpha.28
 * commits add lifecycle event types (§4.3), ErrorInfo (§4.4), CacheStats
 * (§4.5), RequestFingerprint + canonicalization spec + golden vectors
 * (§4.6), EvaluationRef + EvaluationTarget union (§4.9), CapturePolicy
 * (§4.10), and the standalone emitter helpers.
 */

// ─── Contract version ───────────────────────────────────────────────
export { SPEC_VERSION } from "./version.js";

// ─── Event envelope (§4.1) ──────────────────────────────────────────
export type {
  AnyObservabilityEvent,
  EventSource,
  ObservabilityEvent,
} from "./envelope.js";

// ─── Correlation model (§4.2) ───────────────────────────────────────
export type {
  CorrelationContext,
  ObservabilityContext,
} from "./correlation.js";

// ─── W3C Trace Context + Baggage (§4.11) ────────────────────────────
export type { BaggageEntry, TraceContext } from "./trace-context.js";
export {
  BAGGAGE_MAX_BYTES,
  BAGGAGE_MAX_MEMBERS,
} from "./trace-context.js";

// ─── Sink interface (§4.12) ─────────────────────────────────────────
export type { ObservabilitySink } from "./sink.js";
export { createCollectingSink, noopSink } from "./sink.js";

// ─── ID helpers ─────────────────────────────────────────────────────
export {
  ATTEMPT_ID_LENGTH,
  EVALUATION_ID_LENGTH,
  EVENT_ID_LENGTH,
  newAttemptId,
  newEvaluationId,
  newEventId,
  newOperationId,
  OPERATION_ID_LENGTH,
} from "./ids.js";

// ─── Primitive shapes (usage / cost / priority) ─────────────────────
export type { CostUsage, LLMPriority, TokenUsage } from "./primitives.js";

// ─── ErrorInfo (§4.4) ───────────────────────────────────────────────
export { CAUSE_CATEGORIES, ERROR_TYPE_TO_CATEGORY, errorTypeToCauseCategory } from "./error-info.js";
export type { CauseCategory, ErrorInfo } from "./error-info.js";

// ─── CacheStats (§4.5) ──────────────────────────────────────────────
export { anyCacheHit, totalProviderCacheReadTokens } from "./cache-stats.js";
export type {
  CacheStats,
  ProviderCacheStats,
  ProviderCacheStatus,
  SemanticCacheStats,
  SemanticCacheStatus,
} from "./cache-stats.js";

// ─── Lifecycle events (§4.3 + §4.7 agent steps) ─────────────────────
export {
  LIFECYCLE_EVENT_TYPES,
  OPERATION_TERMINATOR_TYPES,
} from "./lifecycle.js";
export type {
  AgentStepCompletedData,
  AgentStepStartedData,
  AgentToolCalledData,
  AgentToolReturnedData,
  AttemptCompletedData,
  AttemptFailedData,
  AttemptRetryScheduledData,
  AttemptStartedData,
  FallbackCause,
  FallbackSelectedData,
  LifecycleEventDataByType,
  LifecycleEventType,
  OperationCancelledData,
  OperationCompletedData,
  OperationFailedData,
  OperationStartedData,
  RetryReason,
  TerminationStatus,
} from "./lifecycle.js";
