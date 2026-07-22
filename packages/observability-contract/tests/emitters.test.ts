/**
 * Emitter helper tests. Verifies that:
 *   - buildEvent assembles a full envelope with defaults filled in
 *   - emitLifecycleEvent forwards to the sink
 *   - emitEvaluation derives correlation from EvaluationRef.target
 *   - correlationFromContext respects ObservabilityContext.operation_id
 *   - non-port callers can construct a full event stream without
 *     touching @llm-ports/core (§4.13 standalone data contract)
 */

import { describe, expect, it } from "vitest";
import {
  buildEvent,
  correlationFromContext,
  createCollectingSink,
  DEFAULT_CAPTURE_POLICY,
  emitEvaluation,
  emitLifecycleEvent,
  emitRaw,
  newAttemptId,
  newEvaluationId,
  newEventId,
  newOperationId,
  SPEC_VERSION,
  type AnyObservabilityEvent,
  type CorrelationContext,
  type EmitterConfig,
  type EvaluationRef,
  type EventSource,
  type ObservabilityContext,
} from "../src/index.js";

// A fixed clock for deterministic assertions.
const FIXED_NOW = "2026-08-05T00:00:00.000Z";
const fixedClock = () => FIXED_NOW;

const source: EventSource = {
  library: "test-emitter",
  library_version: "0.0.0",
};

function makeConfig(sink = createCollectingSink()): EmitterConfig & {
  sink: ReturnType<typeof createCollectingSink>;
} {
  return { source, sink, now: fixedClock };
}

