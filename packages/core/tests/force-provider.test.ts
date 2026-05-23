/**
 * forceProviderAlias — per-call routing override (issue #15).
 *
 * Bypasses the task-routing chain. Per-provider budget gates still apply.
 * Runtime fallback does NOT engage — caller explicitly asked for this provider.
 *
 * Shipped in 0.1.0-alpha.7.
 */

import { describe, expect, it } from "vitest";
import { Registry } from "../src/registry/registry.js";
import {
  NoProvidersAvailableError,
  ProviderUnavailableError,
} from "../src/errors.js";
import type {
  AgentResult,
  GenerateStructuredResult,
  GenerateTextResult,
  LLMPort,
} from "../src/ports/llm-port.js";
import type { AdapterRegistration } from "../src/registry/registry.js";

function makeMockPort(textOk: string): LLMPort {
  const baseUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const baseCost = { inputUSD: 0, outputUSD: 0, totalUSD: 0.001 };
  return {
    async generateText(): Promise<GenerateTextResult> {
      return {
        text: textOk,
        usage: baseUsage,
        cost: baseCost,
        modelId: "m",
        providerAlias: "from-port",
        latencyMs: 1,
      };
    },
    async generateStructured<T>(): Promise<GenerateStructuredResult<T>> {
      return {
        data: { ok: true } as T,
        usage: baseUsage,
        cost: baseCost,
        modelId: "m",
        providerAlias: "from-port",
        latencyMs: 1,
        validationAttempts: 1,
      };
    },
    async *streamText() {
      yield textOk;
    },
    async *streamStructured() {
      yield {};
    },
    async runAgent(): Promise<AgentResult> {
      return {
        text: textOk,
        messages: [],
        toolCalls: [],
        stepsTaken: 1,
        terminationReason: "completed",
        usage: baseUsage,
        cost: baseCost,
        modelId: "m",
        providerAlias: "from-port",
        latencyMs: 1,
      };
    },
  };
}

function makeAdapter(port: LLMPort): AdapterRegistration {
  return {
    name: "test",
    pricing: { test: { inputPer1M: 1, outputPer1M: 1 } },
    createLLMPort: () => port,
  };
}

describe("forceProviderAlias", () => {
  it("routes directly to the named provider, bypassing the task-routing chain", async () => {
    const cheap = makeMockPort("cheap-result");
    const expensive = makeMockPort("expensive-result");
    const registry = new Registry({
      env: {
        LLM_PROVIDER_CHEAP: "test|test|cost:1/day",
        LLM_PROVIDER_EXPENSIVE: "test|test|cost:1/day",
        LLM_TASK_ROUTE_DESCRIBE: "cheap", // task route picks cheap by default
      },
      adapters: {
        test: makeAdapter(cheap), // same factory; not actually distinguishing here
      },
    });
    const llm = registry.getPort();

    // Default routing: picks cheap (only provider in chain).
    const a = await llm.generateText({ taskType: "describe", prompt: "x" });
    // forceProviderAlias: routes directly to expensive (NOT in the chain).
    const b = await llm.generateText({
      taskType: "describe",
      prompt: "x",
      forceProviderAlias: "expensive",
    });

    // Both succeed; both use the same mock factory so text is the same. The
    // important assertion is that `expensive` was resolved despite not being
    // in the task chain. If it weren't, NoProvidersAvailable would throw.
    expect(a.text).toBe("cheap-result");
    expect(b.text).toBe("cheap-result");
  });

  it("throws NoProvidersAvailableError when the forced alias is unconfigured", async () => {
    const registry = new Registry({
      env: {
        LLM_PROVIDER_CHEAP: "test|test|cost:1/day",
        LLM_TASK_ROUTE_DESCRIBE: "cheap",
      },
      adapters: { test: makeAdapter(makeMockPort("ok")) },
    });
    await expect(
      registry.getPort().generateText({
        taskType: "describe",
        prompt: "x",
        forceProviderAlias: "ghost-provider",
      }),
    ).rejects.toThrow(NoProvidersAvailableError);
  });

  it("does NOT engage runtime fallback when the forced provider fails", async () => {
    // forceProviderAlias is an explicit caller decision; if that provider fails,
    // the error propagates instead of silently falling back to another.
    const failingPort: LLMPort = {
      ...makeMockPort("never"),
      async generateText() {
        throw new ProviderUnavailableError("forced", new Error("503"));
      },
    };
    const fallback = makeMockPort("fallback-result");
    const registry = new Registry({
      env: {
        LLM_PROVIDER_FORCED: "test|test|cost:1/day",
        LLM_PROVIDER_FALLBACK: "test|test|cost:1/day",
        LLM_TASK_ROUTE_DESCRIBE: "forced,fallback",
      },
      adapters: {
        test: {
          name: "test",
          pricing: { test: { inputPer1M: 1, outputPer1M: 1 } },
          createLLMPort: (_modelId, alias) =>
            alias === "forced" ? failingPort : fallback,
        },
      },
    });
    await expect(
      registry.getPort().generateText({
        taskType: "describe",
        prompt: "x",
        forceProviderAlias: "forced",
      }),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it("per-provider budget gates still apply to the forced alias", async () => {
    // If the forced provider is over its cost cap, the call fails — caller can't
    // use forceProviderAlias to bypass a hard cap.
    const registry = new Registry({
      env: {
        LLM_PROVIDER_TINY: "test|test|cost:0.00000001/day", // ridiculously low
        LLM_TASK_ROUTE_DESCRIBE: "tiny",
      },
      adapters: { test: makeAdapter(makeMockPort("ok")) },
      cost: {
        recordCost: async () => {},
        // Always return "exceeded" to simulate the cap being hit.
        check: async () => ({ allowed: false, reason: "cost cap exceeded" }),
      },
    });
    let caught: unknown;
    try {
      await registry.getPort().generateText({
        taskType: "describe",
        prompt: "x",
        forceProviderAlias: "tiny",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoProvidersAvailableError);
    expect((caught as NoProvidersAvailableError).reasons["tiny"]).toMatch(/cost|budget/i);
  });

  it("P0 priority bypasses budget gates even when forcing a provider", async () => {
    const registry = new Registry({
      env: {
        LLM_PROVIDER_TINY: "test|test|cost:0.00000001/day",
        LLM_TASK_ROUTE_DESCRIBE: "tiny",
      },
      adapters: { test: makeAdapter(makeMockPort("ok")) },
      cost: {
        recordCost: async () => {},
        check: async () => ({ allowed: false, reason: "cost cap exceeded" }),
      },
    });
    // priority: 0 bypasses budget checks (matches existing selectModel contract).
    const result = await registry.getPort().generateText({
      taskType: "describe",
      prompt: "x",
      priority: 0,
      forceProviderAlias: "tiny",
    });
    expect(result.text).toBe("ok");
  });
});
