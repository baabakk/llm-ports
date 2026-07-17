/**
 * Streamed cost surfacing (alpha.25+, LP-REQ-55).
 *
 * Tests cover the Registry-side plumbing:
 *   1. Adapter that fires the stream-complete callback produces onCost + onTokenUsage.
 *   2. Adapter that doesn't fire the callback produces NO onCost / onTokenUsage (no-op).
 *   3. Mid-stream errors do NOT fire cost events (callback not called).
 *   4. refs on the call flow through to the streamed onCost event.
 *   5. streamStructured has the same behavior as streamText.
 *
 * The adapter-openai integration (final chunk parsing, cost math) is
 * covered by that package's own tests; this test focuses on the Registry
 * contract for the streamed cost callback.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createRegistryFromEnv,
  readStreamCompleteCallback,
  type AdapterRegistration,
  type ArtifactRef,
  type CostEvent,
  type GenerateStructuredResult,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
  type StreamCompleteCallback,
  type TokenUsageEvent,
} from "../src/index.js";
import { z } from "zod";

const PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 2.0 };

/**
 * Build a mock port that yields text chunks then fires the Registry's
 * stream-complete callback with a canned usage before the async generator
 * returns.
 */
function makeStreamingPort(opts?: {
  chunks?: string[];
  fireCallback?: boolean;
  usageOverride?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  modelId?: string;
  providerAlias?: string;
  throwMidStream?: boolean;
}): LLMPort {
  const chunks = opts?.chunks ?? ["hello ", "world"];
  const fireCallback = opts?.fireCallback ?? true;
  const usage = opts?.usageOverride ?? {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
  };
  const modelId = opts?.modelId ?? "model-mock";
  const providerAlias = opts?.providerAlias ?? "primary";
  const throwMidStream = !!opts?.throwMidStream;
  return {
    async generateText(): Promise<GenerateTextResult> {
      throw new Error("unused");
    },
    async generateStructured<T>(): Promise<GenerateStructuredResult<T>> {
      throw new Error("unused");
    },
    async runAgent() {
      throw new Error("unused");
    },
    streamText: async function* (options) {
      const cb: StreamCompleteCallback | undefined = readStreamCompleteCallback(options);
      let count = 0;
      for (const c of chunks) {
        if (throwMidStream && count === 1) {
          throw new Error("mid-stream boom");
        }
        yield c;
        count++;
      }
      if (fireCallback && cb) {
        cb({
          usage,
          cost: {
            inputUSD: (usage.inputTokens / 1_000_000) * PRICING.inputPer1M,
            outputUSD: (usage.outputTokens / 1_000_000) * PRICING.outputPer1M,
            totalUSD:
              (usage.inputTokens / 1_000_000) * PRICING.inputPer1M +
              (usage.outputTokens / 1_000_000) * PRICING.outputPer1M,
          },
          modelId,
          providerAlias,
          latencyMs: 42,
        });
      }
    },
    streamStructured: async function* (options) {
      const cb: StreamCompleteCallback | undefined = readStreamCompleteCallback(options);
      yield { partial: 1 } as never;
      yield { partial: 2 } as never;
      if (fireCallback && cb) {
        cb({
          usage,
          cost: {
            inputUSD: 0.0001,
            outputUSD: 0.00004,
            totalUSD: 0.00014,
          },
          modelId,
          providerAlias,
          latencyMs: 42,
        });
      }
    },
  };
}

describe("streamed cost surfacing (alpha.25+)", () => {
  it("1. adapter firing the stream-complete callback produces onCost + onTokenUsage", async () => {
    const onCost = vi.fn();
    const onTokenUsage = vi.fn();
    const adapter: AdapterRegistration = {
      name: "stream-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort(),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "stream-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "stream-adapter": adapter },
      observability: { onCost, onTokenUsage },
    });

    const collected: string[] = [];
    for await (const chunk of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] })) {
      collected.push(chunk);
    }

    expect(collected.join("")).toBe("hello world");
    expect(onCost).toHaveBeenCalledTimes(1);
    const costEvent = onCost.mock.calls[0]![0] as CostEvent;
    expect(costEvent.operation).toBe("streamText");
    expect(costEvent.modelId).toBe("model-mock");
    expect(costEvent.totalUsd).toBeCloseTo(0.00014, 6);

    expect(onTokenUsage).toHaveBeenCalledTimes(1);
    const usageEvent = onTokenUsage.mock.calls[0]![0] as TokenUsageEvent;
    expect(usageEvent.operation).toBe("streamText");
    expect(usageEvent.inputTokens).toBe(100);
    expect(usageEvent.outputTokens).toBe(20);
  });

  it("2. adapter that skips the callback produces NO onCost / onTokenUsage (no-op)", async () => {
    const onCost = vi.fn();
    const onTokenUsage = vi.fn();
    const adapter: AdapterRegistration = {
      name: "silent-stream-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort({ fireCallback: false }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "silent-stream-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "silent-stream-adapter": adapter },
      observability: { onCost, onTokenUsage },
    });

    const collected: string[] = [];
    for await (const chunk of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] })) {
      collected.push(chunk);
    }

    expect(collected.length).toBeGreaterThan(0);
    expect(onCost).not.toHaveBeenCalled();
    expect(onTokenUsage).not.toHaveBeenCalled();
  });

  it("3. mid-stream errors do NOT fire cost events (callback never called)", async () => {
    const onCost = vi.fn();
    const adapter: AdapterRegistration = {
      name: "broken-stream-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort({ throwMidStream: true }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "broken-stream-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "broken-stream-adapter": adapter },
      observability: { onCost },
    });

    let caught: unknown;
    try {
      for await (const _c of registry
        .getPort()
        .streamText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] })) {
        // consume
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(onCost).not.toHaveBeenCalled();
  });

  it("4. refs on the call flow through to the streamed onCost event", async () => {
    const onCost = vi.fn();
    const adapter: AdapterRegistration = {
      name: "stream-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort(),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "stream-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "stream-adapter": adapter },
      observability: { onCost },
    });

    const refs: Record<string, ArtifactRef> = {
      prompt: { key: "greeting", version: 1 },
    };
    for await (const _c of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }], refs })) {
      // consume
    }

    expect(onCost).toHaveBeenCalledTimes(1);
    const event = onCost.mock.calls[0]![0] as CostEvent;
    expect(event.refs).toEqual(refs);
  });

  it("5. streamStructured has the same behavior as streamText", async () => {
    const onCost = vi.fn();
    const onTokenUsage = vi.fn();
    const adapter: AdapterRegistration = {
      name: "stream-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort(),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "stream-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "stream-adapter": adapter },
      observability: { onCost, onTokenUsage },
    });

    for await (const _c of registry.getPort().streamStructured({
      taskType: "test",
      messages: [{ role: "user" as const, content: "hi" }],
      schema: z.object({ partial: z.number() }),
    })) {
      // consume
    }

    expect(onCost).toHaveBeenCalledTimes(1);
    expect((onCost.mock.calls[0]![0] as CostEvent).operation).toBe("streamStructured");
    expect(onTokenUsage).toHaveBeenCalledTimes(1);
  });
});
