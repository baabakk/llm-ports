/**
 * Correlation model per Plan 58 v0.4 §4.2.
 *
 * Splits logical operation identity from physical attempt identity.
 * One user-visible operation (e.g. "triage this email") can involve:
 *
 *   1. Initial OpenAI attempt      (attempt_id: "att-A")
 *   2. OpenAI retry after 429       (attempt_id: "att-B")
 *   3. Fallback attempt to Anthropic (attempt_id: "att-C")
 *   4. Anthropic validation retry    (attempt_id: "att-D")
 *   5. Success
 *
 * All five share one `operation_id`; each has a distinct `attempt_id`.
 * The shared operation ID enables aggregation (total cost, total
 * latency); distinct attempt IDs enable per-attempt accounting.
 */

import type { BaggageEntry } from "./trace-context.js";

/**
 * The correlation state associated with an in-flight or completed
 * observability event. Threaded through every event via the envelope.
 */
export interface CorrelationContext {
  /**
   * One logical LLM operation: from caller intent to final answer
   * (successful or failed after retries + fallbacks). Port-issued
   * (nanoid) unless the caller supplied one via ObservabilityContext.
   */
  operation_id: string;

  /**
   * One physical provider attempt: one HTTP call. Set on every
   * attempt-level event. Absent on operation-level events that
   * don't attribute to a specific attempt.
   */
  attempt_id?: string;

  /**
   * Set when this operation was spawned by another (nested agent call,
   * tool call, sub-operation). Points at the spawning operation.
   */
  parent_operation_id?: string;

  /**
   * Convenience: the top of the operation tree. For a non-nested
   * operation, this equals `operation_id`. For nested operations,
   * consumers can index on `root_operation_id` to gather every event
   * from a whole workflow into one query.
   */
  root_operation_id?: string;

  /**
   * Provider-issued response identifier (e.g. OpenAI's "chatcmpl-123",
   * Anthropic's request-id). Present only when the provider returned
   * one. Distinct from `attempt_id` (which is port-issued and always
   * present on attempts).
   */
  provider_request_id?: string;

  /**
   * Optional caller-supplied conversation identifier for tying
   * multiple operations to a single conversation (chat threads,
   * interview sessions, coaching workflows).
   */
  conversation_id?: string;
}

/**
 * Caller-provided context passed through the scoped-port wrapper
 * `withObservabilityContext(port, context)`. Lives in @llm-ports/core;
 * this type is the shape the port accepts.
 *
 * Non-port callers construct this same shape and pass it to their own
 * emitter helpers (per §4.13 standalone data contract commitment).
 */
export interface ObservabilityContext {
  /** If set, port preserves it; otherwise port generates one. */
  operation_id?: string;

  /** For nested operations spawned from a parent. */
  parent_operation_id?: string;

  /** W3C Trace Context traceparent (string form) */
  traceparent?: string;

  /** W3C Trace Context tracestate (string form) */
  tracestate?: string;

  /** W3C Baggage entries; propagated per CapturePolicy.baggage_allowlist */
  baggage?: BaggageEntry[];

  /**
   * Free-form attributes attached to every event emitted under this
   * context. Consumers use this for per-workload tagging. Propagated
   * per CapturePolicy.metadata_allowlist.
   */
  attributes?: Record<string, string | number | boolean>;

  /**
   * When set, the port uses this HMAC key for `hash_algorithm:
   * "hmac-sha256"` fingerprints. Otherwise the fingerprint falls back
   * to `sha256`.
   */
  fingerprint_key?: string;

  /**
   * Optional caller-supplied conversation identifier that threads into
   * the resulting `CorrelationContext.conversation_id`.
   */
  conversation_id?: string;
}
