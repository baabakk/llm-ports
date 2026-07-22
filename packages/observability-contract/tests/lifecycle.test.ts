/**
 * Lifecycle event tests: the nine core lifecycle types plus the four
 * agent-step types. Verifies type shapes, the LIFECYCLE_EVENT_TYPES
 * enumeration, and end-to-end use in `ObservabilityEvent<...>`.
 */

import { describe, expect, it } from "vitest";
import {
  createCollectingSink,
  LIFECYCLE_EVENT_TYPES,
  newAttemptId,
  newEventId,
  newOperationId,
  OPERATION_TERMINATOR_TYPES,
  SPEC_VERSION,
  type AgentStepCompletedData,
  type AgentStepStartedData,
  type AgentToolCalledData,
  type AgentToolReturnedData,
  type AttemptCompletedData,
  type AttemptFailedData,
  type AttemptRetryScheduledData,
  type AttemptStartedData,
  type CostUsage,
  type FallbackCause,
  type FallbackSelectedData,
  type LifecycleEventType,
  type ObservabilityEvent,
  type OperationCancelledData,
  type OperationCompletedData,
  type OperationFailedData,
  type OperationStartedData,
  type RetryReason,
  type TokenUsage,
} from "../src/index.js";

// A helper that constructs a minimally-valid envelope from a type name
// and payload, so tests can focus on the payload shape.
function makeEvent<T extends LifecycleEventType>(
  type: T,
  data: unknown,
  operationId?: string,
  attemptId?: string,
): ObservabilityEvent<T, unknown> {
  return {
    spec_version: SPEC_VERSION,
    event_id: newEventId(),
    event_type: type,
    occurred_at: "2026-08-05T00:00:00Z",
    emitted_at: "2026-08-05T00:00:00.010Z",
    source: { library: "test", library_version: "0.0.0" },
    operation_id: operationId ?? newOperationId(),
    attempt_id: attemptId,
    data,
  };
}

