/**
 * Alpha.29 — shared instrumentation service unit tests.
 *
 * Covers the four surfaces the service exposes:
 *  1. `withOperation` — lifecycle wrap for a whole port-method call.
 *  2. `withAttempt`   — lifecycle wrap for one provider attempt.
 *  3. `emitRetryScheduled` / `emitFallbackSelected` — Registry-only events.
 *  4. Manual escape hatch: `startAttempt` / `completeAttempt` / `failAttempt`.
 */

import { describe, expect, it } from "vitest";
import {
  createCollectingSink,
  type EventSource,
  type ObservabilityEvent,
} from "@llm-ports/observability-contract";
import {
  completeAttempt,
  emitFallbackSelected,
  emitRetryScheduled,
  failAttempt,
  startAttempt,
  withAttempt,
  withOperation,
  type Instrumentation,
} from "../src/index.js";

const testSource: EventSource = { library: "test", library_version: "0.0.0" };

function makeInstrumentation(): { instr: Instrumentation; sink: ReturnType<typeof createCollectingSink> } {
  const sink = createCollectingSink();
  return {
    instr: { config: { sink, source: testSource } },
    sink,
  };
}

function eventTypes(sink: ReturnType<typeof createCollectingSink>): string[] {
  return sink.events.map((e) => e.event_type);
}

// ─── withOperation: happy path ──────────────────────────────────────

describe("withOperation — happy path", () => {
  it("emits operation.started before work and operation.completed after", async () => {
    const { instr, sink } = makeInstrumentation();
    const result = await withOperation(
      instr,
      { taskType: "triage", method: "generateText", providerChain: ["openai"] },
      async () => "result",
    );
    expect(result).toBe("result");
    expect(eventTypes(sink)).toEqual(["llm.operation.started", "llm.operation.completed"]);
  });

  it("emits a single operation_id shared across the two events", async () => {
    const { instr, sink } = makeInstrumentation();
    await withOperation(
      instr,
      { taskType: "x", method: "generateText", providerChain: ["a"] },
      async () => "",
    );
    const opIds = new Set(sink.events.map((e) => e.operation_id));
    expect(opIds.size).toBe(1);
  });

  it("stamps task_type, method, provider_chain on operation.started", async () => {
    const { instr, sink } = makeInstrumentation();
    await withOperation(
      instr,
      { taskType: "triage", method: "runAgent", providerChain: ["openai", "anthropic"] },
      async () => "",
    );
    const started = sink.events[0]! as ObservabilityEvent<"llm.operation.started", { task_type: string; method: string; provider_chain: string[] }>;
    expect(started.data.task_type).toBe("triage");
    expect(started.data.method).toBe("runAgent");
    expect(started.data.provider_chain).toEqual(["openai", "anthropic"]);
  });

  it("stamps zero aggregate usage/cost when no withAttempt ran", async () => {
    const { instr, sink } = makeInstrumentation();
    await withOperation(
      instr,
      { taskType: "x", method: "generateText", providerChain: ["a"] },
      async () => "",
    );
    const completed = sink.events[1]! as ObservabilityEvent<
      "llm.operation.completed",
      { aggregate_usage: { inputTokens: number; outputTokens: number; totalTokens: number }; attempts_made: number }
    >;
    expect(completed.data.aggregate_usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(completed.data.attempts_made).toBe(0);
  });

  it("reuses the caller-supplied operation_id when context.operation_id is set", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = {
      config: { sink, source: testSource },
      context: { operation_id: "op-caller-supplied" },
    };
    await withOperation(
      instr,
      { taskType: "x", method: "generateText", providerChain: ["a"] },
      async () => "",
    );
    expect(sink.events[0]!.operation_id).toBe("op-caller-supplied");
    expect(sink.events[1]!.operation_id).toBe("op-caller-supplied");
  });

  it("is a no-op wrapper when instrumentation is undefined", async () => {
    const result = await withOperation(
      undefined,
      { taskType: "x", method: "generateText", providerChain: [] },
      async (opCtx) => {
        expect(opCtx).toBeUndefined();
        return "value";
      },
    );
    expect(result).toBe("value");
  });
});

// ─── withOperation: error paths ─────────────────────────────────────

