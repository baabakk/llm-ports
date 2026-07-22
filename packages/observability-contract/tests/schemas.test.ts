/**
 * Schema validation tests. For every schema, verify:
 *   - well-formed inputs parse successfully
 *   - malformed inputs fail parsing at the expected field
 *   - the round-trip type inference matches the manual type
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentToolCalledDataSchema,
  anyObservabilityEventSchema,
  attemptCompletedDataSchema,
  attemptFailedDataSchema,
  attemptRetryScheduledDataSchema,
  attemptStartedDataSchema,
  baggageEntrySchema,
  cacheStatsSchema,
  capturePolicySerializableSchema,
  causeCategorySchema,
  contentCaptureSchema,
  correlationContextSchema,
  costUsageSchema,
  errorBodyCaptureSchema,
  errorInfoSchema,
  evaluationEventSchema,
  evaluationRefSchema,
  evaluationScoreSchema,
  evaluationTargetSchema,
  eventSourceSchema,
  fallbackSelectedDataSchema,
  fingerprintCaptureSchema,
  hashAlgorithmSchema,
  lifecycleEventSchemas,
  llmPrioritySchema,
  newAttemptId,
  newEvaluationId,
  newEventId,
  newOperationId,
  observabilityContextSchema,
  operationCancelledDataSchema,
  operationCompletedDataSchema,
  operationFailedDataSchema,
  operationStartedDataSchema,
  providerCacheStatsSchema,
  requestFingerprintSchema,
  SPEC_VERSION,
  streamChunkCaptureSchema,
  tokenUsageSchema,
  traceContextSchema,
} from "../src/index.js";

describe("Zod validation schemas (§4.1 through §4.10)", () => {
  describe("Foundation schemas", () => {
    it("eventSourceSchema accepts a well-formed source", () => {
      expect(() =>
        eventSourceSchema.parse({
          library: "@llm-ports/core",
          library_version: "0.1.0-alpha.28",
          component: "registry",
          runtime: "node@22.11",
        }),
      ).not.toThrow();
    });

    it("eventSourceSchema rejects missing library field", () => {
      expect(() => eventSourceSchema.parse({ library_version: "1.0.0" })).toThrow();
    });

    it("traceContextSchema accepts both fields present or absent", () => {
      expect(() => traceContextSchema.parse({})).not.toThrow();
      expect(() => traceContextSchema.parse({ traceparent: "00-..." })).not.toThrow();
      expect(() =>
        traceContextSchema.parse({ traceparent: "x", tracestate: "y" }),
      ).not.toThrow();
    });

    it("baggageEntrySchema requires a non-empty key", () => {
      expect(() => baggageEntrySchema.parse({ key: "tenant_id", value: "acme" })).not.toThrow();
      expect(() => baggageEntrySchema.parse({ key: "", value: "x" })).toThrow();
    });

    it("correlationContextSchema requires operation_id, allows the six optional fields", () => {
      expect(() => correlationContextSchema.parse({ operation_id: "op-1" })).not.toThrow();
      expect(() =>
        correlationContextSchema.parse({
          operation_id: "op-1",
          attempt_id: "att-1",
          parent_operation_id: "op-parent",
          root_operation_id: "op-root",
          provider_request_id: "chatcmpl-abc",
          conversation_id: "conv-42",
        }),
      ).not.toThrow();
      expect(() => correlationContextSchema.parse({})).toThrow();
    });

    it("observabilityContextSchema accepts an empty object (all fields optional)", () => {
      expect(() => observabilityContextSchema.parse({})).not.toThrow();
    });

    it("observabilityContextSchema validates attributes are string|number|boolean", () => {
      expect(() =>
        observabilityContextSchema.parse({
          attributes: { tier: "gold", price: 100, admin: true },
        }),
      ).not.toThrow();
      expect(() =>
        observabilityContextSchema.parse({ attributes: { nested: { bad: "shape" } } }),
      ).toThrow();
    });
  });

  describe("Primitive schemas", () => {
    it("tokenUsageSchema requires non-negative integer counts", () => {
      expect(() =>
        tokenUsageSchema.parse({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      ).not.toThrow();
      expect(() =>
        tokenUsageSchema.parse({ inputTokens: -1, outputTokens: 50, totalTokens: 49 }),
      ).toThrow();
      expect(() =>
        tokenUsageSchema.parse({ inputTokens: 1.5, outputTokens: 50, totalTokens: 51.5 }),
      ).toThrow();
    });

    it("costUsageSchema requires non-negative USD values", () => {
      expect(() =>
        costUsageSchema.parse({ inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 }),
      ).not.toThrow();
      expect(() =>
        costUsageSchema.parse({ inputUSD: -1, outputUSD: 0, totalUSD: -1 }),
      ).toThrow();
    });

    it("llmPrioritySchema accepts 0-3 exactly", () => {
      expect(() => llmPrioritySchema.parse(0)).not.toThrow();
      expect(() => llmPrioritySchema.parse(3)).not.toThrow();
      expect(() => llmPrioritySchema.parse(4)).toThrow();
      expect(() => llmPrioritySchema.parse(-1)).toThrow();
    });
  });

  describe("ErrorInfo schema", () => {
    it("accepts the minimum-required fields", () => {
      expect(() =>
        errorInfoSchema.parse({
          error_type: "RateLimitError",
          retryable: true,
          fallback_worthy: true,
          cause_category: "provider_capacity",
        }),
      ).not.toThrow();
    });

    it("rejects invalid cause_category", () => {
      expect(() =>
        errorInfoSchema.parse({
          error_type: "RateLimitError",
          retryable: true,
          fallback_worthy: true,
          cause_category: "not-a-valid-category",
        }),
      ).toThrow();
    });

    it("causeCategorySchema accepts all 8 documented values", () => {
      for (const cat of [
        "client_input",
        "provider_capacity",
        "provider_auth",
        "provider_unavailable",
        "provider_capability",
        "network",
        "port_internal",
        "unknown",
      ]) {
        expect(() => causeCategorySchema.parse(cat)).not.toThrow();
      }
    });
  });

  describe("CacheStats schema", () => {
    it("accepts an empty stats object", () => {
      expect(() => cacheStatsSchema.parse({})).not.toThrow();
    });

    it("providerCacheStatsSchema requires status + provider_reported", () => {
      expect(() =>
        providerCacheStatsSchema.parse({ status: "hit", provider_reported: true }),
      ).not.toThrow();
      expect(() =>
        providerCacheStatsSchema.parse({ status: "hit" }),
      ).toThrow(); // missing provider_reported
    });

    it("semanticCacheStatsSchema similarity must be in [0,1]", () => {
      expect(() =>
        cacheStatsSchema.parse({ semantic_cache: { status: "hit", similarity: 0.5 } }),
      ).not.toThrow();
      expect(() =>
        cacheStatsSchema.parse({ semantic_cache: { status: "hit", similarity: 1.5 } }),
      ).toThrow();
      expect(() =>
        cacheStatsSchema.parse({ semantic_cache: { status: "hit", similarity: -0.1 } }),
      ).toThrow();
    });
  });

  describe("RequestFingerprint schema", () => {
    it("accepts a well-formed fingerprint", () => {
      expect(() =>
        requestFingerprintSchema.parse({
          message_hash: "a".repeat(64),
          request_hash: "b".repeat(64),
          normalization_version: "1",
          hash_algorithm: "sha256",
          input_char_count: 42,
        }),
      ).not.toThrow();
    });

    it("rejects wrong-length hash", () => {
      expect(() =>
        requestFingerprintSchema.parse({
          message_hash: "abc",
          request_hash: "b".repeat(64),
          normalization_version: "1",
          hash_algorithm: "sha256",
        }),
      ).toThrow();
    });

    it("rejects non-hex characters in hash", () => {
      expect(() =>
        requestFingerprintSchema.parse({
          message_hash: "z".repeat(64),
          request_hash: "b".repeat(64),
          normalization_version: "1",
          hash_algorithm: "sha256",
        }),
      ).toThrow();
    });

    it("hashAlgorithmSchema accepts sha256 and hmac-sha256", () => {
      expect(() => hashAlgorithmSchema.parse("sha256")).not.toThrow();
      expect(() => hashAlgorithmSchema.parse("hmac-sha256")).not.toThrow();
      expect(() => hashAlgorithmSchema.parse("md5")).toThrow();
    });
  });

  describe("Evaluation schemas", () => {
    it("evaluationTargetSchema accepts all 7 kinds", () => {
      for (const kind of ["operation", "attempt", "response", "agent_step", "trace", "session", "artifact"] as const) {
        expect(() => evaluationTargetSchema.parse({ kind, id: "x" })).not.toThrow();
      }
    });

    it("evaluationTargetSchema rejects unknown kinds", () => {
      expect(() => evaluationTargetSchema.parse({ kind: "operationlike", id: "x" })).toThrow();
    });

    it("evaluationScoreSchema accepts all 4 score types", () => {
      expect(() =>
        evaluationScoreSchema.parse({ score_type: "numeric", value: 0.5 }),
      ).not.toThrow();
      expect(() =>
        evaluationScoreSchema.parse({ score_type: "boolean", value: true }),
      ).not.toThrow();
      expect(() =>
        evaluationScoreSchema.parse({ score_type: "categorical", value: "high" }),
      ).not.toThrow();
      expect(() =>
        evaluationScoreSchema.parse({ score_type: "text", value: "..." }),
      ).not.toThrow();
    });

    it("evaluationRefSchema requires all mandatory fields", () => {
      expect(() =>
        evaluationRefSchema.parse({
          evaluation_id: newEvaluationId(),
          target: { kind: "operation", id: "op-1" },
          evaluator_name: "reviewer",
          score: { score_type: "categorical", value: "approved" },
          source: "human",
          occurred_at: "2026-08-05T00:00:00Z",
        }),
      ).not.toThrow();
    });

    it("evaluationRefSchema rejects unknown source", () => {
      expect(() =>
        evaluationRefSchema.parse({
          evaluation_id: newEvaluationId(),
          target: { kind: "operation", id: "op-1" },
          evaluator_name: "reviewer",
          score: { score_type: "boolean", value: true },
          source: "aliens",
          occurred_at: "2026-08-05T00:00:00Z",
        }),
      ).toThrow();
    });
  });

  describe("CapturePolicy schema", () => {
    it("capturePolicySerializableSchema accepts DEFAULT_CAPTURE_POLICY shape", () => {
      expect(() =>
        capturePolicySerializableSchema.parse({
          content: "none",
          fingerprint: "sha256",
          baggage_allowlist: [],
          error_body_capture: "redacted",
          stream_chunk_capture: "off",
        }),
      ).not.toThrow();
    });

    it("contentCaptureSchema accepts all 4 levels", () => {
      for (const c of ["none", "metadata_only", "redacted", "full"]) {
        expect(() => contentCaptureSchema.parse(c)).not.toThrow();
      }
    });

    it("fingerprintCaptureSchema accepts all 3 levels", () => {
      for (const c of ["disabled", "sha256", "hmac_sha256"]) {
        expect(() => fingerprintCaptureSchema.parse(c)).not.toThrow();
      }
    });

    it("errorBodyCaptureSchema accepts all 3 levels", () => {
      for (const c of ["none", "redacted", "full"]) {
        expect(() => errorBodyCaptureSchema.parse(c)).not.toThrow();
      }
    });

    it("streamChunkCaptureSchema accepts all 3 levels", () => {
      for (const c of ["off", "sampled", "full"]) {
        expect(() => streamChunkCaptureSchema.parse(c)).not.toThrow();
      }
    });
  });

  describe("Lifecycle event data schemas", () => {
    it("operationStartedDataSchema accepts a well-formed payload", () => {
      expect(() =>
        operationStartedDataSchema.parse({
          task_type: "triage",
          priority: 2,
          provider_chain: ["a", "b", "c"],
          method: "generateStructured",
        }),
      ).not.toThrow();
    });

    it("operationStartedDataSchema rejects invalid method", () => {
      expect(() =>
        operationStartedDataSchema.parse({
          task_type: "triage",
          provider_chain: ["a"],
          method: "invalidMethod",
        }),
      ).toThrow();
    });

    it("attemptStartedDataSchema requires 1-indexed attempt_number", () => {
      expect(() =>
        attemptStartedDataSchema.parse({
          provider_alias: "a",
          model_id: "m",
          attempt_number: 0,
          is_retry: false,
          is_fallback: false,
        }),
      ).toThrow();
    });

    it("attemptRetryScheduledDataSchema accepts all 8 retry reasons", () => {
      for (const reason of [
        "rate_limit_backoff",
        "transient_auth",
        "capability_fallback",
        "reasoning_starvation",
        "zero_tool_call_prose",
        "validation_feedback",
        "empty_response",
        "network_error",
      ]) {
        expect(() =>
          attemptRetryScheduledDataSchema.parse({
            retry_reason: reason,
            backoff_ms: 500,
            next_attempt_number: 2,
          }),
        ).not.toThrow();
      }
    });

    it("fallbackSelectedDataSchema accepts all 11 fallback causes", () => {
      for (const cause of [
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
      ]) {
        expect(() =>
          fallbackSelectedDataSchema.parse({
            from_provider_alias: "a",
            to_provider_alias: "b",
            cause,
          }),
        ).not.toThrow();
      }
    });

    it("attemptFailedDataSchema requires a nested ErrorInfo", () => {
      expect(() =>
        attemptFailedDataSchema.parse({
          error: {
            error_type: "RateLimitError",
            retryable: true,
            fallback_worthy: true,
            cause_category: "provider_capacity",
          },
          latency_ms: 120,
        }),
      ).not.toThrow();
    });

    it("attemptCompletedDataSchema requires usage + cost + latency + final_model_id", () => {
      expect(() =>
        attemptCompletedDataSchema.parse({
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
          latency_ms: 850,
          final_model_id: "claude-sonnet-4-5",
        }),
      ).not.toThrow();
    });

    it("operationCompletedDataSchema requires aggregate metrics", () => {
      expect(() =>
        operationCompletedDataSchema.parse({
          aggregate_usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          aggregate_cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
          attempts_made: 1,
          final_provider_alias: "a",
          total_duration_ms: 900,
        }),
      ).not.toThrow();
    });

    it("operationFailedDataSchema requires ErrorInfo + providers_tried array", () => {
      expect(() =>
        operationFailedDataSchema.parse({
          error: {
            error_type: "NoProvidersAvailableError",
            retryable: false,
            fallback_worthy: false,
            cause_category: "provider_unavailable",
          },
          attempts_made: 3,
          providers_tried: ["a", "b", "c"],
          total_duration_ms: 5000,
        }),
      ).not.toThrow();
    });

    it("operationCancelledDataSchema requires cancelled_at_attempt", () => {
      expect(() =>
        operationCancelledDataSchema.parse({
          cancelled_at_attempt: 2,
          providers_tried_before_cancel: ["a", "b"],
          total_duration_ms: 800,
        }),
      ).not.toThrow();
    });

    it("agentToolCalledDataSchema requires tool_name + tool_call_id + arguments_digest", () => {
      expect(() =>
        agentToolCalledDataSchema.parse({
          tool_name: "readFile",
          tool_call_id: "call_1",
          arguments_digest: "sha256:abc",
        }),
      ).not.toThrow();
    });
  });

  describe("Envelope schemas (lifecycleEventSchemas)", () => {
    const validEnvelope = {
      spec_version: SPEC_VERSION,
      event_id: newEventId(),
      occurred_at: "2026-08-05T00:00:00Z",
      emitted_at: "2026-08-05T00:00:00Z",
      source: { library: "test", library_version: "0.0.0" },
      operation_id: newOperationId(),
    };

    it("every LIFECYCLE_EVENT_TYPES entry has a matching schema", () => {
      expect(Object.keys(lifecycleEventSchemas)).toContain("llm.operation.started");
      expect(Object.keys(lifecycleEventSchemas)).toContain("agent.tool.returned");
    });

    it("llm.operation.started envelope accepts a well-formed event", () => {
      expect(() =>
        lifecycleEventSchemas["llm.operation.started"].parse({
          ...validEnvelope,
          event_type: "llm.operation.started",
          data: {
            task_type: "triage",
            provider_chain: ["a"],
            method: "generateText",
          },
        }),
      ).not.toThrow();
    });

    it("llm.operation.started envelope rejects wrong event_type", () => {
      expect(() =>
        lifecycleEventSchemas["llm.operation.started"].parse({
          ...validEnvelope,
          event_type: "wrong.event.type",
          data: { task_type: "triage", provider_chain: [], method: "generateText" },
        }),
      ).toThrow();
    });

    it("llm.attempt.completed envelope accepts a well-formed event with correlation", () => {
      expect(() =>
        lifecycleEventSchemas["llm.attempt.completed"].parse({
          ...validEnvelope,
          event_type: "llm.attempt.completed",
          attempt_id: newAttemptId(),
          data: {
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
            latency_ms: 850,
            final_model_id: "m",
          },
        }),
      ).not.toThrow();
    });

    it("evaluationEventSchema accepts a well-formed evaluation event", () => {
      expect(() =>
        evaluationEventSchema.parse({
          ...validEnvelope,
          event_type: "evaluation.recorded",
          data: {
            evaluation_id: newEvaluationId(),
            target: { kind: "operation", id: "op-1" },
            evaluator_name: "reviewer",
            score: { score_type: "boolean", value: true },
            source: "human",
            occurred_at: "2026-08-05T00:00:00Z",
          },
        }),
      ).not.toThrow();
    });
  });

  describe("anyObservabilityEventSchema (loose envelope)", () => {
    it("accepts any well-formed envelope regardless of event_type", () => {
      expect(() =>
        anyObservabilityEventSchema.parse({
          spec_version: SPEC_VERSION,
          event_id: newEventId(),
          event_type: "some.future.event.type",
          occurred_at: "2026-08-05T00:00:00Z",
          emitted_at: "2026-08-05T00:00:00Z",
          source: { library: "custom", library_version: "1.0.0" },
          operation_id: newOperationId(),
          data: { arbitrary: "payload" },
        }),
      ).not.toThrow();
    });

    it("rejects envelope missing required fields", () => {
      expect(() =>
        anyObservabilityEventSchema.parse({
          spec_version: SPEC_VERSION,
          // Missing event_id, event_type, etc.
          data: {},
        }),
      ).toThrow();
    });
  });

  describe("Type inference round-trip", () => {
    it("errorInfoSchema.infer produces a shape compatible with ErrorInfo", () => {
      // This is a compile-time property; if it fails, the test file
      // fails to compile.
      type Inferred = z.infer<typeof errorInfoSchema>;
      const _: Inferred = {
        error_type: "X",
        retryable: false,
        fallback_worthy: false,
        cause_category: "unknown",
      };
      expect(_.error_type).toBe("X");
    });
  });
});
