/**
 * Alpha.30 §2.5 — agent.step.* / agent.tool.* events fire from a
 * runAgent tool-use loop and correlate to the outer operation.
 *
 * The three in-process adapters that own their tool-use loop (openai,
 * anthropic, google) each call `resurrectOperationContext(this)` at
 * the top of runAgent and thread the returned OperationContext through
 * the shared emit helpers. This test exercises the Registry-side
 * plumbing that makes resurrection work: `scopedPortForAdapter` wraps
 * with an ObservabilityContext, the withObservabilityContext proxy
 * binds `this` to the receiver, and resurrectOperationContext walks
 * back to the outer opCtx from that.
 *
 * The mock port here doesn't call resurrectOperationContext itself
 * (it wouldn't have the imports); instead the test verifies the
 * enabling primitive: `resurrectOperationContext(this)` returns the
 * outer opCtx when called from inside a runAgent invocation routed
 * through the Registry.
 */

import { describe, expect, it } from "vitest";
import {
  createCollectingSink,
  type EventSource,
} from "@llm-ports/observability-contract";
import {
  createRegistryFromEnv,
  emitAgentStepCompleted,
  emitAgentStepStarted,
  emitAgentToolCalled,
  emitAgentToolReturned,
  resurrectOperationContext,
  sha256Hex,
  type AdapterRegistration,
  type AgentResult,
  type GenerateStructuredResult,
  type GenerateTextResult,
  type Instrumentation,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 2.0 };
const testSource: EventSource = { library: "test", library_version: "0.0.0" };

function collectingInstrumentation(): {
  instr: Instrumentation;
  sink: ReturnType<typeof createCollectingSink>;
} {
  const sink = createCollectingSink();
  return { instr: { config: { sink, source: testSource } }, sink };
}

/**
 * Mock port whose runAgent uses `this` — exactly like the openai /
 * anthropic / google adapters — to call resurrectOperationContext and
 * emit the same shape of agent.step.* + agent.tool.* events.
 */
function makeAgentPort(): LLMPort {
  return {
    async generateText(): Promise<GenerateTextResult> {
      throw new Error("unused");
    },
    async generateStructured<T>(): Promise<GenerateStructuredResult<T>> {
      throw new Error("unused");
    },
    streamText: async function* () {
      throw new Error("unused");
      // eslint-disable-next-line no-unreachable
      yield "";
    },
    streamStructured: async function* <T>() {
      throw new Error("unused");
      // eslint-disable-next-line no-unreachable
      yield {} as T;
    },
    async runAgent(this: LLMPort): Promise<AgentResult> {
      const outerOpCtx = resurrectOperationContext(this);

      // Step 1: LLM turn that calls a tool.
      emitAgentStepStarted(outerOpCtx, { stepIndex: 1, stepType: "llm" });
      emitAgentStepCompleted(outerOpCtx, {
        stepIndex: 1,
        durationMs: 10,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        cost: { inputUSD: 0.0001, outputUSD: 0.00004, totalUSD: 0.00014 },
      });
      emitAgentToolCalled(outerOpCtx, {
        toolName: "search",
        toolCallId: "call_abc",
        argumentsDigest: sha256Hex('{"q":"cat photos"}'),
      });
      emitAgentToolReturned(outerOpCtx, {
        toolName: "search",
        toolCallId: "call_abc",
        resultDigest: sha256Hex('{"results":[]}'),
        durationMs: 20,
      });

      // Step 2: final LLM turn producing the answer.
      emitAgentStepStarted(outerOpCtx, { stepIndex: 2, stepType: "llm" });
      emitAgentStepCompleted(outerOpCtx, {
        stepIndex: 2,
        durationMs: 5,
        usage: { inputTokens: 130, outputTokens: 30, totalTokens: 160 },
        cost: { inputUSD: 0.00013, outputUSD: 0.00006, totalUSD: 0.00019 },
      });

      return {
        text: "done",
        messages: [{ role: "assistant", content: "done" }],
        toolCalls: [{ name: "search", input: { q: "cat photos" }, output: { results: [] } }],
        usage: { inputTokens: 230, outputTokens: 50, totalTokens: 280 },
        cost: { inputUSD: 0.00023, outputUSD: 0.0001, totalUSD: 0.00033 },
        modelId: "model-mock",
        providerAlias: "primary",
        latencyMs: 40,
        stepsTaken: 2,
        terminationReason: "completed",
      };
    },
  };
}