describe("withOperation — error paths", () => {
  it("emits operation.failed on thrown error and rethrows", async () => {
    const { instr, sink } = makeInstrumentation();
    await expect(
      withOperation(
        instr,
        { taskType: "x", method: "generateText", providerChain: ["a"] },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(eventTypes(sink)).toEqual(["llm.operation.started", "llm.operation.failed"]);
  });

  it("attaches ErrorInfo with error_type + message on the failed event", async () => {
    const { instr, sink } = makeInstrumentation();
    class CustomTypedError extends Error {
      constructor() {
        super("kaboom");
        this.name = "CustomTypedError";
      }
    }
    await expect(
      withOperation(
        instr,
        { taskType: "x", method: "generateText", providerChain: ["a"] },
        async () => {
          throw new CustomTypedError();
        },
      ),
    ).rejects.toThrow();
    const failed = sink.events[1]! as ObservabilityEvent<
      "llm.operation.failed",
      { error: { error_type: string; message: string; cause_category: string } }
    >;
    expect(failed.data.error.error_type).toBe("CustomTypedError");
    expect(failed.data.error.message).toBe("kaboom");
    // Custom error names aren't in ERROR_TYPE_TO_CATEGORY, so the
    // contract's resolver returns "unknown". "port_internal" is
    // reserved for adapter-internal JS runtime bugs.
    expect(failed.data.error.cause_category).toBe("unknown");
  });

  it("emits operation.cancelled (not failed) when the error is an AbortError", async () => {
    const { instr, sink } = makeInstrumentation();
    class AbortErrorLike extends Error {
      constructor() {
        super("aborted");
        this.name = "AbortError";
      }
    }
    await expect(
      withOperation(
        instr,
        { taskType: "x", method: "generateText", providerChain: ["a"] },
        async () => {
          throw new AbortErrorLike();
        },
      ),
    ).rejects.toThrow("aborted");
    expect(eventTypes(sink)).toEqual(["llm.operation.started", "llm.operation.cancelled"]);
  });
});

// ─── withAttempt: nested inside withOperation ───────────────────────

describe("withAttempt — nested inside withOperation", () => {
  it("emits the full happy-path 4-event sequence for a single attempt", async () => {
    const { instr, sink } = makeInstrumentation();
    await withOperation(
      instr,
      { taskType: "x", method: "generateText", providerChain: ["openai"] },
      async (opCtx) => {
        return withAttempt(
          opCtx,
          { providerAlias: "openai", modelId: "gpt-4o" },
          async () => ({
            value: "hi",
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
            modelId: "gpt-4o-2024",
          }),
        );
      },
    );
    expect(eventTypes(sink)).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "llm.attempt.completed",
      "llm.operation.completed",
    ]);
  });

  it("attempt_id and operation_id are correctly nested", async () => {
    const { instr, sink } = makeInstrumentation();
    await withOperation(
      instr,
      { taskType: "x", method: "generateText", providerChain: ["a"] },
      async (opCtx) => withAttempt(opCtx, { providerAlias: "a", modelId: "m" }, async () => ({ value: "" })),
    );
    // Every event shares the same operation_id.
    const opIds = new Set(sink.events.map((e) => e.operation_id));
    expect(opIds.size).toBe(1);
    // Only attempt events carry attempt_id, and both share the same one.
    const attemptIds = sink.events
      .filter((e) => e.event_type.startsWith("llm.attempt."))
      .map((e) => e.attempt_id);
    expect(attemptIds.length).toBe(2);
    expect(new Set(attemptIds).size).toBe(1);
  });

  it("propagates usage + cost into aggregate_usage + aggregate_cost", async () => {
    const { instr, sink } = makeInstrumentation();
    await withOperation(
      instr,
      { taskType: "x", method: "generateText", providerChain: ["a"] },
      async (opCtx) =>
        withAttempt(
          opCtx,
          { providerAlias: "a", modelId: "m" },
          async () => ({
            value: "",
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            cost: { inputUSD: 0.01, outputUSD: 0.02, totalUSD: 0.03 },
          }),
        ),
    );
    const completed = sink.events[sink.events.length - 1]! as ObservabilityEvent<
      "llm.operation.completed",
      {
        aggregate_usage: { totalTokens: number };
        aggregate_cost: { totalUSD: number };
        attempts_made: number;
        final_provider_alias: string;
      }
    >;
    expect(completed.data.aggregate_usage.totalTokens).toBe(150);
    expect(completed.data.aggregate_cost.totalUSD).toBe(0.03);
    expect(completed.data.attempts_made).toBe(1);
    expect(completed.data.final_provider_alias).toBe("a");
  });

  it("aggregates across multiple attempts within one operation", async () => {
    const { instr, sink } = makeInstrumentation();
    await withOperation(
      instr,
      { taskType: "x", method: "runAgent", providerChain: ["a"] },
      async (opCtx) => {
        await withAttempt(
          opCtx,
          { providerAlias: "a", modelId: "m" },
          async () => ({
            value: "step1",
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
          }),
        );
        return withAttempt(
          opCtx,
          { providerAlias: "a", modelId: "m" },
          async () => ({
            value: "step2",
            usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
            cost: { inputUSD: 0.01, outputUSD: 0.02, totalUSD: 0.03 },
          }),
        );
      },
    );
    const completed = sink.events[sink.events.length - 1]! as ObservabilityEvent<
      "llm.operation.completed",
      { aggregate_usage: { totalTokens: number }; attempts_made: number }
    >;
    expect(completed.data.aggregate_usage.totalTokens).toBe(330);
    expect(completed.data.attempts_made).toBe(2);
  });

  it("emits attempt.failed and lets the error propagate to operation.failed", async () => {
    const { instr, sink } = makeInstrumentation();
    await expect(
      withOperation(
        instr,
        { taskType: "x", method: "generateText", providerChain: ["a"] },
        async (opCtx) =>
          withAttempt(opCtx, { providerAlias: "a", modelId: "m" }, async () => {
            throw new Error("provider down");
          }),
      ),
    ).rejects.toThrow("provider down");
    expect(eventTypes(sink)).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "llm.attempt.failed",
      "llm.operation.failed",
    ]);
  });

  it("records providers_tried on operation.failed when an attempt failed", async () => {
    const { instr, sink } = makeInstrumentation();
    await expect(
      withOperation(
        instr,
        { taskType: "x", method: "generateText", providerChain: ["openai"] },
        async (opCtx) =>
          withAttempt(opCtx, { providerAlias: "openai", modelId: "m" }, async () => {
            throw new Error("boom");
          }),
      ),
    ).rejects.toThrow();
    const failed = sink.events[sink.events.length - 1]! as ObservabilityEvent<
      "llm.operation.failed",
      { providers_tried: string[]; attempts_made: number }
    >;
    expect(failed.data.providers_tried).toEqual(["openai"]);
    expect(failed.data.attempts_made).toBe(1);
  });

  it("is a no-op wrapper when opCtx is undefined", async () => {
    const value = await withAttempt(
      undefined,
      { providerAlias: "a", modelId: "m" },
      async () => ({ value: "pass-through" }),
    );
    expect(value).toBe("pass-through");
  });
});

