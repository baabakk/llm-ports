/**
 * Alpha.30 §2.5 — agent-event emit helpers.
 *
 * The contract already ships the four agent-step event types
 * (agent.step.started/completed, agent.tool.called/returned) as
 * shipped in alpha.28. Alpha.30 adds the emit-helper layer adapters
 * call after resurrecting the outer operation context. This test
 * suite covers:
 *
 *   - Each helper emits the right event with the right shape
 *   - operation_id correlates with the outer withOperation
 *   - Each helper no-ops when opCtx is undefined (safe for direct-call
 *     paths where no outer operation exists)
 *   - Optional fields propagate correctly
 */

import { describe, expect, it } from "vitest";
import {
  emitAgentStepCompleted,
  emitAgentStepStarted,
  emitAgentToolCalled,
  emitAgentToolReturned,
  withOperation,
  type Instrumentation,
} from "../src/index.js";
import {
  createCollectingSink,
  type ErrorInfo,
  type EventSource,
  type ObservabilityEvent,
} from "@llm-ports/observability-contract";

const testSource: EventSource = { library: "test", library_version: "0.0.0" };

function instr(): { i: Instrumentation; sink: ReturnType<typeof createCollectingSink> } {
  const sink = createCollectingSink();
  return { i: { config: { sink, source: testSource } }, sink };
}

// ─── emitAgentStepStarted ────────────────────────────────────────────

describe("emitAgentStepStarted", () => {
  it("emits agent.step.started with step_index + step_type", async () => {
    const { i, sink } = instr();
    await withOperation(
      i,
      { taskType: "agent", method: "runAgent", providerChain: ["a"] },
      async (opCtx) => {
        emitAgentStepStarted(opCtx, { stepIndex: 1, stepType: "llm" });
      },
    );
    const e = sink.events.find((ev) => ev.event_type === "agent.step.started") as
      | ObservabilityEvent<
          "agent.step.started",
          { step_index: number; step_type: string; tool_name?: string }
        >
      | undefined;
    expect(e).toBeDefined();
    expect(e!.data.step_index).toBe(1);
    expect(e!.data.step_type).toBe("llm");
    expect(e!.data.tool_name).toBeUndefined();
  });

  it("emits tool_name when set (step_type = 'tool')", async () => {
    const { i, sink } = instr();
    await withOperation(
      i,
      { taskType: "agent", method: "runAgent", providerChain: ["a"] },
      async (opCtx) => {
        emitAgentStepStarted(opCtx, {
          stepIndex: 3,
          stepType: "tool",
          toolName: "search_web",
        });
      },
    );
    const e = sink.events.find((ev) => ev.event_type === "agent.step.started") as
      | ObservabilityEvent<
          "agent.step.started",
          { step_index: number; step_type: string; tool_name?: string }
        >
      | undefined;
    expect(e!.data.step_type).toBe("tool");
    expect(e!.data.tool_name).toBe("search_web");
  });

  it("correlates with outer operation_id", async () => {
    const { i, sink } = instr();
    await withOperation(
      i,
      { taskType: "agent", method: "runAgent", providerChain: ["a"] },
      async (opCtx) => {
        emitAgentStepStarted(opCtx, { stepIndex: 1, stepType: "llm" });
      },
    );
    // All events share the same operation_id.
    const opIds = new Set(sink.events.map((e) => e.operation_id));
    expect(opIds.size).toBe(1);
  });

  it("no-ops when opCtx is undefined (direct-call safe)", () => {
    // Direct-call adapters that don't open their own withOperation
    // still safely call the helpers — no crash, no emission.
    expect(() => emitAgentStepStarted(undefined, { stepIndex: 1, stepType: "llm" })).not.toThrow();
  });
});

// ─── emitAgentStepCompleted ─────────────────────────────────────────

describe("emitAgentStepCompleted", () => {
  it("emits agent.step.completed with step_index + duration_ms", async () => {
    const { i, sink } = instr();
    await withOperation(
      i,
      { taskType: "agent", method: "runAgent", providerChain: ["a"] },
      async (opCtx) => {
        emitAgentStepCompleted(opCtx, { stepIndex: 1, durationMs: 250 });
      },
    );
    const e = sink.events.find((ev) => ev.event_type === "agent.step.completed") as
      | ObservabilityEvent<
          "agent.step.completed",
          { step_index: number; duration_ms: number; usage?: unknown; cost?: unknown }
        >
      | undefined;
    expect(e!.data.step_index).toBe(1);
    expect(e!.data.duration_ms).toBe(250);
    expect(e!.data.usage).toBeUndefined();
    expect(e!.data.cost).toBeUndefined();
  });

  it("propagates usage + cost when provided", async () => {
    const { i, sink } = instr();
    await withOperation(
      i,
      { taskType: "agent", method: "runAgent", providerChain: ["a"] },
      async (opCtx) => {
        emitAgentStepCompleted(opCtx, {
          stepIndex: 1,
          durationMs: 100,
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
          cost: { inputUSD: 0.001, outputUSD: 0.0005, totalUSD: 0.0015 },
        });
      },
    );
    const e = sink.events.find((ev) => ev.event_type === "agent.step.completed") as
      | ObservabilityEvent<
          "agent.step.completed",
          {
            usage?: { totalTokens: number };
            cost?: { totalUSD: number };
          }
        >
      | undefined;
    expect(e!.data.usage!.totalTokens).toBe(70);
    expect(e!.data.cost!.totalUSD).toBeCloseTo(0.0015);
  });

  it("no-ops when opCtx is undefined", () => {
    expect(() => emitAgentStepCompleted(undefined, { stepIndex: 1, durationMs: 100 })).not.toThrow();
  });
});

