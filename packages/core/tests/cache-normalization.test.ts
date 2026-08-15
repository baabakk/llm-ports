/**
 * Alpha.30 §2.6 — provider-cache normalization on the Registry side.
 *
 * The five in-process adapters (openai, anthropic, google, ollama,
 * vercel) all surface prompt-cache activity through
 * `TokenUsage.cacheReadTokens` / `.cacheWriteTokens`. The Registry's
 * `toContractMetricsBase` folds those native counts into the contract's
 * `CacheStats.provider_cache` shape at the emission boundary so
 * consumers see one canonical shape regardless of provider.
 *
 * Behavior verified:
 *   - "hit" when read_input_tokens >= inputTokens.
 *   - "partial" when 0 < read_input_tokens < inputTokens.
 *   - "miss" when read_input_tokens == 0 but the adapter reported the
 *     field (cache was consulted, nothing hit).
 *   - Anthropic-shape write_input_tokens carries through when reported.
 *   - Missing both fields → no cache_stats emission (adapter is
 *     silent about cache, not "provider reported zero").
 *   - generateText, generateStructured, and runAgent all funnel through
 *     the same base extractor.
 *   - Streaming path derives the same cache_stats from the adapter's
 *     `StreamCompleteMetadata.usage`.
 */

import { describe, expect, it } from "vitest";
import {
  createCollectingSink,
  type AttemptCompletedData,
  type EventSource,
  type ProviderCacheStats,
} from "@llm-ports/observability-contract";
import {
  createRegistryFromEnv,
  readStreamCompleteCallback,
  type AdapterRegistration,
  type AgentResult,
  type GenerateStructuredResult,
  type GenerateTextResult,
  type Instrumentation,
  type LLMPort,
  type ModelPricing,
  type StreamCompleteCallback,
  type TokenUsage,
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

function makePort(usage: TokenUsage): LLMPort {
  return {
    async generateText(): Promise<GenerateTextResult> {
      return {
        text: "response body",
        usage,
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        modelId: "model-mock",
        providerAlias: "primary",
        latencyMs: 1,
      };
    },
    async generateStructured<T>(): Promise<GenerateStructuredResult<T>> {
      return {
        data: { ok: true } as unknown as T,
        text: '{"ok":true}',
        usage,
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        modelId: "model-mock",
        providerAlias: "primary",
        latencyMs: 1,
      };
    },
    async runAgent(): Promise<AgentResult> {
      return {
        text: "agent final text",
        messages: [{ role: "assistant", content: "step" }],
        toolCalls: [],
        usage,
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        modelId: "model-mock",
        providerAlias: "primary",
        latencyMs: 1,
        stepsTaken: 1,
        terminationReason: "completed",
      };
    },
    streamText: async function* (options) {
      const cb: StreamCompleteCallback | undefined = readStreamCompleteCallback(options);
      yield "chunk";
      if (cb) {
        cb({
          usage,
          cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
          modelId: "model-mock",
          providerAlias: "primary",
          latencyMs: 1,
        });
      }
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

function registryWith(usage: TokenUsage): {
  registry: ReturnType<typeof createRegistryFromEnv>;
  sink: ReturnType<typeof createCollectingSink>;
} {
  const { instr, sink } = collectingInstrumentation();
  const adapter: AdapterRegistration = {
    name: "test-adapter",
    pricing: { "model-mock": PRICING },
    createLLMPort: () => makePort(usage),
  };
  const registry = createRegistryFromEnv({
    env: {
      LLM_PROVIDER_PRIMARY: "test-adapter|model-mock|req:100/hour",
      LLM_TASK_ROUTE_TEST: "primary",
    },
    adapters: { "test-adapter": adapter },
    instrumentation: instr,
  });
  return { registry, sink };
}

function completedCacheStats(sink: ReturnType<typeof createCollectingSink>): ProviderCacheStats | undefined {
  const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed");
  if (!completed) return undefined;
  return (completed.data as AttemptCompletedData).cache_stats?.provider_cache;
}

describe("Alpha.30 §2.6 — provider-cache normalization", () => {
  it("'hit' when cacheReadTokens covers the whole input (typical full-cache OpenAI response)", async () => {
    const { registry, sink } = registryWith({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 100,
    });
    await registry
      .getPort()
      .generateText({ taskType: "test", messages: [{ role: "user", content: "hi" }] });

    const pc = completedCacheStats(sink);
    expect(pc).toBeDefined();
    expect(pc!.status).toBe("hit");
    expect(pc!.read_input_tokens).toBe(100);
    expect(pc!.provider_reported).toBe(true);
    expect(pc!.write_input_tokens).toBeUndefined();
  });

  it("'partial' when cache read only covers a prefix (some fresh tokens follow)", async () => {
    const { registry, sink } = registryWith({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 30,
    });
    await registry
      .getPort()
      .generateText({ taskType: "test", messages: [{ role: "user", content: "hi" }] });

    const pc = completedCacheStats(sink);
    expect(pc!.status).toBe("partial");
    expect(pc!.read_input_tokens).toBe(30);
  });

  it("'miss' when Anthropic reports cache_read_input_tokens=0 alongside a write (cache consulted, nothing hit)", async () => {
    const { registry, sink } = registryWith({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 0,
      cacheWriteTokens: 100,
    });
    await registry
      .getPort()
      .generateText({ taskType: "test", messages: [{ role: "user", content: "hi" }] });

    const pc = completedCacheStats(sink);
    expect(pc!.status).toBe("miss");
    expect(pc!.read_input_tokens).toBe(0);
    expect(pc!.write_input_tokens).toBe(100);
  });

  it("carries both read + write when both are reported (Anthropic partial-hit + fresh write)", async () => {
    const { registry, sink } = registryWith({
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 220,
      cacheReadTokens: 100,
      cacheWriteTokens: 100,
    });
    await registry
      .getPort()
      .generateText({ taskType: "test", messages: [{ role: "user", content: "hi" }] });

    const pc = completedCacheStats(sink);
    expect(pc!.status).toBe("partial");
    expect(pc!.read_input_tokens).toBe(100);
    expect(pc!.write_input_tokens).toBe(100);
  });

  it("omits cache_stats entirely when the adapter reports no cache fields (Ollama / Vercel-shape)", async () => {
    const { registry, sink } = registryWith({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      // no cacheReadTokens or cacheWriteTokens
    });
    await registry
      .getPort()
      .generateText({ taskType: "test", messages: [{ role: "user", content: "hi" }] });

    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed");
    expect((completed!.data as AttemptCompletedData).cache_stats).toBeUndefined();
  });

  it("generateStructured emits the same cache_stats shape", async () => {
    const { registry, sink } = registryWith({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 50,
    });
    await registry.getPort().generateStructured({
      taskType: "test",
      messages: [{ role: "user", content: "hi" }],
      schema: {
        _def: {},
        parse: (v: unknown) => v,
        safeParse: (v: unknown) => ({ success: true as const, data: v }),
      } as never,
    });
    const pc = completedCacheStats(sink);
    expect(pc!.status).toBe("partial");
    expect(pc!.read_input_tokens).toBe(50);
  });

  it("runAgent emits the same cache_stats shape", async () => {
    const { registry, sink } = registryWith({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 100,
    });
    await registry.getPort().runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
    });
    const pc = completedCacheStats(sink);
    expect(pc!.status).toBe("hit");
    expect(pc!.read_input_tokens).toBe(100);
  });

  it("streamText derives cache_stats from StreamCompleteMetadata.usage", async () => {
    const { registry, sink } = registryWith({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 100,
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      /* drain */
    }
    const pc = completedCacheStats(sink);
    expect(pc!.status).toBe("hit");
    expect(pc!.read_input_tokens).toBe(100);
  });

  it("streamText omits cache_stats when the adapter reports no cache fields on stream complete", async () => {
    const { registry, sink } = registryWith({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      /* drain */
    }
    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed");
    expect((completed!.data as AttemptCompletedData).cache_stats).toBeUndefined();
  });
});