// ─── Registry-exclusive events ──────────────────────────────────────

describe("emitRetryScheduled / emitFallbackSelected", () => {
  it("emits llm.attempt.retry_scheduled with retry_reason + backoff_ms + next_attempt_number", async () => {
    const { instr, sink } = makeInstrumentation();
    await withOperation(
      instr,
      { taskType: "x", method: "generateText", providerChain: ["a"] },
      async (opCtx) => {
        emitRetryScheduled(opCtx, {
          retryReason: "rate_limited",
          backoffMs: 1000,
          nextAttemptNumber: 2,
        });
      },
    );
    const retry = sink.events.find((e) => e.event_type === "llm.attempt.retry_scheduled") as
      | ObservabilityEvent<"llm.attempt.retry_scheduled", { retry_reason: string; backoff_ms: number; next_attempt_number: number }>
      | undefined;
    expect(retry).toBeDefined();
    expect(retry!.data.retry_reason).toBe("rate_limited");
    expect(retry!.data.backoff_ms).toBe(1000);
    expect(retry!.data.next_attempt_number).toBe(2);
  });

  it("emits llm.fallback.selected with from + to + cause", async () => {
    const { instr, sink } = makeInstrumentation();
    await withOperation(
      instr,
      { taskType: "x", method: "generateText", providerChain: ["a", "b"] },
      async (opCtx) => {
        emitFallbackSelected(opCtx, {
          fromProviderAlias: "openai",
          toProviderAlias: "anthropic",
          cause: "rate_limited",
        });
      },
    );
    const fb = sink.events.find((e) => e.event_type === "llm.fallback.selected") as
      | ObservabilityEvent<"llm.fallback.selected", { from_provider_alias: string; to_provider_alias: string; cause: string }>
      | undefined;
    expect(fb).toBeDefined();
    expect(fb!.data.from_provider_alias).toBe("openai");
    expect(fb!.data.to_provider_alias).toBe("anthropic");
    expect(fb!.data.cause).toBe("rate_limited");
  });

  it("both are no-ops when opCtx is undefined", () => {
    expect(() => emitRetryScheduled(undefined, { retryReason: "rate_limited", backoffMs: 1, nextAttemptNumber: 2 })).not.toThrow();
    expect(() =>
      emitFallbackSelected(undefined, { fromProviderAlias: "a", toProviderAlias: "b", cause: "rate_limited" }),
    ).not.toThrow();
  });
});

