/**
 * OTel-aligned observability hooks (alpha.21+).
 *
 * Five hooks, fire-and-forget, swallow errors:
 *   - onCost            : per-call cost breakdown (every successful call)
 *   - onTokenUsage      : per-call token counts (every successful call)
 *   - onFallback        : chain advancement (from one alias to the next)
 *   - onValidationRetry : retry-with-feedback on structured output (TYPE ONLY in alpha.21 — emission via adapter onRetry)
 *   - onCacheHit        : cached_tokens > 0 in the response
 *
 * Tests cover:
 *   1. Hooks fire in the right order on a successful call.
 *   2. Hooks fire on the right path on a fallback advancement.
 *   3. deriveCacheHit returns null when no cache tokens are present.
 *   4. Hook errors are swallowed; the inference call still returns success.
 *   5. Optional fields only appear when present on the source data.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createRegistryFromEnv,
  deriveCacheHit,
  emitCacheHit,
  emitCost,
  emitFallback,
  emitTokenUsage,
  emitValidationRetry,
  NoProvidersAvailableError,
  ProviderUnavailableError,
  type AdapterRegistration,
  type CacheHitEvent,
  type CostEvent,
  type FallbackEvent,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
  type ObservabilityHooks,
  type TokenUsageEvent,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 2.0, cacheReadPer1M: 0.5 };

function makePort(modelId: string, alias: string, opts?: {
  cached?: number;
  errorOnce?: boolean;
}): LLMPort {
  let throwNext = !!opts?.errorOnce;
  return {
    async generateText(): Promise<GenerateTextResult> {
      if (throwNext) {
        throwNext = false;
        throw new ProviderUnavailableError(alias, modelId, new Error("simulated 503"));
      }
      return {
        text: `out`,
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
}

const fakeAdapterPlain: AdapterRegistration = {
  name: "fake-plain",
  pricing: { "model-a": PRICING },
  createLLMPort: (modelId, alias) => makePort(modelId, alias),
};

const fakeAdapterCached: AdapterRegistration = {
  name: "fake-cached",
  pricing: { "model-b": PRICING },
  createLLMPort: (modelId, alias) => makePort(modelId, alias, { cached: 600 }),
};

const fakeAdapterTransient: AdapterRegistration = {
  name: "fake-transient",
  pricing: { "model-c": PRICING },
  createLLMPort: (modelId, alias) => makePort(modelId, alias, { errorOnce: true }),
};

describe("OTel observability hooks (alpha.21+)", () => {
  describe("onCost", () => {
    it("fires once per successful generateText with the right shape", async () => {
      const onCost = vi.fn();
      const registry = createRegistryFromEnv({
        env: {
          LLM_PROVIDER_PRIMARY: "fake-plain|model-a|req:5/hour",
          LLM_TASK_ROUTE_TEST: "primary",
        },
        adapters: { "fake-plain": fakeAdapterPlain },
        observability: { onCost },
      });

      await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });

      expect(onCost).toHaveBeenCalledTimes(1);
      const event = onCost.mock.calls[0]![0] as CostEvent;
      expect(event.promptUsd).toBe(0.001);
      expect(event.completionUsd).toBe(0.0004);
      expect(event.totalUsd).toBe(0.0014);
      expect(event.modelId).toBe("model-a");
      expect(event.providerAlias).toBe("primary");
      expect(event.operation).toBe("generateText");
      expect(event.taskType).toBe("test");
      // No cache savings on this adapter → field omitted, not undefined-typed.
      expect("cacheReadUsd" in event).toBe(false);
    });

    it("includes cacheReadUsd when the adapter reports cache savings", async () => {
      const onCost = vi.fn();
      const registry = createRegistryFromEnv({
        env: {
          LLM_PROVIDER_PRIMARY: "fake-cached|model-b|req:5/hour",
          LLM_TASK_ROUTE_TEST: "primary",
        },
        adapters: { "fake-cached": fakeAdapterCached },
        observability: { onCost },
      });

      await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });

      expect(onCost).toHaveBeenCalledTimes(1);
      const event = onCost.mock.calls[0]![0] as CostEvent;
      expect(event.cacheReadUsd).toBe(0.0003);
    });
  });

  describe("onTokenUsage", () => {
    it("fires once per successful call with the cacheReadTokens mapped to cachedInputTokens", async () => {
      const onTokenUsage = vi.fn();
      const registry = createRegistryFromEnv({
        env: {
          LLM_PROVIDER_PRIMARY: "fake-cached|model-b|req:5/hour",
          LLM_TASK_ROUTE_TEST: "primary",
        },
        adapters: { "fake-cached": fakeAdapterCached },
        observability: { onTokenUsage },
      });

      await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });

      expect(onTokenUsage).toHaveBeenCalledTimes(1);
      const event = onTokenUsage.mock.calls[0]![0] as TokenUsageEvent;
      expect(event.inputTokens).toBe(1000);
      expect(event.outputTokens).toBe(200);
      expect(event.totalTokens).toBe(1200);
      expect(event.cachedInputTokens).toBe(600);
      expect(event.providerAlias).toBe("primary");
      expect(event.operation).toBe("generateText");
    });

    it("omits optional token fields when the source data has no cache or reasoning info", async () => {
      const onTokenUsage = vi.fn();
      const registry = createRegistryFromEnv({
        env: {
          LLM_PROVIDER_PRIMARY: "fake-plain|model-a|req:5/hour",
          LLM_TASK_ROUTE_TEST: "primary",
        },
        adapters: { "fake-plain": fakeAdapterPlain },
        observability: { onTokenUsage },
      });

      await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });

      const event = onTokenUsage.mock.calls[0]![0] as TokenUsageEvent;
      expect("cachedInputTokens" in event).toBe(false);
      expect("cacheCreationTokens" in event).toBe(false);
      expect("reasoningTokens" in event).toBe(false);
    });
  });

  describe("onFallback", () => {
    it("fires when walkChain advances from primary to backup on a transient error", async () => {
      const onFallback = vi.fn();
      const registry = createRegistryFromEnv({
        env: {
          LLM_PROVIDER_PRIMARY: "fake-transient|model-c|req:5/hour",
          LLM_PROVIDER_BACKUP: "fake-plain|model-a|req:5/hour",
          LLM_TASK_ROUTE_TEST: "primary,backup",
        },
        adapters: {
          "fake-transient": fakeAdapterTransient,
          "fake-plain": fakeAdapterPlain,
        },
        observability: { onFallback },
      });

      const result = await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });

      // backup served the call (transient threw, then we walked).
      expect(result.providerAlias).toBe("backup");
      expect(onFallback).toHaveBeenCalledTimes(1);
      const event = onFallback.mock.calls[0]![0] as FallbackEvent;
      expect(event.fromAlias).toBe("primary");
      expect(event.toAlias).toBe("backup");
      expect(event.cause).toBe("provider-error");
      expect(event.operation).toBe("generateText");
      expect(event.taskType).toBe("test");
    });

    it("does NOT fire when the first provider succeeds", async () => {
      const onFallback = vi.fn();
      const registry = createRegistryFromEnv({
        env: {
          LLM_PROVIDER_PRIMARY: "fake-plain|model-a|req:5/hour",
          LLM_TASK_ROUTE_TEST: "primary",
        },
        adapters: { "fake-plain": fakeAdapterPlain },
        observability: { onFallback },
      });

      await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });

      expect(onFallback).not.toHaveBeenCalled();
    });
  });

  describe("onCacheHit", () => {
    it("fires when cacheReadTokens > 0", async () => {
      const onCacheHit = vi.fn();
      const registry = createRegistryFromEnv({
        env: {
          LLM_PROVIDER_PRIMARY: "fake-cached|model-b|req:5/hour",
          LLM_TASK_ROUTE_TEST: "primary",
        },
        adapters: { "fake-cached": fakeAdapterCached },
        observability: { onCacheHit },
      });

      await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });

      expect(onCacheHit).toHaveBeenCalledTimes(1);
      const event = onCacheHit.mock.calls[0]![0] as CacheHitEvent;
      expect(event.cachedTokens).toBe(600);
      expect(event.inputTokensTotal).toBe(1000);
      expect(event.hitRatio).toBeCloseTo(0.6);
      expect(event.savingsUsd).toBe(0.0003);
      expect(event.providerAlias).toBe("primary");
    });

    it("does NOT fire when no cache tokens are present", async () => {
      const onCacheHit = vi.fn();
      const registry = createRegistryFromEnv({
        env: {
          LLM_PROVIDER_PRIMARY: "fake-plain|model-a|req:5/hour",
          LLM_TASK_ROUTE_TEST: "primary",
        },
        adapters: { "fake-plain": fakeAdapterPlain },
        observability: { onCacheHit },
      });

      await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });

      expect(onCacheHit).not.toHaveBeenCalled();
    });
  });

  describe("hook error swallowing", () => {
    it("throwing in a hook does NOT break the inference call", async () => {
      const onCost = vi.fn(() => {
        throw new Error("intentional");
      });
      const registry = createRegistryFromEnv({
        env: {
          LLM_PROVIDER_PRIMARY: "fake-plain|model-a|req:5/hour",
          LLM_TASK_ROUTE_TEST: "primary",
        },
        adapters: { "fake-plain": fakeAdapterPlain },
        observability: { onCost },
      });

      const result = await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });

      expect(result.text).toBe("out");
      expect(onCost).toHaveBeenCalledTimes(1);
    });

    it("async hooks that reject are swallowed too", async () => {
      const onTokenUsage = vi.fn(() => Promise.reject(new Error("async oops")));
      const registry = createRegistryFromEnv({
        env: {
          LLM_PROVIDER_PRIMARY: "fake-plain|model-a|req:5/hour",
          LLM_TASK_ROUTE_TEST: "primary",
        },
        adapters: { "fake-plain": fakeAdapterPlain },
        observability: { onTokenUsage },
      });

      const result = await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });

      expect(result.text).toBe("out");
    });
  });
});

describe("deriveCacheHit (pure helper)", () => {
  it("returns null when cacheReadTokens is 0 or missing", () => {
    expect(deriveCacheHit({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }, undefined)).toBeNull();
    expect(deriveCacheHit({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0 }, undefined)).toBeNull();
  });

  it("computes ratio when cache tokens are present", () => {
    const result = deriveCacheHit(
      { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 700 },
      undefined,
    );
    expect(result).not.toBeNull();
    expect(result!.cachedTokens).toBe(700);
    expect(result!.inputTokensTotal).toBe(1000);
    expect(result!.hitRatio).toBeCloseTo(0.7);
    expect(result!.savingsUsd).toBeUndefined();
  });

  it("includes savingsUsd when CostUsage has cacheSavingsUSD", () => {
    const result = deriveCacheHit(
      { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 700 },
      { inputUSD: 0.003, outputUSD: 0.0002, totalUSD: 0.0032, cacheSavingsUSD: 0.0014 },
    );
    expect(result!.savingsUsd).toBe(0.0014);
  });
});

describe("emit helpers swallow errors", () => {
  it("emitCost does not throw when the hook throws", () => {
    const onCost = () => {
      throw new Error("boom");
    };
    expect(() =>
      emitCost(onCost, {
        promptUsd: 0,
        completionUsd: 0,
        totalUsd: 0,
        modelId: "m",
        providerAlias: "a",
        operation: "generateText",
      }),
    ).not.toThrow();
  });

  it("emitTokenUsage does not throw when the hook throws", () => {
    const onTokenUsage = () => {
      throw new Error("boom");
    };
    expect(() =>
      emitTokenUsage(onTokenUsage, {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        modelId: "m",
        providerAlias: "a",
        operation: "generateText",
      }),
    ).not.toThrow();
  });

  it("emitFallback does not throw when the hook throws", () => {
    const onFallback = () => {
      throw new Error("boom");
    };
    expect(() =>
      emitFallback(onFallback, {
        fromAlias: "a",
        toAlias: "b",
        cause: "provider-error",
        operation: "generateText",
      }),
    ).not.toThrow();
  });

  it("emitValidationRetry does not throw when the hook throws (alpha.21 type lockdown — emission deferred to alpha.22)", () => {
    const onValidationRetry = () => {
      throw new Error("boom");
    };
    expect(() =>
      emitValidationRetry(onValidationRetry, {
        attempt: 0,
        maxAttempts: 2,
        modelId: "m",
        providerAlias: "a",
        cause: "schema-mismatch",
        operation: "generateStructured",
      }),
    ).not.toThrow();
  });

  it("emitCacheHit does not throw when the hook throws", () => {
    const onCacheHit = () => {
      throw new Error("boom");
    };
    expect(() =>
      emitCacheHit(onCacheHit, {
        cachedTokens: 100,
        inputTokensTotal: 200,
        hitRatio: 0.5,
        modelId: "m",
        providerAlias: "a",
        operation: "generateText",
      }),
    ).not.toThrow();
  });
});

describe("Registry with no observability hooks (backwards-compat)", () => {
  it("works unchanged when no observability hooks are supplied (regression check)", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "fake-plain|model-a|req:5/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "fake-plain": fakeAdapterPlain },
      // no observability field
    });

    const result = await registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] });
    expect(result.providerAlias).toBe("primary");
    expect(result.text).toBe("out");
  });

  it("rejects malformed config the same way regardless of hooks (regression check)", () => {
    expect(() =>
      createRegistryFromEnv({
        env: {
          LLM_PROVIDER_BAD: "no-such-adapter|some-model|req:5/hour",
          LLM_TASK_ROUTE_TEST: "bad",
        },
        adapters: { "fake-plain": fakeAdapterPlain },
        observability: { onCost: vi.fn() },
      }),
    ).toThrow();
  });

  it("exposes the observability bundle as a read-only public field", () => {
    const hooks: ObservabilityHooks = { onCost: vi.fn() };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "fake-plain|model-a|req:5/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "fake-plain": fakeAdapterPlain },
      observability: hooks,
    });
    expect(registry.observability.onCost).toBe(hooks.onCost);
  });

  it("falls back when the chain is exhausted and surfaces NoProvidersAvailableError (regression check)", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "fake-transient|model-c|req:5/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "fake-transient": fakeAdapterTransient },
    });
    await expect(
      registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] }),
    ).rejects.toBeInstanceOf(NoProvidersAvailableError);
  });
});
