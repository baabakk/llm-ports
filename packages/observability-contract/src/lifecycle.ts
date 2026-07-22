/**
 * Lifecycle events per Plan 58 v0.4 §4.3.
 *
 * Nine event types cover the complete operation lifecycle. Each event
 * uses the canonical envelope from §4.1 with a specific payload shape.
 * A single logical operation produces many attempt-level events
 * (started + attempted + failed / completed + retried + fallback) and
 * exactly one operation-level terminator (completed / failed /
 * cancelled).
 *
 * Consumers subscribe to any subset:
 *   - Operation-level only for high-level dashboards.
 *   - Attempt-level for provider-health diagnostics.
 *   - Both for full-fidelity retention (BEPA + ADW cutover default).
 *
 * The operation vs attempt split at event level mirrors the
 * `operation_id` / `attempt_id` split in the correlation model (§4.2).
 * Aggregation is `operation_id`; per-attempt accounting is `attempt_id`.
 */

import type { CacheStats } from "./cache-stats.js";
import type { ErrorInfo } from "./error-info.js";
import type { CostUsage, LLMPriority, TokenUsage } from "./primitives.js";

// ─── Enum types used across lifecycle payloads ──────────────────────

/**
 * Why a retry was scheduled. Adapters emit these on
 * `llm.attempt.retry_scheduled` events. New reasons may be added; sinks
 * receiving unknown values should treat them as opaque.
 */
export type RetryReason =
  | "rate_limit_backoff"        // 429; observed retry-after honored
  | "transient_auth"            // 401 with a documented burst-protection pattern
  | "capability_fallback"       // parameter rejection; retried without offending param
  | "reasoning_starvation"      // reasoning model returned empty text; retried with expanded budget
  | "zero_tool_call_prose"      // model responded prose instead of using tools; corrective retry
  | "validation_feedback"       // structured-output validation failed; retried with feedback
  | "empty_response"            // provider returned empty visible text
  | "network_error";            // fetch-level or connect-level failure

/**
 * Why a fallback was selected. Adapters emit these on
 * `llm.fallback.selected` events.
 */
export type FallbackCause =
  | "rate_limit"                // 429 on the current provider; walk to next
  | "service_unavailable"       // 5xx on the current provider
  | "provider_unavailable"      // SDK-level unreachable
  | "context_window_exceeded"   // prompt too long for current provider's window
  | "content_policy"            // current provider rejected content
  | "credit_exhausted"          // current provider's account exhausted
  | "provider_malformed_400"    // current provider returned unparseable 400
  | "image_too_large"           // current provider's image limit exceeded
  | "content_block_unsupported" // current provider does not support a block kind
  | "budget_exceeded"           // per-provider request/cost gate tripped
  | "consumer_forced";          // consumer explicitly requested next provider

/**
 * How an operation terminated. Set on the operation-level terminator
 * event (llm.operation.completed / failed / cancelled).
 */
export type TerminationStatus = "completed" | "failed" | "cancelled";

// ─── Types imported from adjacent modules ───────────────────────────
//
// ErrorInfo (§4.4) is imported from error-info.ts; CacheStats (§4.5)
// is imported from cache-stats.ts. RequestFingerprint (§4.6) will
// arrive in a subsequent commit but is not carried on any lifecycle
// event payload — it lives on result objects.

// ─── Operation-level events (nine total: 3 operation + 6 attempt) ────

/**
 * `llm.operation.started` — the caller invoked a port method; before
 * any provider attempt fires. Every operation emits exactly one of
 * these as its first event.
 */
export interface OperationStartedData {
  /** Task type from the caller (e.g. "triage", "code-review"). */
  task_type: string;

  /** Optional priority hint from the caller. */
  priority?: LLMPriority;

  /**
   * The chain of provider aliases the registry will attempt in order.
   * Emitted at operation start so sinks see the intended path even if
   * the chain is not exhausted.
   */
  provider_chain: string[];

  /**
   * Adapter method being invoked (`generateText`, `generateStructured`,
   * `streamText`, `streamStructured`, `runAgent`).
   */
  method: "generateText" | "generateStructured" | "streamText" | "streamStructured" | "runAgent";
}

/**
 * `llm.attempt.started` — the registry begins one physical provider
 * attempt (initial or after a retry / fallback).
 */
export interface AttemptStartedData {
  /** Registry alias of the provider being attempted. */
  provider_alias: string;