// ─── emitAgentToolCalled ────────────────────────────────────────────

describe("emitAgentToolCalled", () => {
  it("emits agent.tool.called with tool_name + tool_call_id + arguments_digest", async () => {
    const { i, sink } = instr();
    await withOperation(
      i,
      { taskType: "agent", method: "runAgent", providerChain: ["a"] },
      async (opCtx) => {
        emitAgentToolCalled(opCtx, {
          toolName: "search",
          toolCallId: "call_abc",
          argumentsDigest: "sha256-hash-here",
        });
      },
    );
    const e = sink.events.find((ev) => ev.event_type === "agent.tool.called") as
      | ObservabilityEvent<
          "agent.tool.called",
          { tool_name: string; tool_call_id: string; arguments_digest: string }
        >
      | undefined;
    expect(e!.data.tool_name).toBe("search");
    expect(e!.data.tool_call_id).toBe("call_abc");
    expect(e!.data.arguments_digest).toBe("sha256-hash-here");
  });

  it("no-ops when opCtx is undefined", () => {
    expect(() =>
      emitAgentToolCalled(undefined, {
        toolName: "t",
        toolCallId: "c",
        argumentsDigest: "d",
      }),
    ).not.toThrow();
  });
});

// ─── emitAgentToolReturned ──────────────────────────────────────────

describe("emitAgentToolReturned", () => {
  it("emits agent.tool.returned with tool_name + tool_call_id + result_digest + duration_ms", async () => {
    const { i, sink } = instr();
    await withOperation(
      i,
      { taskType: "agent", method: "runAgent", providerChain: ["a"] },
      async (opCtx) => {
        emitAgentToolReturned(opCtx, {
          toolName: "search",
          toolCallId: "call_abc",
          resultDigest: "sha256-result",
          durationMs: 350,
        });
      },
    );
    const e = sink.events.find((ev) => ev.event_type === "agent.tool.returned") as
      | ObservabilityEvent<
          "agent.tool.returned",
          {
            tool_name: string;
            tool_call_id: string;
            result_digest: string;
            duration_ms: number;
            error?: unknown;
          }
        >
      | undefined;
    expect(e!.data.tool_name).toBe("search");
    expect(e!.data.tool_call_id).toBe("call_abc");
    expect(e!.data.result_digest).toBe("sha256-result");
    expect(e!.data.duration_ms).toBe(350);
    expect(e!.data.error).toBeUndefined();
  });

  it("propagates ErrorInfo when the tool errored", async () => {
    const { i, sink } = instr();
    const err: ErrorInfo = {
      error_type: "ToolExecutionError",
      message: "search API returned 500",
      cause_category: "provider_unavailable",
      retryable: true,
      fallback_worthy: false,
    };
    await withOperation(
      i,
      { taskType: "agent", method: "runAgent", providerChain: ["a"] },
      async (opCtx) => {
        emitAgentToolReturned(opCtx, {
          toolName: "search",
          toolCallId: "call_abc",
          resultDigest: "digest",
          durationMs: 100,
          error: err,
        });
      },
    );
    const e = sink.events.find((ev) => ev.event_type === "agent.tool.returned") as
      | ObservabilityEvent<"agent.tool.returned", { error?: ErrorInfo }>
      | undefined;
    expect(e!.data.error).toEqual(err);
  });

  it("no-ops when opCtx is undefined", () => {
    expect(() =>
      emitAgentToolReturned(undefined, {
        toolName: "t",
        toolCallId: "c",
        resultDigest: "d",
        durationMs: 1,
      }),
    ).not.toThrow();
  });
});

// ─── End-to-end: full agent-loop event stream from one operation ────

describe("Agent-event helpers — full agent-loop event stream", () => {
  it("a 3-step agent loop with one tool call emits the expected event sequence", async () => {
    const { i, sink } = instr();
    await withOperation(
      i,
      { taskType: "agent", method: "runAgent", providerChain: ["a"] },
      async (opCtx) => {
        // Step 1: LLM turn produces a tool call
        emitAgentStepStarted(opCtx, { stepIndex: 1, stepType: "llm" });
        emitAgentToolCalled(opCtx, {
          toolName: "calc",
          toolCallId: "c1",
          argumentsDigest: "arg-digest",
        });
        emitAgentStepCompleted(opCtx, { stepIndex: 1, durationMs: 200 });

        // Step 2: tool invocation
        emitAgentStepStarted(opCtx, { stepIndex: 2, stepType: "tool", toolName: "calc" });
        emitAgentToolReturned(opCtx, {
          toolName: "calc",
          toolCallId: "c1",
          resultDigest: "res-digest",
          durationMs: 50,
        });
        emitAgentStepCompleted(opCtx, { stepIndex: 2, durationMs: 50 });

        // Step 3: LLM turn produces final text
        emitAgentStepStarted(opCtx, { stepIndex: 3, stepType: "llm" });
        emitAgentStepCompleted(opCtx, { stepIndex: 3, durationMs: 150 });
      },
    );

    const types = sink.events.map((e) => e.event_type);
    expect(types).toEqual([
      "llm.operation.started",
      "agent.step.started", // step 1 LLM start
      "agent.tool.called", // model asked for tool
      "agent.step.completed", // step 1 LLM done
      "agent.step.started", // step 2 tool start
      "agent.tool.returned", // tool result
      "agent.step.completed", // step 2 tool done
      "agent.step.started", // step 3 LLM start
      "agent.step.completed", // step 3 LLM done
      "llm.operation.completed",
    ]);

    // All events share one operation_id.
    const opIds = new Set(sink.events.map((e) => e.operation_id));
    expect(opIds.size).toBe(1);
  });
});