describe("Alpha.30 §2.5 — agent events correlate with the outer operation", () => {
  it("Registry-driven runAgent: agent.step.* + agent.tool.* land with the outer operation_id", async () => {
    const { instr, sink } = collectingInstrumentation();
    const adapter: AdapterRegistration = {
      name: "agent-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeAgentPort(),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "agent-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_AGENT: "primary",
      },
      adapters: { "agent-adapter": adapter },
      instrumentation: instr,
    });

    await registry.getPort().runAgent({
      taskType: "agent",
      messages: [{ role: "user", content: "find cat photos" }],
      tools: {},
    });

    const types = sink.events.map((e) => e.event_type);
    // Outer lifecycle wraps the inner agent-step events:
    //   operation.started + attempt.started + [4x agent.step, 2x agent.tool] + attempt.completed + operation.completed
    expect(types).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "agent.step.started",
      "agent.step.completed",
      "agent.tool.called",
      "agent.tool.returned",
      "agent.step.started",
      "agent.step.completed",
      "llm.attempt.completed",
      "llm.operation.completed",
    ]);

    // All inner events share the outer operation_id.
    const opStarted = sink.events.find((e) => e.event_type === "llm.operation.started")!;
    const opId = opStarted.operation_id;
    for (const ev of sink.events) {
      expect(ev.operation_id).toBe(opId);
    }
  });

  it("stamps stepIndex, tool_name, digests, and durations on agent.tool.* events", async () => {
    const { instr, sink } = collectingInstrumentation();
    const adapter: AdapterRegistration = {
      name: "agent-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeAgentPort(),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "agent-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_AGENT: "primary",
      },
      adapters: { "agent-adapter": adapter },
      instrumentation: instr,
    });
    await registry.getPort().runAgent({
      taskType: "agent",
      messages: [{ role: "user", content: "find cat photos" }],
      tools: {},
    });

    const called = sink.events.find((e) => e.event_type === "agent.tool.called")!;
    const returned = sink.events.find((e) => e.event_type === "agent.tool.returned")!;
    const cd = called.data as { tool_name: string; tool_call_id: string; arguments_digest: string };
    const rd = returned.data as { tool_name: string; tool_call_id: string; result_digest: string; duration_ms: number };
    expect(cd.tool_name).toBe("search");
    expect(cd.tool_call_id).toBe("call_abc");
    expect(cd.arguments_digest).toBe(sha256Hex('{"q":"cat photos"}'));
    expect(rd.tool_name).toBe("search");
    expect(rd.tool_call_id).toBe("call_abc");
    expect(rd.result_digest).toBe(sha256Hex('{"results":[]}'));
    expect(rd.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("agent events silently drop when the outer scope has no observability", async () => {
    // No `instrumentation:` in RegistryOptions → outerOpCtx resolves to
    // undefined inside the adapter, and the four emit helpers no-op.
    const adapter: AdapterRegistration = {
      name: "agent-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeAgentPort(),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "agent-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_AGENT: "primary",
      },
      adapters: { "agent-adapter": adapter },
    });
    // Should not throw or leak state — this is the "no observability
    // configured" happy path.
    const result = await registry.getPort().runAgent({
      taskType: "agent",
      messages: [{ role: "user", content: "find cat photos" }],
      tools: {},
    });
    expect(result.stepsTaken).toBe(2);
    expect(result.terminationReason).toBe("completed");
  });
});
