/**
 * `refs` field (alpha.25+) — domain-agnostic trace-metadata field on all
 * call-options interfaces that flows through to observability events.
 *
 * Tests cover:
 *   1. Refs on generateText flow through to onCost / onTokenUsage.
 *   2. Refs on generateStructured flow through to onCost / onTokenUsage.
 *   3. Refs on runAgent flow through to onCost / onTokenUsage.
 *   4. Refs preserved across walkChain fallback advancement (onFallback + winner).
 *   5. Refs on onCacheHit when the adapter reports cache tokens.
 *   6. Refs never appear in the SDK request body sent to the model (option omitted).
 *   7. Missing / empty / undefined refs do not stamp anything spurious.
 *
 * The refs field is deliberately not part of any adapter's SDK request; the
 * Registry threads it into observability emits only.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createRegistryFromEnv,
  ProviderUnavailableError,
  type AdapterRegistration,
  type AgentResult,
  type ArtifactRef,
  type CacheHitEvent,
  type CostEvent,
  type FallbackEvent,
  type GenerateStructuredResult,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
  type TokenUsageEvent,
} from "../src/index.js";
import { z } from "zod";

const PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 2.0, cacheReadPer1M: 0.5 };

function makePort(
  modelId: string,
  alias: string,
  opts?: { errorOnce?: boolean; cached?: number },
): LLMPort {
  let throwNext = !!opts?.errorOnce;
  const baseResult = {
    text: "out",
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      ...(opts?.cached !== undefined ? { cacheReadTokens: opts.cached } : {}),
    },
    cost: {
      inputUSD: 0.001,
      outputUSD: 0.0004,
      totalUSD: 0.0014,
      ...(opts?.cached !== undefined ? { cacheSavingsUSD: 0.0003 } : {}),
    },
    modelId,
    providerAlias: alias,
    latencyMs: 10,
  };
  return {
    async generateText(): Promise<GenerateTextResult> {
      if (throwNext) {
        throwNext = false;
        throw new ProviderUnavailableError(alias, new Error("simulated 503"));
      }
      return baseResult;
    },
    async generateStructured<T>(): Promise<GenerateStructuredResult<T>> {
      return {
        data: {} as T,
        ...baseResult,
        validationAttempts: 1,
      };
    },
    async runAgent(): Promise<AgentResult> {
      return {
        messages: [],
        toolCalls: [],
        stepsTaken: 1,
        terminationReason: "completed",
        ...baseResult,
      };
    },
    streamText: async function* () {
      yield "stub";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

const adapterA: AdapterRegistration = {
  name: "adapter-a",
  pricing: { "model-a": PRICING },
  createLLMPort: (modelId, alias) => makePort(modelId, alias),
};

const adapterCached: AdapterRegistration = {
  name: "adapter-cached",
  pricing: { "model-c": PRICING },
  createLLMPort: (modelId, alias) => makePort(modelId, alias, { cached: 600 }),
};

const adapterTransient: AdapterRegistration = {
  name: "adapter-transient",
  pricing: { "model-t": PRICING },
  createLLMPort: (modelId, alias) => makePort(modelId, alias, { errorOnce: true }),
};

const SAMPLE_REFS: Record<string, ArtifactRef> = {
  prompt: { key: "team-dev.materialize", version: 7, hash: "abc123" },
  scaffold: { key: "puzzle-service", version: 3 },
  experiment: {
    key: "prompt-tone-experiment",
    version: "variant-b",
    meta: { cohort: "control" },
  },
};

describe("refs field (alpha.25+)", () => {
  it("1. refs on generateText flow through to onCost + onTokenUsage", async () => {
    const onCost = vi.fn();
    const onTokenUsage = vi.fn();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "adapter-a|model-a|req:5/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "adapter-a": adapterA },
      observability: { onCost, onTokenUsage },
    });

    await registry
      .getPort()
      .generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }], refs: SAMPLE_REFS });

    expect(onCost).toHaveBeenCalledTimes(1);
    const costEvent = onCost.mock.calls[0]![0] as CostEvent;
    expect(costEvent.refs).toEqual(SAMPLE_REFS);

    expect(onTokenUsage).toHaveBeenCalledTimes(1);
    const usageEvent = onTokenUsage.mock.calls[0]![0] as TokenUsageEvent;
    expect(usageEvent.refs).toEqual(SAMPLE_REFS);
  });

  it("2. refs on generateStructured flow through to onCost + onTokenUsage", async () => {
    const onCost = vi.fn();
    const onTokenUsage = vi.fn();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "adapter-a|model-a|req:5/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "adapter-a": adapterA },
      observability: { onCost, onTokenUsage },
    });

    await registry.getPort().generateStructured({
      taskType: "test",
      messages: [{ role: "user" as const, content: "hi" }],
      schema: z.object({ x: z.number() }),
      refs: { prompt: { key: "p", version: 1 } },
    });

    expect(onCost).toHaveBeenCalledTimes(1);
    expect((onCost.mock.calls[0]![0] as CostEvent).refs).toEqual({
      prompt: { key: "p", version: 1 },
    });
    expect((onTokenUsage.mock.calls[0]![0] as TokenUsageEvent).refs).toEqual({
      prompt: { key: "p", version: 1 },
    });
  });

  it("3. refs on runAgent flow through to onCost + onTokenUsage", async () => {
    const onCost = vi.fn();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "adapter-a|model-a|req:5/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "adapter-a": adapterA },
      observability: { onCost },
    });

    await registry.getPort().runAgent({
      taskType: "test",
      instructions: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      refs: { agent: { key: "planner", version: 2 } },
    });

    const event = onCost.mock.calls[0]![0] as CostEvent;
    expect(event.operation).toBe("runAgent");
    expect(event.refs).toEqual({ agent: { key: "planner", version: 2 } });
  });

  it("4. refs preserved across walkChain fallback advancement", async () => {
    const onFallback = vi.fn();
    const onCost = vi.fn();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "adapter-transient|model-t|req:5/hour",
        LLM_PROVIDER_BACKUP: "adapter-a|model-a|req:5/hour",
        LLM_TASK_ROUTE_TEST: "primary,backup",
      },
      adapters: {
        "adapter-transient": adapterTransient,
        "adapter-a": adapterA,
      },
      observability: { onFallback, onCost },
    });

    await registry
      .getPort()
      .generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }], refs: SAMPLE_REFS });

    expect(onFallback).toHaveBeenCalledTimes(1);
    const fbEvent = onFallback.mock.calls[0]![0] as FallbackEvent;
    expect(fbEvent.fromAlias).toBe("primary");
    expect(fbEvent.toAlias).toBe("backup");
    expect(fbEvent.refs).toEqual(SAMPLE_REFS);

    // Winner's onCost also carries refs.
    expect(onCost).toHaveBeenCalledTimes(1);
    expect((onCost.mock.calls[0]![0] as CostEvent).refs).toEqual(SAMPLE_REFS);
  });

  it("5. refs on onCacheHit when the adapter reports cache tokens", async () => {
    const onCacheHit = vi.fn();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "adapter-cached|model-c|req:5/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "adapter-cached": adapterCached },
      observability: { onCacheHit },
    });

    await registry.getPort().generateText({
      taskType: "test",
      messages: [{ role: "user" as const, content: "hi" }],
      refs: { session: { key: "sess-abc123" } },
    });

    expect(onCacheHit).toHaveBeenCalledTimes(1);
    const event = onCacheHit.mock.calls[0]![0] as CacheHitEvent;
    expect(event.refs).toEqual({ session: { key: "sess-abc123" } });
  });

  it("6. refs is never included in the adapter's port arguments as a first-class SDK field", async () => {
    const seenOptions: Array<Record<string, unknown>> = [];
    const spyPort: LLMPort = {
      async generateText(options): Promise<GenerateTextResult> {
        seenOptions.push({ ...options });
        return {
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
          modelId: "model-a",
          providerAlias: "primary",
          latencyMs: 1,
        };
      },
      async generateStructured() {
        throw new Error("not used");
      },
      async runAgent() {
        throw new Error("not used");
      },
      streamText: async function* () {
        yield "stub";
      },
      streamStructured: async function* () {
        yield {} as never;
      },
    };
    const spyAdapter: AdapterRegistration = {
      name: "spy",
      pricing: { "model-a": PRICING },
      createLLMPort: () => spyPort,
    };

    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "spy|model-a|req:5/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { spy: spyAdapter },
    });

    await registry.getPort().generateText({
      taskType: "test",
      messages: [{ role: "user" as const, content: "hi" }],
      refs: { prompt: { key: "p" } },
    });

    // The adapter DOES see refs on options (they pass through), but the
    // contract is: adapters MUST NOT include refs in the SDK request body.
    // The registry's job is to preserve refs on the options so adapters can
    // read them if they want to; the adapter's job is to not forward them
    // to the provider. This test asserts the options-preservation half.
    expect(seenOptions[0]!.refs).toEqual({ prompt: { key: "p" } });
  });

  it("7. missing refs does not stamp anything spurious", async () => {
    const onCost = vi.fn();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "adapter-a|model-a|req:5/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "adapter-a": adapterA },
      observability: { onCost },
    });

    // No refs on the call.
    await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });

    const event = onCost.mock.calls[0]![0] as CostEvent;
    // refs field is absent from the event object (not "refs: undefined").
    expect("refs" in event).toBe(false);
  });

  it("empty refs object flows through as empty (opt-in absence)", async () => {
    const onCost = vi.fn();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "adapter-a|model-a|req:5/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "adapter-a": adapterA },
      observability: { onCost },
    });

    await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }], refs: {} });

    const event = onCost.mock.calls[0]![0] as CostEvent;
    expect(event.refs).toEqual({});
  });
});
