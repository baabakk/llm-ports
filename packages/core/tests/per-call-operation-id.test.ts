/**
 * Alpha.31 — per-call operation_id precedence chain.
 *
 * Alpha.29+ shipped `Instrumentation.context.operation_id` as a
 * Registry-level (config-time) pinning slot. Alpha.31 extends the
 * precedence chain to honor a per-call `ObservabilityContext` attached
 * to the port instance via `withObservabilityContext(port, { operation_id })`.
 *
 * Precedence checked here:
 *
 *   1. `withObservabilityContext(port, { operation_id }).generateText(...)`
 *      → the caller's id lands on every emitted lifecycle event.
 *   2. Registry-level `Instrumentation.context.operation_id` set at
 *      construction, no per-call wrap → the Registry-level id is used
 *      (matches alpha.29+ behavior; no regression).
 *   3. Neither → the Registry mints a fresh id (matches
 *      alpha.28-and-earlier behavior).
 *   4. Both set → per-call wins.
 *
 * Verifies against `generateText` primarily; a sanity check covers
 * `generateStructured`, `runAgent`, `streamText`, `streamStructured`
 * because slice-4 wired all five with the same
 * `getObservabilityContext(this)` third argument.
 */

import { describe, expect, it } from "vitest";
import {
  createCollectingSink,
  type EventSource,
} from "@llm-ports/observability-contract";
import {
  createRegistryFromEnv,
  withObservabilityContext,
  type AdapterRegistration,
  type AgentResult,
  type GenerateStructuredResult,
  type GenerateTextResult,
  type Instrumentation,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";
import { z } from "zod";

const PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 2.0 };
const testSource: EventSource = { library: "test", library_version: "0.0.0" };

function collectingInstrumentation(
  ctx?: Instrumentation["context"],
): {
  instr: Instrumentation;
  sink: ReturnType<typeof createCollectingSink>;
} {
  const sink = createCollectingSink();
  return {
    instr: { config: { sink, source: testSource }, ...(ctx ? { context: ctx } : {}) },
    sink,
  };
}

