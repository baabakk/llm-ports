/**
 * Foundation tests for @llm-ports/observability-contract.
 *
 * Covers the alpha.28 initial exports: envelope, correlation types, sink
 * interface, ID helpers, trace-context constants, spec version.
 *
 * Subsequent test files (arriving with the follow-up commits) cover:
 *   - Zod validation schemas for each event type
 *   - Lifecycle events end-to-end
 *   - ErrorInfo shape
 *   - CacheStats
 *   - RequestFingerprint canonicalization + golden vectors
 *   - EvaluationRef + EvaluationTarget union
 *   - CapturePolicy defaults
 */

import { describe, expect, it } from "vitest";
import {
  ATTEMPT_ID_LENGTH,
  BAGGAGE_MAX_BYTES,
  BAGGAGE_MAX_MEMBERS,
  createCollectingSink,
  EVALUATION_ID_LENGTH,
  EVENT_ID_LENGTH,
  newAttemptId,
  newEvaluationId,
  newEventId,
  newOperationId,
  noopSink,
  OPERATION_ID_LENGTH,
  SPEC_VERSION,
  type AnyObservabilityEvent,
  type BaggageEntry,
  type CorrelationContext,
  type EventSource,
  type ObservabilityContext,
  type ObservabilityEvent,
  type ObservabilitySink,
  type TraceContext,
} from "../src/index.js";