// ─── Manual escape hatch ────────────────────────────────────────────

describe("startAttempt / completeAttempt / failAttempt (streaming path)", () => {
  it("startAttempt + completeAttempt emit the standard start + complete pair", async () => {
    const { instr, sink } = makeInstrumentation();
    await withOperation(
      instr,
      { taskType: "x", method: "streamText", providerChain: ["a"] },
      async (opCtx) => {
        const handle = startAttempt(opCtx!, { providerAlias: "a", modelId: "m" });
        // simulate streaming delay
        await Promise.resolve();
        completeAttempt(handle, {
          value: "streamed-text",
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
          modelId: "m-final",
        });
      },
    );
    expect(eventTypes(sink)).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "llm.attempt.completed",
      "llm.operation.completed",
    ]);
  });

  it("failAttempt emits attempt.failed and updates counters", async () => {
    const { instr, sink } = makeInstrumentation();
    await withOperation(
      instr,
      { taskType: "x", method: "streamText", providerChain: ["a"] },
      async (opCtx) => {
        const handle = startAttempt(opCtx!, { providerAlias: "a", modelId: "m" });
        failAttempt(handle, new Error("stream broken"));
      },
    );
    // Note: since we DIDN'T rethrow from work, this counts as a successful
    // operation with a failed attempt inside — a valid but unusual pattern.
    expect(eventTypes(sink)).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "llm.attempt.failed",
      "llm.operation.completed",
    ]);
  });
});

// ─── Safety: sink failures never break the primary path ─────────────

describe("safeEmit — sink failure isolation", () => {
  it("swallows a sync throw from the sink and lets work complete", async () => {
    const throwingSink = {
      events: [] as ObservabilityEvent<string, unknown>[],
      emit(event: ObservabilityEvent<string, unknown>): void {
        // Reject on operation.started only — first emission
        if (event.event_type === "llm.operation.started") throw new Error("sink kaboom");
        this.events.push(event);
      },
    };
    const instr: Instrumentation = { config: { sink: throwingSink, source: testSource } };
    const result = await withOperation(
      instr,
      { taskType: "x", method: "generateText", providerChain: ["a"] },
      async () => "still-works",
    );
    expect(result).toBe("still-works");
    // Only operation.completed lands (started threw).
    expect(throwingSink.events.map((e) => e.event_type)).toEqual(["llm.operation.completed"]);
  });

  it("swallows an async rejection from the sink and lets work complete", async () => {
    const rejectingSink = {
      events: [] as ObservabilityEvent<string, unknown>[],
      async emit(event: ObservabilityEvent<string, unknown>): Promise<void> {
        if (event.event_type === "llm.operation.started") {
          return Promise.reject(new Error("async sink kaboom"));
        }
        this.events.push(event);
      },
    };
    const instr: Instrumentation = { config: { sink: rejectingSink, source: testSource } };
    const result = await withOperation(
      instr,
      { taskType: "x", method: "generateText", providerChain: ["a"] },
      async () => "still-works",
    );
    expect(result).toBe("still-works");
  });
});
