/**
 * Zod validation schemas for every type in the contract.
 *
 * These are the runtime validators for events crossing consumer
 * boundaries. Downstream sinks (ClickHouse ingestion, OTel adapter,
 * consumer-supplied storage) can call `.parse()` on incoming events
 * to reject malformed payloads at the sink layer.
 *
 * Every schema mirrors its TypeScript type from the adjacent module.
 * Type inference via `z.infer<>` recovers the original type so the
 * schemas are usable in both directions (validate at runtime, infer
 * types at compile time).
 *
 * Zod version compatibility: the peer-dep range is `zod >= 3.24.0 < 5`.
 * The schemas use only surface that is stable across v3 and v4 (no
 * v4-specific `discriminatedUnion` shape changes).
 */

import { z } from "zod";
import { CAUSE_CATEGORIES } from "./error-info.js";
import {
  EVALUATION_EVENT_TYPE,
  EVALUATION_SCORE_TYPES,
  EVALUATION_TARGET_KINDS,
} from "./evaluation.js";
import { LIFECYCLE_EVENT_TYPES } from "./lifecycle.js";

// ─── Foundation schemas ─────────────────────────────────────────────

export const eventSourceSchema = z.object({
  library: z.string().min(1),
  library_version: z.string().min(1),
  component: z.string().optional(),
  runtime: z.string().optional(),
});

export const traceContextSchema = z.object({
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
});

export const baggageEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  properties: z
    .array(z.object({ key: z.string(), value: z.string().optional() }))
    .optional(),
});

export const correlationContextSchema = z.object({
  operation_id: z.string().min(1),
  attempt_id: z.string().optional(),
  parent_operation_id: z.string().optional(),
  root_operation_id: z.string().optional(),
  provider_request_id: z.string().optional(),
  conversation_id: z.string().optional(),
});

export const observabilityContextSchema = z.object({
  operation_id: z.string().optional(),
  parent_operation_id: z.string().optional(),
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
  baggage: z.array(baggageEntrySchema).optional(),
  attributes: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  fingerprint_key: z.string().optional(),
  conversation_id: z.string().optional(),
});

// ─── Primitive schemas ──────────────────────────────────────────────

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
});

export const costUsageSchema = z.object({
  inputUSD: z.number().nonnegative(),
  outputUSD: z.number().nonnegative(),
  totalUSD: z.number().nonnegative(),
  savingsUSD: z.number().nonnegative().optional(),
});

export const llmPrioritySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

// ─── ErrorInfo schema ───────────────────────────────────────────────

export const causeCategorySchema = z.enum(
  CAUSE_CATEGORIES as unknown as [string, ...string[]],
);

export const errorInfoSchema = z.object({
  error_type: z.string().min(1),
  message: z.string().optional(),
  retryable: z.boolean(),
  fallback_worthy: z.boolean(),
  cause_category: causeCategorySchema,
  provider_status_code: z.number().int().optional(),
  retry_after_ms: z.number().nonnegative().optional(),
  provider_error_code: z.string().optional(),
  details_redacted: z.boolean().optional(),
});

// ─── CacheStats schemas ─────────────────────────────────────────────

export const providerCacheStatusSchema = z.enum([
  "hit",
  "miss",
  "partial",
  "ineligible",
  "unknown",
]);

export const semanticCacheStatusSchema = z.enum([
  "hit",
  "miss",
  "bypassed",
  "unknown",
]);

export const providerCacheStatsSchema = z.object({
  status: providerCacheStatusSchema,
  read_input_tokens: z.number().int().nonnegative().optional(),
  write_input_tokens: z.number().int().nonnegative().optional(),
  write_5m_input_tokens: z.number().int().nonnegative().optional(),
  write_1h_input_tokens: z.number().int().nonnegative().optional(),
  provider_reported: z.boolean(),
});

export const semanticCacheStatsSchema = z.object({
  status: semanticCacheStatusSchema,
  similarity: z.number().min(0).max(1).optional(),
  key_hash: z.string().optional(),
  lookup_latency_ms: z.number().nonnegative().optional(),
});

export const cacheStatsSchema = z.object({
  provider_cache: providerCacheStatsSchema.optional(),
  semantic_cache: semanticCacheStatsSchema.optional(),
});