  /** Concrete model ID as configured for this alias. */
  model_id: string;

  /**
   * 1-indexed attempt number within the operation. Retries increment;
   * fallbacks also increment (so the number is unique per attempt).
   */
  attempt_number: number;

  /** True when this attempt is a same-provider retry of an earlier one. */
  is_retry: boolean;

  /** True when this attempt was reached via fallback from a prior provider. */
  is_fallback: boolean;
}

/**
 * `llm.attempt.retry_scheduled` — the registry decided to retry the same
 * provider after a retriable error. Fires between `llm.attempt.failed`
 * and the next `llm.attempt.started`.
 */
export interface AttemptRetryScheduledData {
  /** Why this retry was scheduled. */
  retry_reason: RetryReason;

  /** Sleep duration before the next attempt (backoff-applied). */
  backoff_ms: number;

  /** 1-indexed attempt number the next `llm.attempt.started` will carry. */
  next_attempt_number: number;
}

/**
 * `llm.fallback.selected` — the registry decided to fall over to the
 * next provider in the chain. Fires between `llm.attempt.failed` (of
 * the from-provider) and the next `llm.attempt.started` (on the
 * to-provider).
 */
export interface FallbackSelectedData {
  /** Provider we walked away from. */
  from_provider_alias: string;

  /** Provider we walked to. */
  to_provider_alias: string;

  /** Reason the from-provider was walked away from. */
  cause: FallbackCause;
}

/**
 * `llm.attempt.failed` — a provider attempt terminated with a classified
 * error. Followed by either a retry (`llm.attempt.retry_scheduled`), a
 * fallback (`llm.fallback.selected`), or a terminal
 * `llm.operation.failed` if the chain is exhausted.
 */
export interface AttemptFailedData {
  /** Structured error data (ErrorInfo shape from §4.4). */
  error: ErrorInfo;

  /** Adapter-observed wall-clock latency for the attempt, milliseconds. */
  latency_ms: number;
}

/**
 * `llm.attempt.completed` — a provider attempt terminated with a usable
 * response. Followed by `llm.operation.completed` (in the common single-
 * attempt case) or by additional attempt events for orchestration
 * flows like `runAgent`'s tool loop.
 */
export interface AttemptCompletedData {
  /** Token usage the provider reported for this attempt. */
  usage: TokenUsage;

  /** USD cost computed from usage + pricing table. */
  cost: CostUsage;

  /** Adapter-observed wall-clock latency, milliseconds. */
  latency_ms: number;

  /** Cache accounting per §4.5 (placeholder shape until CacheStats commit). */
  cache_stats?: CacheStats;

  /**
   * Provider-issued response identifier when present (e.g. OpenAI's
   * `chatcmpl-123`, Anthropic's `request-id`).
   */
  provider_response_id?: string;

  /**
   * The final model ID as reported by the provider (may differ from
   * the requested `model_id` when the provider aliases models).
   */
  final_model_id: string;
}

/**
 * `llm.operation.completed` — the operation terminated with a final
 * successful response. Every non-cancelled successful operation emits
 * exactly one of these as its last event.
 */
export interface OperationCompletedData {
  /** Aggregate token usage across all attempts in the operation. */
  aggregate_usage: TokenUsage;

  /** Aggregate cost across all attempts. */
  aggregate_cost: CostUsage;

  /** Total number of provider attempts made (including retries and fallbacks). */
  attempts_made: number;

  /** The alias of the provider whose attempt succeeded. */
  final_provider_alias: string;

  /** Total wall-clock duration from operation start to completion. */
  total_duration_ms: number;

  /**
   * Compact summary of the result: `finish_reason` for chat completions,
   * `validation_attempts` for structured output, `steps_taken` for
   * runAgent, etc. Content-free.
   */
  result_summary?: Record<string, string | number>;
}

/**
 * `llm.operation.failed` — the operation terminated with an error and
 * no successful attempt. Emitted when the full provider chain is
 * exhausted or a non-retriable error aborted the operation.
 */
export interface OperationFailedData {
  /** The terminal error that caused the operation to abort. */
  error: ErrorInfo;

  /** How many attempts were made before the operation failed. */
  attempts_made: number;

  /** Provider aliases attempted (in order, may have repeats for retries). */
  providers_tried: string[];

  /** Total wall-clock duration until failure. */
  total_duration_ms: number;
}

