/**
 * Registry.checkPricingFreshness — compare bundled per-adapter pricing
 * tables against each provider's live model catalog (alpha.9, issue #9).
 *
 * Reports drift: models bundled but not exposed (deprecated), models
 * exposed but not bundled (newly launched), and per-model rate
 * divergence when the provider's API exposes pricing.
 */

import { describe, expect, it } from "vitest";
import { Registry } from "../src/registry/registry.js";
import type {
  AgentResult,
  GenerateStructuredResult,
  GenerateTextResult,
  LLMPort,
  ProviderModelInfo,
} from "../src/ports/llm-port.js";
import type { AdapterRegistration } from "../src/registry/registry.js";

function makeBoringPort(listModelsImpl?: () => Promise<ProviderModelInfo[]>): LLMPort {
  const baseUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const baseCost = { inputUSD: 0, outputUSD: 0, totalUSD: 0 };
  const port: LLMPort = {
    async generateText(): Promise<GenerateTextResult> {
      return { text: "x", usage: baseUsage, cost: baseCost, modelId: "m", providerAlias: "p", latencyMs: 0 };
    },
    async generateStructured<T>(): Promise<GenerateStructuredResult<T>> {
      return { data: {} as T, usage: baseUsage, cost: baseCost, modelId: "m", providerAlias: "p", latencyMs: 0, validationAttempts: 1 };
    },
    async *streamText() { yield "x"; },
    async *streamStructured() { yield {}; },
    async runAgent(): Promise<AgentResult> {
      return { text: "x", messages: [], toolCalls: [], stepsTaken: 1, terminationReason: "completed", usage: baseUsage, cost: baseCost, modelId: "m", providerAlias: "p", latencyMs: 0 };
    },
  };
  if (listModelsImpl) {
    port.listModels = listModelsImpl;
  }
  return port;
}

describe("Registry.checkPricingFreshness", () => {
  it("reports added/removed models against the bundled pricing table", async () => {
    const adapter: AdapterRegistration = {
      name: "alpha",
      pricing: {
        "old-model": { inputPer1M: 1, outputPer1M: 2 },
        "current-model": { inputPer1M: 3, outputPer1M: 6 },
      },
      createLLMPort: () =>
        makeBoringPort(async () => [
          { id: "current-model" },
          { id: "shiny-new-model" },
        ]),
    };

    const registry = new Registry({
      env: {
        LLM_PROVIDER_ALPHA: "alpha|current-model|cost:1/day",
        LLM_TASK_ROUTE_GENERAL: "alpha",
      },
      adapters: { alpha: adapter },
    });

    const report = await registry.checkPricingFreshness();
    expect(report.skipped).toHaveLength(0);
    expect(report.checked).toHaveLength(1);
    const alphaReport = report.checked[0]!;
    expect(alphaReport.adapter).toBe("alpha");
    expect(alphaReport.liveModelCount).toBe(2);
    expect(alphaReport.bundledModelCount).toBe(2);
    expect(alphaReport.addedModels).toEqual(["shiny-new-model"]);
    expect(alphaReport.removedModels).toEqual(["old-model"]);
    expect(alphaReport.priceDrift).toEqual([]);
  });

  it("reports price drift when the live API exposes pricing that differs", async () => {
    const adapter: AdapterRegistration = {
      name: "alpha",
      pricing: { "model-a": { inputPer1M: 1, outputPer1M: 2 } },
      createLLMPort: () =>
        makeBoringPort(async () => [{ id: "model-a", inputPer1M: 1.5, outputPer1M: 2 }]),
    };

    const registry = new Registry({
      env: {
        LLM_PROVIDER_ALPHA: "alpha|model-a|cost:1/day",
        LLM_TASK_ROUTE_GENERAL: "alpha",
      },
      adapters: { alpha: adapter },
    });

    const report = await registry.checkPricingFreshness();
    expect(report.checked[0]!.priceDrift).toEqual([
      {
        modelId: "model-a",
        bundledInputPer1M: 1,
        bundledOutputPer1M: 2,
        liveInputPer1M: 1.5,
        liveOutputPer1M: 2,
      },
    ]);
  });

  it("skips adapters that do not implement listModels()", async () => {
    const adapter: AdapterRegistration = {
      name: "no-discovery",
      pricing: { "model-x": { inputPer1M: 1, outputPer1M: 1 } },
      createLLMPort: () => makeBoringPort(),
    };

    const registry = new Registry({
      env: {
        LLM_PROVIDER_ND: "no-discovery|model-x|cost:1/day",
        LLM_TASK_ROUTE_GENERAL: "nd",
      },
      adapters: { "no-discovery": adapter },
    });

    const report = await registry.checkPricingFreshness();
    expect(report.checked).toHaveLength(0);
    expect(report.skipped).toEqual([
      { adapter: "no-discovery", reason: "adapter does not implement listModels()" },
    ]);
  });

  it("captures listModels() errors as skipped entries instead of throwing", async () => {
    const adapter: AdapterRegistration = {
      name: "alpha",
      pricing: { "model-a": { inputPer1M: 1, outputPer1M: 1 } },
      createLLMPort: () =>
        makeBoringPort(async () => {
          throw new Error("network down");
        }),
    };

    const registry = new Registry({
      env: {
        LLM_PROVIDER_ALPHA: "alpha|model-a|cost:1/day",
        LLM_TASK_ROUTE_GENERAL: "alpha",
      },
      adapters: { alpha: adapter },
    });

    const report = await registry.checkPricingFreshness();
    expect(report.checked).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.adapter).toBe("alpha");
    expect(report.skipped[0]!.reason).toContain("network down");
  });
});