// ─── RequestFingerprint schema ──────────────────────────────────────

export const hashAlgorithmSchema = z.enum(["sha256", "hmac-sha256"]);

/** 64-character lowercase hex string. */
const hex64Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be 64-char lowercase hex");

export const requestFingerprintSchema = z.object({
  message_hash: hex64Schema,
  request_hash: hex64Schema,
  normalization_version: z.string().min(1),
  hash_algorithm: hashAlgorithmSchema,
  input_char_count: z.number().int().nonnegative().optional(),
  prompt_id: z.string().optional(),
  prompt_version: z.string().optional(),
});

// ─── Evaluation schemas ─────────────────────────────────────────────

export const evaluationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operation"), id: z.string().min(1) }),
  z.object({ kind: z.literal("attempt"), id: z.string().min(1) }),
  z.object({ kind: z.literal("response"), id: z.string().min(1) }),
  z.object({ kind: z.literal("agent_step"), id: z.string().min(1) }),
  z.object({ kind: z.literal("trace"), id: z.string().min(1) }),
  z.object({ kind: z.literal("session"), id: z.string().min(1) }),
  z.object({ kind: z.literal("artifact"), id: z.string().min(1) }),
]);

export const evaluationScoreSchema = z.discriminatedUnion("score_type", [
  z.object({
    score_type: z.literal("numeric"),
    value: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({ score_type: z.literal("boolean"), value: z.boolean() }),
  z.object({ score_type: z.literal("categorical"), value: z.string().min(1) }),
  z.object({ score_type: z.literal("text"), value: z.string() }),
]);

export const evaluationSourceSchema = z.enum(["human", "model", "rule", "api"]);

export const evaluationRefSchema = z.object({
  evaluation_id: z.string().min(1),
  target: evaluationTargetSchema,
  evaluator_name: z.string().min(1),
  evaluator_version: z.string().optional(),
  rubric_id: z.string().optional(),
  rubric_version: z.string().optional(),
  score: evaluationScoreSchema,
  source: evaluationSourceSchema,
  explanation: z.string().optional(),
  correction: z.unknown().optional(),
  occurred_at: z.string().min(1),
  idempotency_key: z.string().optional(),
});

// ─── CapturePolicy schema ───────────────────────────────────────────

export const contentCaptureSchema = z.enum(["none", "metadata_only", "redacted", "full"]);

export const fingerprintCaptureSchema = z.enum(["disabled", "sha256", "hmac_sha256"]);

export const errorBodyCaptureSchema = z.enum(["none", "redacted", "full"]);

export const streamChunkCaptureSchema = z.enum(["off", "sampled", "full"]);

/**
 * Schema for CapturePolicy WITHOUT the redactor function (functions
 * cannot be JSON-serialized). Consumers persisting a policy to config
 * files validate against this; policies with redactors are runtime-
 * only.
 */
export const capturePolicySerializableSchema = z.object({
  content: contentCaptureSchema,
  fingerprint: fingerprintCaptureSchema,
  fingerprint_key: z.string().optional(),
  baggage_allowlist: z.array(z.string()),
  metadata_allowlist: z.array(z.string()).optional(),
  error_body_capture: errorBodyCaptureSchema,
  stream_chunk_capture: streamChunkCaptureSchema,
});

// ─── Lifecycle event data schemas ───────────────────────────────────

const retryReasonSchema = z.enum([
  "rate_limit_backoff",
  "transient_auth",
  "capability_fallback",
  "reasoning_starvation",
  "zero_tool_call_prose",
  "validation_feedback",
  "empty_response",
  "network_error",
]);

const fallbackCauseSchema = z.enum([
  "rate_limit",
  "service_unavailable",
  "provider_unavailable",
  "context_window_exceeded",
  "content_policy",
  "credit_exhausted",
  "provider_malformed_400",
  "image_too_large",
  "content_block_unsupported",
  "budget_exceeded",
  "consumer_forced",
]);

const methodSchema = z.enum([
  "generateText",
  "generateStructured",
  "streamText",
  "streamStructured",
  "runAgent",
]);

export const operationStartedDataSchema = z.object({
  task_type: z.string().min(1),
  priority: llmPrioritySchema.optional(),
  provider_chain: z.array(z.string().min(1)),
  method: methodSchema,
});

export const attemptStartedDataSchema = z.object({
  provider_alias: z.string().min(1),
  model_id: z.string().min(1),
  attempt_number: z.number().int().positive(),
  is_retry: z.boolean(),
  is_fallback: z.boolean(),
});

export const attemptRetryScheduledDataSchema = z.object({
  retry_reason: retryReasonSchema,
  backoff_ms: z.number().nonnegative(),
  next_attempt_number: z.number().int().positive(),
});

export const fallbackSelectedDataSchema = z.object({
  from_provider_alias: z.string().min(1),
  to_provider_alias: z.string().min(1),
  cause: fallbackCauseSchema,
});

export const attemptFailedDataSchema = z.object({
  error: errorInfoSchema,
  latency_ms: z.number().nonnegative(),
});

export const attemptCompletedDataSchema = z.object({
  usage: tokenUsageSchema,
  cost: costUsageSchema,
  latency_ms: z.number().nonnegative(),
  cache_stats: cacheStatsSchema.optional(),
  provider_response_id: z.string().optional(),
  final_model_id: z.string().min(1),
});

export const operationCompletedDataSchema = z.object({
  aggregate_usage: tokenUsageSchema,
  aggregate_cost: costUsageSchema,
  attempts_made: z.number().int().nonnegative(),
  final_provider_alias: z.string().min(1),
  total_duration_ms: z.number().nonnegative(),
  result_summary: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export const operationFailedDataSchema = z.object({
  error: errorInfoSchema,
  attempts_made: z.number().int().nonnegative(),
  providers_tried: z.array(z.string()),
  total_duration_ms: z.number().nonnegative(),
});

export const operationCancelledDataSchema = z.object({
  cancelled_at_attempt: z.number().int().nonnegative(),
  providers_tried_before_cancel: z.array(z.string()),
  total_duration_ms: z.number().nonnegative(),
});

export const agentStepStartedDataSchema = z.object({
  step_index: z.number().int().positive(),
  step_type: z.enum(["llm", "tool", "validation"]),
  tool_name: z.string().optional(),
});

export const agentStepCompletedDataSchema = z.object({
  step_index: z.number().int().positive(),
  duration_ms: z.number().nonnegative(),
  usage: tokenUsageSchema.optional(),
  cost: costUsageSchema.optional(),
});

export const agentToolCalledDataSchema = z.object({
  tool_name: z.string().min(1),
  tool_call_id: z.string().min(1),
  arguments_digest: z.string().min(1),
});

export const agentToolReturnedDataSchema = z.object({
  tool_name: z.string().min(1),
  tool_call_id: z.string().min(1),
  result_digest: z.string().min(1),
  duration_ms: z.number().nonnegative(),
  error: errorInfoSchema.optional(),
});

// ─── Envelope schema (generic over event_type + data) ───────────────

/**
 * Base envelope schema without the discriminated `data` shape. Used
 * as a common prefix; each event-type schema layers on top.
 */
const envelopeBaseSchema = z.object({
  spec_version: z.string().min(1),
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string().min(1),
  emitted_at: z.string().min(1),
  source: eventSourceSchema,
  operation_id: z.string().min(1),
  attempt_id: z.string().optional(),
  parent_operation_id: z.string().optional(),
  trace_context: traceContextSchema.optional(),
  sequence: z.number().int().nonnegative().optional(),
});

/**
 * Build a lifecycle event schema that pairs the envelope with the
 * correct data shape for a given event_type. Consumers who need typed
 * validation call the returned schema's `.parse()`.
 */
export function eventSchemaFor<TType extends string, TData extends z.ZodTypeAny>(
  eventType: TType,
  dataSchema: TData,
): z.ZodObject<{
  spec_version: z.ZodString;
  event_id: z.ZodString;
  event_type: z.ZodLiteral<TType>;
  occurred_at: z.ZodString;
  emitted_at: z.ZodString;
  source: typeof eventSourceSchema;
  operation_id: z.ZodString;
  attempt_id: z.ZodOptional<z.ZodString>;
  parent_operation_id: z.ZodOptional<z.ZodString>;
  trace_context: z.ZodOptional<typeof traceContextSchema>;
  sequence: z.ZodOptional<z.ZodNumber>;
  data: TData;
}> {
  return envelopeBaseSchema.extend({
    event_type: z.literal(eventType),
    data: dataSchema,
  }) as never;
}

/**
 * Map from event_type to its full envelope+data schema. Consumers
 * pick the right schema by event_type at validation time.
 */
export const lifecycleEventSchemas = {
  "llm.operation.started": eventSchemaFor("llm.operation.started", operationStartedDataSchema),
  "llm.attempt.started": eventSchemaFor("llm.attempt.started", attemptStartedDataSchema),
  "llm.attempt.retry_scheduled": eventSchemaFor(
    "llm.attempt.retry_scheduled",
    attemptRetryScheduledDataSchema,
  ),
  "llm.fallback.selected": eventSchemaFor("llm.fallback.selected", fallbackSelectedDataSchema),
  "llm.attempt.failed": eventSchemaFor("llm.attempt.failed", attemptFailedDataSchema),
  "llm.attempt.completed": eventSchemaFor("llm.attempt.completed", attemptCompletedDataSchema),
  "llm.operation.completed": eventSchemaFor(
    "llm.operation.completed",
    operationCompletedDataSchema,
  ),
  "llm.operation.failed": eventSchemaFor("llm.operation.failed", operationFailedDataSchema),
  "llm.operation.cancelled": eventSchemaFor(
    "llm.operation.cancelled",
    operationCancelledDataSchema,
  ),
  "agent.step.started": eventSchemaFor("agent.step.started", agentStepStartedDataSchema),
  "agent.step.completed": eventSchemaFor("agent.step.completed", agentStepCompletedDataSchema),
  "agent.tool.called": eventSchemaFor("agent.tool.called", agentToolCalledDataSchema),
  "agent.tool.returned": eventSchemaFor("agent.tool.returned", agentToolReturnedDataSchema),
};

// Sanity: every LIFECYCLE_EVENT_TYPES entry has a corresponding schema.
for (const t of LIFECYCLE_EVENT_TYPES) {
  if (!(t in lifecycleEventSchemas)) {
    // Fail loudly at import time if the developer added a new event
    // type without a matching schema.
    throw new Error(
      `lifecycleEventSchemas is missing an entry for event_type "${t}"; ` +
        `every LIFECYCLE_EVENT_TYPES entry must have a schema.`,
    );
  }
}

/**
 * Evaluation event schema (evaluation.recorded).
 */
export const evaluationEventSchema = eventSchemaFor(
  EVALUATION_EVENT_TYPE,
  evaluationRefSchema,
);

/**
 * Loose envelope schema: accepts any event_type + any data. Used at
 * sink boundaries to peel the envelope first, then dispatch to the
 * per-event-type schema for typed validation.
 */
export const anyObservabilityEventSchema = envelopeBaseSchema.extend({
  data: z.unknown(),
});

// Assert every EVALUATION_TARGET_KINDS entry is representable in the
// evaluationTargetSchema union (import-time check).
for (const kind of EVALUATION_TARGET_KINDS) {
  const parsed = evaluationTargetSchema.safeParse({ kind, id: "x" });
  if (!parsed.success) {
    throw new Error(
      `evaluationTargetSchema does not accept EVALUATION_TARGET_KINDS entry "${kind}"; ` +
        `schema is out of sync with the enum.`,
    );
  }
}

for (const scoreType of EVALUATION_SCORE_TYPES) {
  const dummy =
    scoreType === "numeric"
      ? { score_type: "numeric" as const, value: 0 }
      : scoreType === "boolean"
        ? { score_type: "boolean" as const, value: true }
        : { score_type: scoreType, value: "x" };
  const parsed = evaluationScoreSchema.safeParse(dummy);
  if (!parsed.success) {
    throw new Error(
      `evaluationScoreSchema does not accept EVALUATION_SCORE_TYPES entry "${scoreType}"; ` +
        `schema is out of sync with the enum.`,
    );
  }
}