/**
 * `llm.operation.cancelled` — the operation terminated via `AbortSignal`
 * or consumer-side cancellation. Distinct from `failed` because the
 * caller intentionally aborted; not a retryable condition.
 */
export interface OperationCancelledData {
  /**
   * 1-indexed attempt number at which cancellation was observed. Zero
   * when cancellation was observed before any provider attempt fired.
   */
  cancelled_at_attempt: number;

  /** Provider aliases attempted before the cancel arrived. */
  providers_tried_before_cancel: string[];

  /** Total wall-clock duration from operation start to cancel. */
  total_duration_ms: number;
}

// ─── Agent step events (Plan 58 v0.4 §4.7) ──────────────────────────

/**
 * `agent.step.started` — the runAgent loop begins one step. A step is
 * either an LLM turn (producing text and optionally tool calls) or a
 * tool invocation.
 */
export interface AgentStepStartedData {
  /** 1-indexed step number within the operation's agent loop. */
  step_index: number;

  /** What kind of step this is. */
  step_type: "llm" | "tool" | "validation";

  /** Tool name when step_type = "tool"; undefined otherwise. */
  tool_name?: string;
}

/**
 * `agent.step.completed` — the current step finished (successfully or
 * with an error already captured on `llm.attempt.failed`).
 */
export interface AgentStepCompletedData {
  step_index: number;

  duration_ms: number;

  /** Set on LLM steps that consumed provider tokens. */
  usage?: TokenUsage;

  /** Set when the step had a cost. */
  cost?: CostUsage;
}

/**
 * `agent.tool.called` — the model requested a tool invocation. Emitted
 * once per tool call the model produces on an LLM step.
 */
export interface AgentToolCalledData {
  tool_name: string;

  /** Provider-issued or synthesized tool-call identifier. */
  tool_call_id: string;

  /**
   * SHA-256 hex digest of the JSON-serialized arguments. Content-free
   * (arguments themselves are captured only under CapturePolicy.content).
   */
  arguments_digest: string;
}

/**
 * `agent.tool.returned` — a tool invocation completed. Fired once per
 * `agent.tool.called`.
 */
export interface AgentToolReturnedData {
  tool_name: string;

  tool_call_id: string;

  /** SHA-256 hex digest of the result payload. Content-free. */
  result_digest: string;

  duration_ms: number;

  /** Set when the tool threw or returned an error. */
  error?: ErrorInfo;
}

// ─── Union of all lifecycle event types (for switch narrowing) ───────

/**
 * Mapping from event-type name to its payload shape. Consumers use this
 * for typed switch narrowing on `event_type`.
 */
export interface LifecycleEventDataByType {
  "llm.operation.started": OperationStartedData;
  "llm.attempt.started": AttemptStartedData;
  "llm.attempt.retry_scheduled": AttemptRetryScheduledData;
  "llm.fallback.selected": FallbackSelectedData;
  "llm.attempt.failed": AttemptFailedData;
  "llm.attempt.completed": AttemptCompletedData;
  "llm.operation.completed": OperationCompletedData;
  "llm.operation.failed": OperationFailedData;
  "llm.operation.cancelled": OperationCancelledData;
  "agent.step.started": AgentStepStartedData;
  "agent.step.completed": AgentStepCompletedData;
  "agent.tool.called": AgentToolCalledData;
  "agent.tool.returned": AgentToolReturnedData;
}

/** Every lifecycle event type name as a string literal union. */
export type LifecycleEventType = keyof LifecycleEventDataByType;

/**
 * All lifecycle event type names as a readonly array. Consumers iterate
 * this for exhaustiveness checks or event-type enumeration.
 */
export const LIFECYCLE_EVENT_TYPES: readonly LifecycleEventType[] = [
  "llm.operation.started",
  "llm.attempt.started",
  "llm.attempt.retry_scheduled",
  "llm.fallback.selected",
  "llm.attempt.failed",
  "llm.attempt.completed",
  "llm.operation.completed",
  "llm.operation.failed",
  "llm.operation.cancelled",
  "agent.step.started",
  "agent.step.completed",
  "agent.tool.called",
  "agent.tool.returned",
] as const;

/**
 * True for the three operation-level terminator events. Consumers
 * building an operation index use this to know when an operation is
 * definitely done.
 */
export const OPERATION_TERMINATOR_TYPES: readonly LifecycleEventType[] = [
  "llm.operation.completed",
  "llm.operation.failed",
  "llm.operation.cancelled",
] as const;