function successPort(modelId: string, alias: string): LLMPort {
  return {
    async generateText(): Promise<GenerateTextResult> {
      return {
        text: `from ${alias}/${modelId}`,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        modelId,
        providerAlias: alias,
        latencyMs: 1,
      };
    },
    async generateStructured<T>(): Promise<GenerateStructuredResult<T>> {
      return {
        data: { hello: "world" } as unknown as T,
        text: '{"hello":"world"}',
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
        cost: { inputUSD: 0.0005, outputUSD: 0.001, totalUSD: 0.0015 },
        modelId,
        providerAlias: alias,
        latencyMs: 1,
      };
    },
    async runAgent(): Promise<AgentResult> {
      return {
        text: `agent from ${alias}`,
        messages: [{ role: "assistant", content: "done" }],
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
        cost: { inputUSD: 0.01, outputUSD: 0.02, totalUSD: 0.03 },
        modelId,
        providerAlias: alias,
        latencyMs: 1,
        stepsTaken: 1,
        terminationReason: "completed",
      };
    },
    streamText: async function* () {
      yield "chunk";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

const goodAdapter: AdapterRegistration = {
  name: "primary",
  pricing: { "model-mock": PRICING },
  createLLMPort: successPort,
};

function buildRegistry(instr: Instrumentation) {
  return createRegistryFromEnv({
    env: {
      LLM_PROVIDER_PRIMARY: "primary|model-mock|req:100/hour",
      LLM_TASK_ROUTE_TEST: "primary",
    },
    adapters: { primary: goodAdapter },
    instrumentation: instr,
  });
}

describe("Alpha.31 — per-call operation_id precedence", () => {
  it("uses the caller-supplied operation_id when the port was wrapped via withObservabilityContext", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = buildRegistry(instr);
    const scopedPort = withObservabilityContext(registry.getPort(), {
      operation_id: "op-caller-supplied-42",
    });

    await scopedPort.generateText({
      taskType: "test",
      messages: [{ role: "user", content: "hi" }],
    });

    // Every event across the operation must carry the caller-supplied id.
    for (const ev of sink.events) {
      expect(ev.operation_id).toBe("op-caller-supplied-42");
    }
  });

  it("falls back to Registry-level Instrumentation.context.operation_id when no per-call wrap is present (alpha.29 parity)", async () => {
    const { instr, sink } = collectingInstrumentation({
      operation_id: "op-registry-level",
    });
    const registry = buildRegistry(instr);

    await registry
      .getPort()
      .generateText({ taskType: "test", messages: [{ role: "user", content: "hi" }] });

    for (const ev of sink.events) {
      expect(ev.operation_id).toBe("op-registry-level");
    }
  });

  it("mints a fresh id when neither per-call nor Registry-level context is set", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = buildRegistry(instr);

    await registry
      .getPort()
      .generateText({ taskType: "test", messages: [{ role: "user", content: "hi" }] });

    // We can't assert an exact id (it's minted freshly), but it should be a
    // non-empty string AND consistent across all events for one operation.
    const opIds = new Set(sink.events.map((e) => e.operation_id));
    expect(opIds.size).toBe(1);
    const [only] = opIds;
    expect(typeof only).toBe("string");
    expect(only!.length).toBeGreaterThan(0);
    expect(only).not.toBe("op-registry-level");
    expect(only).not.toBe("op-caller-supplied-42");
  });

  it("per-call context wins when both are set (alpha.31 precedence rule)", async () => {
    const { instr, sink } = collectingInstrumentation({
      operation_id: "op-registry-level",
    });
    const registry = buildRegistry(instr);
    const scopedPort = withObservabilityContext(registry.getPort(), {
      operation_id: "op-caller-wins",
    });

    await scopedPort.generateText({
      taskType: "test",
      messages: [{ role: "user", content: "hi" }],
    });

    for (const ev of sink.events) {
      expect(ev.operation_id).toBe("op-caller-wins");
    }
  });

  it("applies to generateStructured too", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = buildRegistry(instr);
    const scopedPort = withObservabilityContext(registry.getPort(), {
      operation_id: "op-structured-per-call",
    });

    await scopedPort.generateStructured({
      taskType: "test",
      messages: [{ role: "user", content: "hi" }],
      schema: z.object({ hello: z.string() }),
    });

    for (const ev of sink.events) {
      expect(ev.operation_id).toBe("op-structured-per-call");
    }
  });

  it("applies to runAgent too", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = buildRegistry(instr);
    const scopedPort = withObservabilityContext(registry.getPort(), {
      operation_id: "op-agent-per-call",
    });

    await scopedPort.runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
    });

    for (const ev of sink.events) {
      expect(ev.operation_id).toBe("op-agent-per-call");
    }
  });

  it("applies to streamText too", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = buildRegistry(instr);
    const scopedPort = withObservabilityContext(registry.getPort(), {
      operation_id: "op-streamtext-per-call",
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of scopedPort.streamText({
      taskType: "test",
      messages: [{ role: "user", content: "hi" }],
    })) {
      /* drain */
    }

    for (const ev of sink.events) {
      expect(ev.operation_id).toBe("op-streamtext-per-call");
    }
  });

  it("applies to streamStructured too", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = buildRegistry(instr);
    const scopedPort = withObservabilityContext(registry.getPort(), {
      operation_id: "op-streamstructured-per-call",
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of scopedPort.streamStructured({
      taskType: "test",
      messages: [{ role: "user", content: "hi" }],
      schema: z.object({ hello: z.string() }),
    })) {
      /* drain */
    }

    for (const ev of sink.events) {
      expect(ev.operation_id).toBe("op-streamstructured-per-call");
    }
  });

  it("distinct scoped ports for distinct calls receive distinct operation_ids", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = buildRegistry(instr);
    const rawPort = registry.getPort();

    await withObservabilityContext(rawPort, { operation_id: "op-call-1" })
      .generateText({ taskType: "test", messages: [{ role: "user", content: "one" }] });
    await withObservabilityContext(rawPort, { operation_id: "op-call-2" })
      .generateText({ taskType: "test", messages: [{ role: "user", content: "two" }] });

    const call1Ids = sink.events
      .filter((e, i) => i < sink.events.length / 2)
      .map((e) => e.operation_id);
    const call2Ids = sink.events
      .filter((e, i) => i >= sink.events.length / 2)
      .map((e) => e.operation_id);
    expect(new Set(call1Ids)).toEqual(new Set(["op-call-1"]));
    expect(new Set(call2Ids)).toEqual(new Set(["op-call-2"]));
  });
});
