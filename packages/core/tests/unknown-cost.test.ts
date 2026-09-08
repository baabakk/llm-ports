/**
 * Alpha.34 — unknown cost is emitted as absent, never as zeros.
 *
 * Before this release, an attempt whose cost was not reported had zeros
 * substituted on the way to the sink. That is the same silent-corruption
 * shape this project has documented twice already: a zero is
 * indistinguishable from a genuinely free call, so a `SUM` over mixed rows
 * under-counts and looks entirely plausible while doing it.
 *
 * The substitution was never covered by a test, which is why it survived.
 */

import { describe, expect, it } from "vitest";
import { createCollectingSink } from "@llm-ports/observability-contract";
import {
  createRegistryFromEnv,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1, outputPer1M: 2 };

/** An adapter that reports usage but no cost, as the subprocess adapters do. */
function portWithoutCost(): LLMPort {
  return {
    generateText: async () =>
      ({
        text: "ok",
        modelId: "model-x",
        providerAlias: "a",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }) as GenerateTextResult,
  } as unknown as LLMPort;
}

function portWithCost(): LLMPort {
  return {
    generateText: async () =>
      ({
        text: "ok",
        modelId: "model-x",
        providerAlias: "a",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        cost: { inputUSD: 0.01, outputUSD: 0.02, totalUSD: 0.03 },
      }) as GenerateTextResult,
  } as unknown as LLMPort;
}

function adapterFor(port: LLMPort): AdapterRegistration {
  return { name: "alpha", pricing: { "model-x": PRICING }, createLLMPort: () => port };
}

const ENV = {
  LLM_PROVIDER_A: "alpha|model-x|req:100/hour",
  LLM_TASK_ROUTE_CHAT: "a",
} as const;

const CALL = { taskType: "chat", messages: [{ role: "user" as const, content: "hi" }] };

async function completedEvent(port: LLMPort): Promise<Record<string, unknown>> {
  const sink = createCollectingSink();
  const registry = createRegistryFromEnv({
    env: { ...ENV },
    adapters: { alpha: adapterFor(port) },
    instrumentation: {
      config: { sink, source: { library: "test", library_version: "0" } },
    },
  });
  await registry.getPort().generateText({ ...CALL });
  const ev = sink.events.find((e) => e.event_type === "llm.attempt.completed");
  expect(ev).toBeDefined();
  return (ev as { data: Record<string, unknown> }).data;
}

describe("cost on the attempt-completed event", () => {
  it("is absent when the adapter reported no cost", async () => {
    const data = await completedEvent(portWithoutCost());
    // Absent, not zeros. `toBeUndefined` rather than a falsy check, because
    // a zeroed CostUsage object is truthy and would pass a loose assertion
    // while being exactly the bug.
    expect(data["cost"]).toBeUndefined();
  });

  it("still carries usage when cost is unknown", async () => {
    // Unknown cost must not suppress the token counts. They are separately
    // knowable and a consumer charting volume should still see the call.
    const data = await completedEvent(portWithoutCost());
    expect(data["usage"]).toMatchObject({ totalTokens: 15 });
  });

  it("is present and exact when the adapter did report cost", async () => {
    const data = await completedEvent(portWithCost());
    expect(data["cost"]).toMatchObject({ totalUSD: 0.03 });
  });
});
