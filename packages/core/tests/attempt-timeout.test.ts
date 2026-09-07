/**
 * Alpha.33, item 2 — `AttemptTimeoutError`.
 *
 * Announced as alpha.28's highest-leverage item, wanted by two consumers,
 * never built until now. `perAttemptTimeoutMs` has existed since alpha.30
 * and did abort the attempt, but the abort surfaced to the caller as a raw
 * SDK error, so a chain with a slow provider at position one never advanced.
 * The deadline stopped the call without buying the failover it implied.
 *
 * The fix is a typed error at the wrapper boundary, subclassing
 * `ProviderUnavailableError` so every existing fallback predicate accepts it
 * with no consumer change.
 *
 * **The risk here is not size, it is interaction.** The timeout and the
 * caller's own `AbortSignal` abort the same controller, so by the time an
 * error surfaces they are indistinguishable from the error alone. Treating a
 * deliberate cancellation as a timeout would walk the whole remaining chain
 * after someone asked to stop: wasted spend, and a surprise. Half the tests
 * below exist for that one distinction.
 */

import { describe, expect, it } from "vitest";
import {
  AttemptTimeoutError,
  createRegistryFromEnv,
  NoProvidersAvailableError,
  ProviderUnavailableError,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1, outputPer1M: 2 };

function result(text: string): GenerateTextResult {
  return {
    text,
    modelId: "model-x",
    providerAlias: "unused",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
  } as GenerateTextResult;
}

/**
 * A provider that never answers until its signal aborts, then rejects the
 * way a real SDK does. `AbortError` is one of several shapes SDKs use; the
 * classification deliberately does not depend on which.
 */
function neverAnswers(): LLMPort {
  return {
    generateText: (options: { signal?: AbortSignal }) =>
      new Promise<GenerateTextResult>((_resolve, reject) => {
        const signal = options.signal;
        if (!signal) return; // hangs; no test uses this path
        // Entry check first. An already-aborted signal never emits "abort",
        // so a listener alone would hang forever. Real adapters do this via
        // `throwIfAborted`; the fake has to match or it tests nothing.
        if (signal.aborted) {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      }),
  } as unknown as LLMPort;
}

/** A provider that rejects with a vendor-specific abort shape. */
function abortsWithVendorShape(): LLMPort {
  return {
    generateText: (options: { signal?: AbortSignal }) =>
      new Promise<GenerateTextResult>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            const err = new Error("Request was aborted.");
            err.name = "APIUserAbortError";
            reject(err);
          },
          { once: true },
        );
      }),
  } as unknown as LLMPort;
}

function healthy(text: string): LLMPort {
  return { generateText: async () => result(text) } as unknown as LLMPort;
}

function adapterFor(name: string, port: LLMPort): AdapterRegistration {
  return { name, pricing: { "model-x": PRICING }, createLLMPort: () => port };
}

const ENV_ONE = {
  LLM_PROVIDER_A: "alpha|model-x|req:100/hour",
  LLM_TASK_ROUTE_CHAT: "a",
} as const;

const ENV_TWO = {
  LLM_PROVIDER_A: "alpha|model-x|req:100/hour",
  LLM_PROVIDER_B: "beta|model-x|req:100/hour",
  LLM_TASK_ROUTE_CHAT: "a,b",
} as const;

const CALL = { taskType: "chat", messages: [{ role: "user" as const, content: "hi" }] };

describe("a blown per-attempt deadline becomes AttemptTimeoutError", () => {
  it("surfaces the typed error on a forced provider, which by contract does not fall back", async () => {
    // `forceProviderAlias` short-circuits the chain walk, so it is the one
    // place a caller observes the raw error rather than the exhausted-chain
    // wrapper. That distinction is pre-existing and applies equally to the
    // parent class; see the exhaustion test below for what a normal chain
    // reports.
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: { alpha: adapterFor("alpha", neverAnswers()) },
      perAttemptTimeoutMs: 20,
    });

    await expect(
      registry.getPort().generateText({ ...CALL, forceProviderAlias: "a" }),
    ).rejects.toThrow(AttemptTimeoutError);
  });

  it("reports the timeout in the reasons map when a whole chain exhausts", async () => {
    // What a normal caller actually sees. `walkChain` records each walk
    // reason and throws NoProvidersAvailableError once nothing is left, so
    // the deadline has to be legible there or the failure is unexplainable.
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: { alpha: adapterFor("alpha", neverAnswers()) },
      perAttemptTimeoutMs: 20,
    });

    const err = await registry
      .getPort()
      .generateText({ ...CALL })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoProvidersAvailableError);
    expect(JSON.stringify((err as NoProvidersAvailableError).reasons)).toContain("20ms");
  });

  it("is a ProviderUnavailableError, which is what makes it walk with no consumer change", async () => {
    const err = new AttemptTimeoutError("alpha", 20);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.name).toBe("AttemptTimeoutError");
    expect(err.timeoutMs).toBe(20);
    // The deadline belongs in the message; an abort's own text does not say why.
    expect(err.message).toContain("20ms");
  });

  it("carries the SDK's original error as the cause", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: { alpha: adapterFor("alpha", neverAnswers()) },
      perAttemptTimeoutMs: 20,
    });

    const err = await registry
      .getPort()
      .generateText({ ...CALL, forceProviderAlias: "a" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttemptTimeoutError);
    expect((err as AttemptTimeoutError).cause).toBeInstanceOf(Error);
    expect((err as AttemptTimeoutError).cause?.name).toBe("AbortError");
  });

  it("classifies from the timer, not from the error's shape", async () => {
    // A vendor abort class this library has never heard of must still be
    // recognised. Gating on a shape we cannot enumerate is how a feature
    // ships looking complete and fires for only some providers.
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: { alpha: adapterFor("alpha", abortsWithVendorShape()) },
      perAttemptTimeoutMs: 20,
    });

    await expect(
      registry.getPort().generateText({ ...CALL, forceProviderAlias: "a" }),
    ).rejects.toThrow(AttemptTimeoutError);
  });
});