describe("Emitter helpers (§4.13)", () => {
  describe("buildEvent", () => {
    it("stamps SPEC_VERSION when not overridden", () => {
      const correlation: CorrelationContext = { operation_id: newOperationId() };
      const event = buildEvent(makeConfig(), "test.event", correlation, { x: 1 });
      expect(event.spec_version).toBe(SPEC_VERSION);
    });

    it("stamps a fresh event_id per call", () => {
      const c = makeConfig();
      const correlation: CorrelationContext = { operation_id: newOperationId() };
      const e1 = buildEvent(c, "test.event", correlation, {});
      const e2 = buildEvent(c, "test.event", correlation, {});
      expect(e1.event_id).not.toBe(e2.event_id);
    });

    it("uses the injected clock for occurred_at and emitted_at", () => {
      const c = makeConfig();
      const correlation: CorrelationContext = { operation_id: newOperationId() };
      const event = buildEvent(c, "test.event", correlation, {});
      expect(event.occurred_at).toBe(FIXED_NOW);
      expect(event.emitted_at).toBe(FIXED_NOW);
    });

    it("threads attempt_id and parent_operation_id when present", () => {
      const c = makeConfig();
      const correlation: CorrelationContext = {
        operation_id: "op-1",
        attempt_id: "att-1",
        parent_operation_id: "op-parent",
      };
      const event = buildEvent(c, "test.event", correlation, {});
      expect(event.attempt_id).toBe("att-1");
      expect(event.parent_operation_id).toBe("op-parent");
    });

    it("threads trace_context and sequence from extras", () => {
      const c = makeConfig();
      const correlation: CorrelationContext = { operation_id: "op-1" };
      const event = buildEvent(c, "test.event", correlation, {}, {
        trace_context: { traceparent: "00-abc" },
        sequence: 5,
      });
      expect(event.trace_context?.traceparent).toBe("00-abc");
      expect(event.sequence).toBe(5);
    });

    it("respects spec_version override for migration testing", () => {
      const c: EmitterConfig = { source, sink: createCollectingSink(), spec_version: "0.0.99" };
      const correlation: CorrelationContext = { operation_id: "op-1" };
      const event = buildEvent(c, "test.event", correlation, {});
      expect(event.spec_version).toBe("0.0.99");
    });
  });

  describe("emitLifecycleEvent", () => {
    it("emits a well-formed llm.operation.started to the sink", () => {
      const sink = createCollectingSink();
      const config: EmitterConfig = { source, sink, now: fixedClock };
      const operationId = newOperationId();

      emitLifecycleEvent(
        config,
        "llm.operation.started",
        { operation_id: operationId },
        {
          task_type: "triage",
          provider_chain: ["claude-sonnet"],
          method: "runAgent",
        },
      );

      expect(sink.events).toHaveLength(1);
      const event = sink.events[0]!;
      expect(event.event_type).toBe("llm.operation.started");
      expect(event.operation_id).toBe(operationId);
      expect((event.data as { task_type: string }).task_type).toBe("triage");
    });

    it("emits llm.attempt.completed with the attempt_id set", () => {
      const sink = createCollectingSink();
      const config: EmitterConfig = { source, sink, now: fixedClock };
      const operationId = newOperationId();
      const attemptId = newAttemptId();

      emitLifecycleEvent(
        config,
        "llm.attempt.completed",
        { operation_id: operationId, attempt_id: attemptId },
        {
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
          latency_ms: 850,
          final_model_id: "claude-sonnet-4-5",
        },
      );

      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]!.attempt_id).toBe(attemptId);
    });

    it("supports async sinks (awaits the sink's Promise)", async () => {
      let received = 0;
      const asyncSink = {
        async emit(_event: AnyObservabilityEvent): Promise<void> {
          await new Promise((r) => setTimeout(r, 1));
          received++;
        },
      };
      const config: EmitterConfig = { source, sink: asyncSink, now: fixedClock };
      const result = emitLifecycleEvent(
        config,
        "llm.operation.cancelled",
        { operation_id: newOperationId() },
        {
          cancelled_at_attempt: 1,
          providers_tried_before_cancel: [],
          total_duration_ms: 100,
        },
      );
      expect(result).toBeInstanceOf(Promise);
      await result;
      expect(received).toBe(1);
    });
  });

  describe("emitEvaluation", () => {
    it("derives operation_id from target when target.kind='operation'", () => {
      const sink = createCollectingSink();
      const config: EmitterConfig = { source, sink, now: fixedClock };

      const ref: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "operation", id: "op-abc" },
        evaluator_name: "reviewer",
        score: { score_type: "categorical", value: "approved" },
        source: "human",
        occurred_at: FIXED_NOW,
      };

      emitEvaluation(config, ref);
      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]!.operation_id).toBe("op-abc");
      expect(sink.events[0]!.event_type).toBe("evaluation.recorded");
    });

    it("derives operation_id + attempt_id from target when target.kind='attempt'", () => {
      const sink = createCollectingSink();
      const config: EmitterConfig = { source, sink, now: fixedClock };

      const ref: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "attempt", id: "att-xyz" },
        evaluator_name: "reviewer",
        score: { score_type: "boolean", value: true },
        source: "model",
        occurred_at: FIXED_NOW,
      };

      emitEvaluation(config, ref, { operation_id: "op-parent" });
      expect(sink.events[0]!.operation_id).toBe("op-parent");
      expect(sink.events[0]!.attempt_id).toBe("att-xyz");
    });

    it("requires a supplemental correlation for non-operation, non-attempt targets", () => {
      const sink = createCollectingSink();
      const config: EmitterConfig = { source, sink, now: fixedClock };

      const artifactRef: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "artifact", id: "pr-123" },
        evaluator_name: "reviewer",
        score: { score_type: "text", value: "..." },
        source: "human",
        occurred_at: FIXED_NOW,
      };

      // Missing supplemental correlation → throws.
      expect(() => emitEvaluation(config, artifactRef)).toThrow(/requires a supplemental/);

      // With supplemental → succeeds.
      emitEvaluation(config, artifactRef, { operation_id: "op-context" });
      expect(sink.events[0]!.operation_id).toBe("op-context");
    });

    it("attempt target throws without supplemental correlation.operation_id", () => {
      const sink = createCollectingSink();
      const config: EmitterConfig = { source, sink, now: fixedClock };

      const ref: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "attempt", id: "att-1" },
        evaluator_name: "reviewer",
        score: { score_type: "boolean", value: true },
        source: "model",
        occurred_at: FIXED_NOW,
      };

      expect(() => emitEvaluation(config, ref)).toThrow(/requires a supplemental/);
    });
  });

  describe("correlationFromContext", () => {
    it("preserves context.operation_id when provided", () => {
      const context: ObservabilityContext = { operation_id: "op-from-context" };
      const corr = correlationFromContext(context, { operation_id: "op-fallback" });
      expect(corr.operation_id).toBe("op-from-context");
    });

    it("uses fallback operation_id when context doesn't have one", () => {
      const context: ObservabilityContext = {};
      const corr = correlationFromContext(context, { operation_id: "op-fallback" });
      expect(corr.operation_id).toBe("op-fallback");
    });

    it("threads parent_operation_id from context", () => {
      const context: ObservabilityContext = { parent_operation_id: "op-parent" };
      const corr = correlationFromContext(context, { operation_id: "op-1" });
      expect(corr.parent_operation_id).toBe("op-parent");
    });

    it("threads attempt_id from fallback (context doesn't carry attempts)", () => {
      const context: ObservabilityContext = {};
      const corr = correlationFromContext(context, {
        operation_id: "op-1",
        attempt_id: "att-1",
      });
      expect(corr.attempt_id).toBe("att-1");
    });

    it("threads conversation_id from context", () => {
      const context: ObservabilityContext = { conversation_id: "conv-42" };
      const corr = correlationFromContext(context, { operation_id: "op-1" });
      expect(corr.conversation_id).toBe("conv-42");
    });
  });

  describe("emitRaw", () => {
    it("emits a pre-built envelope directly", () => {
      const sink = createCollectingSink();
      const config: EmitterConfig = { source, sink, now: fixedClock };

      const preBuilt: AnyObservabilityEvent = {
        spec_version: SPEC_VERSION,
        event_id: newEventId(),
        event_type: "custom.event",
        occurred_at: FIXED_NOW,
        emitted_at: FIXED_NOW,
        source,
        operation_id: newOperationId(),
        data: { anything: "goes" },
      };

      emitRaw(config, preBuilt);
      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]).toBe(preBuilt);
    });
  });

  describe("End-to-end: non-port caller emits a coherent event stream (§4.13)", () => {
    it("simulated subprocess agent runner emits a full lifecycle without touching @llm-ports/core", () => {
      // Zero imports from @llm-ports/core in this test. The subprocess
      // driver just uses observability-contract types + emitters.

      const sink = createCollectingSink();
      const config: EmitterConfig = { source, sink, now: fixedClock };
      const operationId = newOperationId();
      const attemptId = newAttemptId();

      // Operation begins.
      emitLifecycleEvent(config, "llm.operation.started", { operation_id: operationId }, {
        task_type: "code-review",
        provider_chain: ["subprocess-claude-code"],
        method: "runAgent",
      });

      // Attempt begins.
      emitLifecycleEvent(
        config,
        "llm.attempt.started",
        { operation_id: operationId, attempt_id: attemptId },
        {
          provider_alias: "subprocess-claude-code",
          model_id: "claude-code-cli",
          attempt_number: 1,
          is_retry: false,
          is_fallback: false,
        },
      );

      // Agent tool loop.
      emitLifecycleEvent(
        config,
        "agent.tool.called",
        { operation_id: operationId, attempt_id: attemptId },
        {
          tool_name: "readFile",
          tool_call_id: "call_1",
          arguments_digest: "sha256:abc",
        },
      );
      emitLifecycleEvent(
        config,
        "agent.tool.returned",
        { operation_id: operationId, attempt_id: attemptId },
        {
          tool_name: "readFile",
          tool_call_id: "call_1",
          result_digest: "sha256:def",
          duration_ms: 10,
        },
      );

      // Attempt completes.
      emitLifecycleEvent(
        config,
        "llm.attempt.completed",
        { operation_id: operationId, attempt_id: attemptId },
        {
          usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
          cost: { inputUSD: 0.0005, outputUSD: 0.001, totalUSD: 0.0015 },
          latency_ms: 850,
          final_model_id: "claude-code-cli",
        },
      );

      // Operation completes.
      emitLifecycleEvent(config, "llm.operation.completed", { operation_id: operationId }, {
        aggregate_usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
        aggregate_cost: { inputUSD: 0.0005, outputUSD: 0.001, totalUSD: 0.0015 },
        attempts_made: 1,
        final_provider_alias: "subprocess-claude-code",
        total_duration_ms: 900,
      });

      // Post-hoc evaluation (arrives later, could be a different process).
      const evalRef: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "operation", id: operationId },
        evaluator_name: "code_review_verdict",
        score: { score_type: "categorical", value: "approved" },
        source: "model",
        occurred_at: FIXED_NOW,
      };
      emitEvaluation(config, evalRef);

      // Verify: 7 events total, all keyed to the same operation_id.
      expect(sink.events).toHaveLength(7);
      for (const e of sink.events) {
        expect(e.operation_id).toBe(operationId);
        expect(e.source.library).toBe("test-emitter");
        expect(e.spec_version).toBe(SPEC_VERSION);
      }
      // Non-port callers can also inspect DEFAULT_CAPTURE_POLICY to
      // decide what to include in their event payloads.
      expect(DEFAULT_CAPTURE_POLICY.content).toBe("none");
    });
  });
});