describe("@llm-ports/observability-contract (alpha.28 foundation)", () => {
  describe("SPEC_VERSION", () => {
    it("is a non-empty semver-shaped string", () => {
      expect(SPEC_VERSION).toBeTruthy();
      expect(typeof SPEC_VERSION).toBe("string");
      // Semver-ish: at least one dot; no whitespace.
      expect(SPEC_VERSION).toMatch(/^\d+\.\d+\.\d+/);
      expect(SPEC_VERSION).not.toMatch(/\s/);
    });

    it("is currently the alpha.28 prerelease", () => {
      // Alpha 28 marker: the constant reflects the shipping contract
      // version. Tests deliberately couple to this so a version drift
      // between the constant and package.json surfaces immediately.
      expect(SPEC_VERSION).toBe("0.1.0-alpha.28");
    });
  });

  describe("ID helpers", () => {
    it("newEventId returns a nanoid of EVENT_ID_LENGTH characters", () => {
      const id = newEventId();
      expect(id).toHaveLength(EVENT_ID_LENGTH);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("newOperationId returns a nanoid of OPERATION_ID_LENGTH characters", () => {
      const id = newOperationId();
      expect(id).toHaveLength(OPERATION_ID_LENGTH);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("newAttemptId returns a nanoid of ATTEMPT_ID_LENGTH characters", () => {
      const id = newAttemptId();
      expect(id).toHaveLength(ATTEMPT_ID_LENGTH);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("newEvaluationId returns a nanoid of EVALUATION_ID_LENGTH characters", () => {
      const id = newEvaluationId();
      expect(id).toHaveLength(EVALUATION_ID_LENGTH);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("ID generators produce distinct values across many invocations (collision resistance smoke)", () => {
      const events = new Set<string>();
      const operations = new Set<string>();
      const attempts = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        events.add(newEventId());
        operations.add(newOperationId());
        attempts.add(newAttemptId());
      }
      expect(events.size).toBe(1000);
      expect(operations.size).toBe(1000);
      expect(attempts.size).toBe(1000);
    });
  });

  describe("Baggage constants match W3C spec", () => {
    it("BAGGAGE_MAX_MEMBERS is 64 per W3C spec", () => {
      expect(BAGGAGE_MAX_MEMBERS).toBe(64);
    });

    it("BAGGAGE_MAX_BYTES is 8192 per W3C spec", () => {
      expect(BAGGAGE_MAX_BYTES).toBe(8192);
    });
  });

  describe("Envelope type shape", () => {
    it("compiles a well-formed ObservabilityEvent", () => {
      const source: EventSource = {
        library: "@llm-ports/core",
        library_version: "0.1.0-alpha.28",
        component: "registry",
        runtime: "node@22.11",
      };

      const event: ObservabilityEvent<
        "llm.operation.started",
        { task_type: string }
      > = {
        spec_version: SPEC_VERSION,
        event_id: newEventId(),
        event_type: "llm.operation.started",
        occurred_at: "2026-08-05T00:00:00Z",
        emitted_at: "2026-08-05T00:00:00.010Z",
        source,
        operation_id: newOperationId(),
        data: { task_type: "code-review" },
      };

      expect(event.event_type).toBe("llm.operation.started");
      expect(event.data.task_type).toBe("code-review");
      expect(event.source.library).toBe("@llm-ports/core");
    });

    it("supports the full envelope with correlation + trace context + sequence", () => {
      const operationId = newOperationId();
      const attemptId = newAttemptId();

      const trace: TraceContext = {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=abc",
      };

      const event: ObservabilityEvent<
        "llm.attempt.completed",
        { provider_alias: string }
      > = {
        spec_version: SPEC_VERSION,
        event_id: newEventId(),
        event_type: "llm.attempt.completed",
        occurred_at: "2026-08-05T00:00:00Z",
        emitted_at: "2026-08-05T00:00:00.010Z",
        source: { library: "@llm-ports/core", library_version: "0.1.0-alpha.28" },
        operation_id: operationId,
        attempt_id: attemptId,
        parent_operation_id: newOperationId(),
        trace_context: trace,
        sequence: 3,
        data: { provider_alias: "claude-sonnet" },
      };

      expect(event.attempt_id).toBe(attemptId);
      expect(event.trace_context?.traceparent).toBeTruthy();
      expect(event.sequence).toBe(3);
    });

    it("AnyObservabilityEvent accepts events with unknown types (forward-compat)", () => {
      const unknownEvent: AnyObservabilityEvent = {
        spec_version: SPEC_VERSION,
        event_id: newEventId(),
        event_type: "some.future.event.type",
        occurred_at: "2026-08-05T00:00:00Z",
        emitted_at: "2026-08-05T00:00:00.010Z",
        source: { library: "custom", library_version: "1.0.0" },
        operation_id: newOperationId(),
        data: { custom_field: 42, nested: { any: "thing" } },
      };

      expect(unknownEvent.event_type).toBe("some.future.event.type");
    });
  });

  describe("CorrelationContext + ObservabilityContext type shapes", () => {
    it("CorrelationContext requires operation_id and allows the six optional fields", () => {
      const ctx: CorrelationContext = {
        operation_id: newOperationId(),
        attempt_id: newAttemptId(),
        parent_operation_id: newOperationId(),
        root_operation_id: newOperationId(),
        provider_request_id: "chatcmpl-abc123",
        conversation_id: "conv-42",
      };
      expect(ctx.operation_id).toBeTruthy();
      expect(ctx.attempt_id).toBeTruthy();
    });

    it("CorrelationContext works with only operation_id set (minimum)", () => {
      const ctx: CorrelationContext = { operation_id: newOperationId() };
      expect(ctx.operation_id).toBeTruthy();
      expect(ctx.attempt_id).toBeUndefined();
    });

    it("ObservabilityContext accepts baggage + attributes + traceparent + fingerprint_key", () => {
      const baggage: BaggageEntry[] = [
        { key: "tenant_id", value: "acme-corp" },
        { key: "user_id", value: "12345" },
        { key: "feature_flag", value: "new_checkout", properties: [{ key: "level", value: "1" }] },
      ];

      const ctx: ObservabilityContext = {
        operation_id: newOperationId(),
        parent_operation_id: newOperationId(),
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=abc",
        baggage,
        attributes: { tier: "gold", region: "us-west" },
        fingerprint_key: "hmac-secret-abc",
        conversation_id: "conv-42",
      };

      expect(ctx.baggage).toHaveLength(3);
      expect(ctx.attributes?.tier).toBe("gold");
    });

    it("ObservabilityContext works with no fields set (all-optional)", () => {
      const ctx: ObservabilityContext = {};
      expect(Object.keys(ctx)).toHaveLength(0);
    });
  });

  describe("ObservabilitySink", () => {
    it("noopSink accepts events and ignores them", () => {
      const event: AnyObservabilityEvent = {
        spec_version: SPEC_VERSION,
        event_id: newEventId(),
        event_type: "test.event",
        occurred_at: "2026-08-05T00:00:00Z",
        emitted_at: "2026-08-05T00:00:00Z",
        source: { library: "test", library_version: "0.0.0" },
        operation_id: newOperationId(),
        data: null,
      };

      // No exception, no return value; just accepts.
      expect(() => noopSink.emit(event)).not.toThrow();
    });

    it("createCollectingSink records every event received", () => {
      const sink = createCollectingSink();
      expect(sink.events).toEqual([]);

      const event1: AnyObservabilityEvent = {
        spec_version: SPEC_VERSION,
        event_id: newEventId(),
        event_type: "test.event.one",
        occurred_at: "2026-08-05T00:00:00Z",
        emitted_at: "2026-08-05T00:00:00Z",
        source: { library: "test", library_version: "0.0.0" },
        operation_id: newOperationId(),
        data: { seq: 1 },
      };

      const event2: AnyObservabilityEvent = { ...event1, event_id: newEventId(), event_type: "test.event.two", data: { seq: 2 } };

      sink.emit(event1);
      sink.emit(event2);

      expect(sink.events).toHaveLength(2);
      expect(sink.events[0]?.event_type).toBe("test.event.one");
      expect(sink.events[1]?.event_type).toBe("test.event.two");
    });

    it("createCollectingSink.clear() empties the buffer", () => {
      const sink = createCollectingSink();
      sink.emit({
        spec_version: SPEC_VERSION,
        event_id: newEventId(),
        event_type: "test",
        occurred_at: "2026-08-05T00:00:00Z",
        emitted_at: "2026-08-05T00:00:00Z",
        source: { library: "test", library_version: "0.0.0" },
        operation_id: newOperationId(),
        data: null,
      });
      expect(sink.events).toHaveLength(1);

      sink.clear();
      expect(sink.events).toHaveLength(0);
    });

    it("supports Promise-returning implementations for async sinks", async () => {
      let receivedCount = 0;
      const asyncSink: ObservabilitySink = {
        async emit(_event: AnyObservabilityEvent): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 1));
          receivedCount++;
        },
      };

      const event: AnyObservabilityEvent = {
        spec_version: SPEC_VERSION,
        event_id: newEventId(),
        event_type: "test",
        occurred_at: "2026-08-05T00:00:00Z",
        emitted_at: "2026-08-05T00:00:00Z",
        source: { library: "test", library_version: "0.0.0" },
        operation_id: newOperationId(),
        data: null,
      };

      const result = asyncSink.emit(event);
      expect(result).toBeInstanceOf(Promise);
      await result;
      expect(receivedCount).toBe(1);
    });
  });

  describe("End-to-end: non-port caller emits a conformant event", () => {
    it("caller with no port constructs the envelope + emits to a sink (§4.13 standalone data contract)", () => {
      // This is the canonical §4.13 use case: a caller wrapping some
      // subprocess-driven agent runtime that never touches @llm-ports/core.
      // The caller imports types from @llm-ports/observability-contract
      // directly and emits conformant events to any sink.
      const sink = createCollectingSink();
      const operationId = newOperationId();

      // Simulated caller: no port constructor invoked; nothing from
      // @llm-ports/core imported.
      const startEvent: ObservabilityEvent<
        "llm.operation.started",
        { task_type: string; provider_alias: string }
      > = {
        spec_version: SPEC_VERSION,
        event_id: newEventId(),
        event_type: "llm.operation.started",
        occurred_at: new Date().toISOString(),
        emitted_at: new Date().toISOString(),
        source: { library: "my-subprocess-agent-runner", library_version: "1.0.0" },
        operation_id: operationId,
        data: { task_type: "code-review", provider_alias: "claude-code-cli" },
      };

      sink.emit(startEvent);

      const completedEvent: ObservabilityEvent<
        "llm.operation.completed",
        { attempts_made: number }
      > = {
        spec_version: SPEC_VERSION,
        event_id: newEventId(),
        event_type: "llm.operation.completed",
        occurred_at: new Date().toISOString(),
        emitted_at: new Date().toISOString(),
        source: { library: "my-subprocess-agent-runner", library_version: "1.0.0" },
        operation_id: operationId,
        data: { attempts_made: 1 },
      };

      sink.emit(completedEvent);

      expect(sink.events).toHaveLength(2);
      // Both events group by operation_id (the §4.13 correlation property).
      expect(sink.events[0]?.operation_id).toBe(operationId);
      expect(sink.events[1]?.operation_id).toBe(operationId);
      // Both events carry the same source library (attribution).
      expect(sink.events[0]?.source.library).toBe("my-subprocess-agent-runner");
      // Both events carry the SPEC_VERSION (envelope versioning).
      expect(sink.events[0]?.spec_version).toBe(SPEC_VERSION);
    });
  });
});