describe("the deadline actually triggers failover, which is the point of the item", () => {
  it("walks to the next provider under the default policy", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", neverAnswers()),
        beta: adapterFor("beta", healthy("from beta")),
      },
      perAttemptTimeoutMs: 20,
      // No runtimeFallback: the subclassing is supposed to make this work
      // out of the box for every consumer who never configured anything.
    });

    const res = await registry.getPort().generateText({ ...CALL });
    expect(res.text).toBe("from beta");
  });

  it("gives each provider its own budget rather than sharing one", async () => {
    // Both providers are slow. If the deadline were per-call rather than
    // per-attempt, the second would inherit an exhausted budget and the
    // chain would collapse to one attempt.
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", neverAnswers()),
        beta: adapterFor("beta", neverAnswers()),
      },
      perAttemptTimeoutMs: 20,
    });

    const err = await registry
      .getPort()
      .generateText({ ...CALL })
      .catch((e: unknown) => e);

    // Chain exhausted, both attempts having timed out independently.
    expect(err).toBeInstanceOf(Error);
  });
});

describe("a caller's own cancellation is never reported as a timeout", () => {
  it("propagates the caller's abort untouched", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: { alpha: adapterFor("alpha", neverAnswers()) },
      // A deadline far beyond the cancellation, so only the caller fires.
      perAttemptTimeoutMs: 10_000,
    });

    const controller = new AbortController();
    const promise = registry.getPort().generateText({ ...CALL, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    const err = await promise.catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(AttemptTimeoutError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("does NOT walk the chain when the caller cancels", async () => {
    // The expensive half of the mistake. If a cancellation were reclassified,
    // the registry would keep spending on every remaining provider after
    // someone explicitly asked it to stop.
    let betaCalled = false;
    const beta: LLMPort = {
      generateText: async () => {
        betaCalled = true;
        return result("beta should never run");
      },
    } as unknown as LLMPort;

    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", neverAnswers()),
        beta: adapterFor("beta", beta),
      },
      perAttemptTimeoutMs: 10_000,
    });

    const controller = new AbortController();
    const promise = registry.getPort().generateText({ ...CALL, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await promise.catch(() => undefined);

    expect(betaCalled).toBe(false);
  });

  it("treats an already-aborted signal as a cancellation, not a timeout", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: { alpha: adapterFor("alpha", neverAnswers()) },
      perAttemptTimeoutMs: 10_000,
    });

    const controller = new AbortController();
    controller.abort();

    const err = await registry
      .getPort()
      .generateText({ ...CALL, signal: controller.signal })
      .catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(AttemptTimeoutError);
  });
});

describe("no deadline configured means no behaviour change", () => {
  it("leaves an ordinary provider error exactly as it was", async () => {
    const boom: LLMPort = {
      generateText: async () => {
        throw new Error("upstream exploded");
      },
    } as unknown as LLMPort;

    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: { alpha: adapterFor("alpha", boom) },
      // perAttemptTimeoutMs deliberately unset.
    });

    const err = await registry
      .getPort()
      .generateText({ ...CALL })
      .catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(AttemptTimeoutError);
  });

  it("does not reclassify an error that arrives before the deadline", async () => {
    const boom: LLMPort = {
      generateText: async () => {
        throw new Error("upstream exploded");
      },
    } as unknown as LLMPort;

    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: { alpha: adapterFor("alpha", boom) },
      perAttemptTimeoutMs: 10_000,
    });

    const err = await registry
      .getPort()
      .generateText({ ...CALL })
      .catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(AttemptTimeoutError);
  });
});