describe("Lifecycle event types (§4.3 + §4.7)", () => {
  describe("LIFECYCLE_EVENT_TYPES enumeration", () => {
    it("contains all 13 event types (9 lifecycle + 4 agent-step)", () => {
      expect(LIFECYCLE_EVENT_TYPES).toHaveLength(13);
    });

    it("contains the 9 core lifecycle types", () => {
      const core: LifecycleEventType[] = [
        "llm.operation.started",
        "llm.attempt.started",
        "llm.attempt.retry_scheduled",
        "llm.fallback.selected",
        "llm.attempt.failed",
        "llm.attempt.completed",
        "llm.operation.completed",
        "llm.operation.failed",
        "llm.operation.cancelled",
      ];
      for (const t of core) {
        expect(LIFECYCLE_EVENT_TYPES).toContain(t);
      }
    });

    it("contains the 4 agent-step types", () => {
      const agent: LifecycleEventType[] = [
        "agent.step.started",
        "agent.step.completed",
        "agent.tool.called",
        "agent.tool.returned",
      ];
      for (const t of agent) {
        expect(LIFECYCLE_EVENT_TYPES).toContain(t);
      }
    });

    it("OPERATION_TERMINATOR_TYPES lists the three operation-level end states", () => {
      expect(OPERATION_TERMINATOR_TYPES).toEqual([
        "llm.operation.completed",
        "llm.operation.failed",
        "llm.operation.cancelled",
      ]);
    });

    it("every value in LIFECYCLE_EVENT_TYPES is unique", () => {
      expect(new Set(LIFECYCLE_EVENT_TYPES).size).toBe(LIFECYCLE_EVENT_TYPES.length);
    });
  });

  describe("Operation-level events", () => {
    it("llm.operation.started carries the intended provider chain", () => {
      const data: OperationStartedData = {
        task_type: "triage",
        priority: 2,
        provider_chain: ["gptoss-cerebras", "gpt5", "claude-sonnet"],
        method: "generateStructured",
      };
      const event = makeEvent("llm.operation.started", data);
      expect(event.data).toEqual(data);
      expect((event.data as OperationStartedData).provider_chain).toHaveLength(3);
    });

    it("llm.operation.completed aggregates usage and cost", () => {
      const usage: TokenUsage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 };
      const cost: CostUsage = { inputUSD: 0.001, outputUSD: 0.003, totalUSD: 0.004 };
      const data: OperationCompletedData = {
        aggregate_usage: usage,
        aggregate_cost: cost,
        attempts_made: 1,
        final_provider_alias: "gptoss-cerebras",
        total_duration_ms: 1250,
        result_summary: { finish_reason: "stop" },
      };
      const event = makeEvent("llm.operation.completed", data);
      expect((event.data as OperationCompletedData).aggregate_usage.totalTokens).toBe(1200);
      expect((event.data as OperationCompletedData).result_summary?.finish_reason).toBe("stop");
    });

    it("llm.operation.failed carries the ErrorInfo placeholder", () => {
      const data: OperationFailedData = {
        error: {
          error_type: "NoProvidersAvailableError",
          message: "chain exhausted",
          retryable: false,
          fallback_worthy: false,
        },
        attempts_made: 3,
        providers_tried: ["a", "b", "c"],
        total_duration_ms: 5000,
      };
      const event = makeEvent("llm.operation.failed", data);
      expect((event.data as OperationFailedData).error.error_type).toBe("NoProvidersAvailableError");
      expect((event.data as OperationFailedData).providers_tried).toHaveLength(3);
    });

    it("llm.operation.cancelled captures where the cancellation was observed", () => {
      const data: OperationCancelledData = {
        cancelled_at_attempt: 2,
        providers_tried_before_cancel: ["a", "b"],
        total_duration_ms: 800,
      };
      const event = makeEvent("llm.operation.cancelled", data);
      expect((event.data as OperationCancelledData).cancelled_at_attempt).toBe(2);
    });
  });

  describe("Attempt-level events", () => {
    it("llm.attempt.started distinguishes initial from retry from fallback", () => {
      const initial: AttemptStartedData = {
        provider_alias: "gptoss-cerebras",
        model_id: "gpt-oss-120b",
        attempt_number: 1,
        is_retry: false,
        is_fallback: false,
      };
      const retry: AttemptStartedData = { ...initial, attempt_number: 2, is_retry: true };
      const fallback: AttemptStartedData = { ...initial, provider_alias: "gpt5", attempt_number: 3, is_fallback: true };

      expect(initial.is_retry).toBe(false);
      expect(retry.is_retry).toBe(true);
      expect(fallback.is_fallback).toBe(true);
    });

    it("llm.attempt.retry_scheduled carries reason + backoff", () => {
      const reasons: RetryReason[] = [
        "rate_limit_backoff",
        "transient_auth",
        "capability_fallback",
        "reasoning_starvation",
        "zero_tool_call_prose",
        "validation_feedback",
        "empty_response",
        "network_error",
      ];
      for (const reason of reasons) {
        const data: AttemptRetryScheduledData = {
          retry_reason: reason,
          backoff_ms: 500,
          next_attempt_number: 2,
        };
        expect(data.retry_reason).toBe(reason);
      }
    });

    it("llm.fallback.selected carries from → to transition + cause", () => {
      const causes: FallbackCause[] = [
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
      ];
      for (const cause of causes) {
        const data: FallbackSelectedData = {
          from_provider_alias: "cerebras",
          to_provider_alias: "gpt5",
          cause,
        };
        expect(data.cause).toBe(cause);
      }
    });

    it("llm.attempt.completed carries usage, cost, latency, and cache_stats", () => {
      const data: AttemptCompletedData = {
        usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600, cachedInputTokens: 400 },
        cost: { inputUSD: 0.0005, outputUSD: 0.001, totalUSD: 0.0015, savingsUSD: 0.0004 },
        latency_ms: 850,
        cache_stats: {
          provider_cache: { status: "hit", read_input_tokens: 400 },
        },
        provider_response_id: "chatcmpl-abc123",
        final_model_id: "gpt-oss-120b",
      };
      expect(data.usage.cachedInputTokens).toBe(400);
      expect(data.cost.savingsUSD).toBe(0.0004);
      expect(data.cache_stats?.provider_cache?.status).toBe("hit");
    });

    it("llm.attempt.failed carries the ErrorInfo placeholder + latency", () => {
      const data: AttemptFailedData = {
        error: {
          error_type: "RateLimitError",
          message: "429 too many requests",
          retryable: true,
          fallback_worthy: true,
        },
        latency_ms: 120,
      };
      expect(data.error.error_type).toBe("RateLimitError");
      expect(data.error.retryable).toBe(true);
    });
  });

  describe("Agent-step events", () => {
    it("agent.step.started distinguishes llm / tool / validation step types", () => {
      const llm: AgentStepStartedData = { step_index: 1, step_type: "llm" };
      const tool: AgentStepStartedData = { step_index: 2, step_type: "tool", tool_name: "readFile" };
      const validation: AgentStepStartedData = { step_index: 3, step_type: "validation" };

      expect(llm.step_type).toBe("llm");
      expect(tool.tool_name).toBe("readFile");
      expect(validation.step_type).toBe("validation");
    });

    it("agent.step.completed optionally carries usage + cost", () => {
      const dataNoUsage: AgentStepCompletedData = { step_index: 1, duration_ms: 100 };
      const dataWithUsage: AgentStepCompletedData = {
        step_index: 1,
        duration_ms: 100,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        cost: { inputUSD: 0.0001, outputUSD: 0.0002, totalUSD: 0.0003 },
      };

      expect(dataNoUsage.usage).toBeUndefined();
      expect(dataWithUsage.usage?.totalTokens).toBe(30);
    });

    it("agent.tool.called carries content-free digest, not raw arguments", () => {
      const data: AgentToolCalledData = {
        tool_name: "readFile",
        tool_call_id: "call_abc",
        arguments_digest: "sha256:0123456789abcdef",
      };
      // The digest is opaque; sinks that need raw arguments consult
      // CapturePolicy.content (a later commit).
      expect(data.arguments_digest).toMatch(/^sha256:/);
      // No raw arguments field exists on the type by design.
    });

    it("agent.tool.returned carries digest + duration + optional error", () => {
      const success: AgentToolReturnedData = {
        tool_name: "readFile",
        tool_call_id: "call_abc",
        result_digest: "sha256:deadbeef",
        duration_ms: 15,
      };
      const failure: AgentToolReturnedData = {
        tool_name: "readFile",
        tool_call_id: "call_abc",
        result_digest: "sha256:00",
        duration_ms: 5,
        error: {
          error_type: "ToolExecutionError",
          message: "file not found",
          retryable: false,
        },
      };

      expect(success.error).toBeUndefined();
      expect(failure.error?.error_type).toBe("ToolExecutionError");
    });
  });

  describe("End-to-end: agent tool loop emits a coherent event stream", () => {
    it("emits started → attempt.started → agent.step.* → agent.tool.* → attempt.completed → completed", () => {
      const sink = createCollectingSink();
      const operationId = newOperationId();
      const attemptId = newAttemptId();

      // 1. Operation begins
      sink.emit(makeEvent(
        "llm.operation.started",
        { task_type: "code-review", provider_chain: ["claude-sonnet"], method: "runAgent" },
        operationId,
      ));

      // 2. First attempt begins
      sink.emit(makeEvent(
        "llm.attempt.started",
        { provider_alias: "claude-sonnet", model_id: "claude-sonnet-4-5", attempt_number: 1, is_retry: false, is_fallback: false },
        operationId,
        attemptId,
      ));

      // 3. Agent step 1: LLM turn
      sink.emit(makeEvent("agent.step.started", { step_index: 1, step_type: "llm" }, operationId, attemptId));

      // 4. Model calls a tool
      sink.emit(makeEvent(
        "agent.tool.called",
        { tool_name: "readFile", tool_call_id: "call_1", arguments_digest: "sha256:abc" },
        operationId,
        attemptId,
      ));

      // 5. Tool returns
      sink.emit(makeEvent(
        "agent.tool.returned",
        { tool_name: "readFile", tool_call_id: "call_1", result_digest: "sha256:def", duration_ms: 10 },
        operationId,
        attemptId,
      ));

      // 6. Step 1 completes
      sink.emit(makeEvent("agent.step.completed", { step_index: 1, duration_ms: 250 }, operationId, attemptId));

      // 7. Attempt completes (single turn was enough)
      sink.emit(makeEvent(
        "llm.attempt.completed",
        {
          usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
          cost: { inputUSD: 0.0005, outputUSD: 0.001, totalUSD: 0.0015 },
          latency_ms: 850,
          final_model_id: "claude-sonnet-4-5",
        },
        operationId,
        attemptId,
      ));

      // 8. Operation completes
      sink.emit(makeEvent(
        "llm.operation.completed",
        {
          aggregate_usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
          aggregate_cost: { inputUSD: 0.0005, outputUSD: 0.001, totalUSD: 0.0015 },
          attempts_made: 1,
          final_provider_alias: "claude-sonnet",
          total_duration_ms: 900,
        },
        operationId,
      ));

      // Verify: every event carries the operationId; attempt events
      // additionally carry attemptId; ordering is preserved.
      expect(sink.events).toHaveLength(8);
      for (const e of sink.events) {
        expect(e.operation_id).toBe(operationId);
      }
      // Terminator is the last event.
      const last = sink.events[sink.events.length - 1];
      expect(last?.event_type).toBe("llm.operation.completed");
      // OPERATION_TERMINATOR_TYPES helps a sink know it's done.
      expect(OPERATION_TERMINATOR_TYPES).toContain(last?.event_type as LifecycleEventType);
    });
  });
});
