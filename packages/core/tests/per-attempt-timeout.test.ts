/**
 * Per-attempt timeout (alpha.23+).
 *
 * `RegistryOptions.perAttemptTimeoutMs` wraps every provider attempt in
 * `walkChain` with an AbortController + timer. On timeout, the abort
 * propagates to the adapter; the adapter throws ProviderUnavailableError;
 * the Registry's shouldFallback catches it and walks to the next provider
 * with a fresh timer.
 *
 * Empirical motivation: ADW production wedge 2026-06-19T15:40 UTC —
 * mimo-parasail hit reasoning-starvation, retry expanded budget, model
 * grinded silently for 3+ minutes with no timeout/failover. The
 * AbortSignal infrastructure was already in place; this helper makes it
 * ergonomic.
 *
 * Per-attempt (not chain-wide): each provider gets its own budget. A 30s
 * timeout against a 3-provider chain caps total wall-clock at ~90s, but
 * any single provider can't exceed 30s.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createRegistryFromEnv,
  ProviderUnavailableError,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1, outputPer1M: 1 };

/** Port that resolves immediately. */
function fastPort(modelId: string, alias: string): LLMPort {
  return {
    async generateText(): Promise<GenerateTextResult> {
      return {
        text: `fast`,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        cost: { inputUSD: 0.0001, outputUSD: 0.00005, totalUSD: 0.00015 },
        modelId,
        providerAlias: alias,
        latencyMs: 5,
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

/** Port that hangs until aborted. */
function slowPort(modelId: string, alias: string): LLMPort {
  return {
    async generateText(opts: { signal?: AbortSignal } & Record<string, unknown>): Promise<GenerateTextResult> {
      return new Promise((_resolve, reject) => {
        // Honor abort by rejecting with a ProviderUnavailableError shape (the
        // adapter would normally wrap APIUserAbortError into this).
        if (opts.signal) {
          const onAbort = () => {
            reject(new ProviderUnavailableError(alias, modelId, new Error("Request was aborted")));
          };
          if (opts.signal.aborted) {
            onAbort();
            return;
          }
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
        // Never resolve. The test relies on the timeout to abort.
      });
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

const fastAdapter: AdapterRegistration = {
  name: "fast",
  pricing: { "fast-model": PRICING },
  createLLMPort: (modelId, alias) => fastPort(modelId, alias),
};

const slowAdapter: AdapterRegistration = {
  name: "slow",
  pricing: { "slow-model": PRICING },
  createLLMPort: (modelId, alias) => slowPort(modelId, alias),
};

describe("Per-attempt timeout (alpha.23+)", () => {
  it("aborts a hanging provider after timeoutMs and falls back to the next", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_SLOW: "slow|slow-model|req:5/hour",
        LLM_PROVIDER_FAST: "fast|fast-model|req:5/hour",
        LLM_TASK_ROUTE_TEST: "slow,fast",
      },
      adapters: { slow: slowAdapter, fast: fastAdapter },
      perAttemptTimeoutMs: 50,
    });

    const start = Date.now();
    const result = await registry.getPort().generateText({ taskType: "test", prompt: "hi" });
    const elapsed = Date.now() - start;

    expect(result.providerAlias).toBe("fast");
    expect(result.text).toBe("fast");
    // Total elapsed: ~50ms slow timeout + a few ms for fast. Well under 200ms.
    expect(elapsed).toBeLessThan(500);
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("does NOT abort a provider that resolves within the timeout (regression check)", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "fast|fast-model|req:5/hour",
        LLM_TASK_ROUTE_TEST: "fast",
      },
      adapters: { fast: fastAdapter },
      perAttemptTimeoutMs: 1000,
    });

    const result = await registry.getPort().generateText({ taskType: "test", prompt: "hi" });
    expect(result.text).toBe("fast");
    expect(result.providerAlias).toBe("fast");
  });

  it("works without perAttemptTimeoutMs (regression check: backwards compat)", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "fast|fast-model|req:5/hour",
        LLM_TASK_ROUTE_TEST: "fast",
      },
      adapters: { fast: fastAdapter },
      // perAttemptTimeoutMs intentionally omitted
    });

    const result = await registry.getPort().generateText({ taskType: "test", prompt: "hi" });
    expect(result.text).toBe("fast");
  });

  it("respects user-supplied signal when it fires earlier than the timeout", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_SLOW: "slow|slow-model|req:5/hour",
        LLM_TASK_ROUTE_TEST: "slow",
      },
      adapters: { slow: slowAdapter },
      perAttemptTimeoutMs: 10000, // 10s — way more than the test will wait
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await expect(
      registry.getPort().generateText({
        taskType: "test",
        prompt: "hi",
        signal: controller.signal,
      }),
    ).rejects.toThrow(); // The slow provider aborts and the chain has nothing else.
  });

  it("per-attempt is NOT chain-wide — each provider gets a fresh timer", async () => {
    // Three slow providers + one fast. With perAttemptTimeoutMs=50, each
    // slow provider takes 50ms before fallback. Total ~150ms + a few ms for
    // the fast resolve. Crucially: if the timeout were chain-wide, the
    // 50ms cap would fire before the second slow provider even started.
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_SLOW1: "slow|slow-model|req:5/hour",
        LLM_PROVIDER_SLOW2: "slow|slow-model|req:5/hour",
        LLM_PROVIDER_SLOW3: "slow|slow-model|req:5/hour",
        LLM_PROVIDER_FAST: "fast|fast-model|req:5/hour",
        LLM_TASK_ROUTE_TEST: "slow1,slow2,slow3,fast",
      },
      adapters: { slow: slowAdapter, fast: fastAdapter },
      perAttemptTimeoutMs: 50,
    });

    const start = Date.now();
    const result = await registry.getPort().generateText({ taskType: "test", prompt: "hi" });
    const elapsed = Date.now() - start;

    expect(result.providerAlias).toBe("fast");
    // ~3 × 50ms + fast = ~150-200ms. NOT < 100ms (which would mean chain-wide).
    // And NOT > 800ms (which would mean no timeout, hangs indefinitely).
    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(elapsed).toBeLessThan(800);
  });

  it("emits onFallback once per chain advancement (regression check with timeout)", async () => {
    const onFallback = vi.fn();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_SLOW: "slow|slow-model|req:5/hour",
        LLM_PROVIDER_FAST: "fast|fast-model|req:5/hour",
        LLM_TASK_ROUTE_TEST: "slow,fast",
      },
      adapters: { slow: slowAdapter, fast: fastAdapter },
      perAttemptTimeoutMs: 50,
      observability: { onFallback },
    });

    await registry.getPort().generateText({ taskType: "test", prompt: "hi" });

    expect(onFallback).toHaveBeenCalledTimes(1);
    const event = onFallback.mock.calls[0]![0] as { fromAlias: string; toAlias: string; cause: string };
    expect(event.fromAlias).toBe("slow");
    expect(event.toAlias).toBe("fast");
    expect(event.cause).toBe("provider-error");
  });
});

describe("Registry.perAttemptTimeoutMs public field", () => {
  it("is exposed as a read-only field on the Registry", () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "fast|fast-model|req:5/hour",
        LLM_TASK_ROUTE_TEST: "fast",
      },
      adapters: { fast: fastAdapter },
      perAttemptTimeoutMs: 12345,
    });
    expect(registry.perAttemptTimeoutMs).toBe(12345);
  });

  it("is undefined when not set", () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "fast|fast-model|req:5/hour",
        LLM_TASK_ROUTE_TEST: "fast",
      },
      adapters: { fast: fastAdapter },
    });
    expect(registry.perAttemptTimeoutMs).toBeUndefined();
  });
});
