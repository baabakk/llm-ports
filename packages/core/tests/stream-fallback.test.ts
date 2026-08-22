/**
 * Alpha.33 — streamed methods must fall back.
 *
 * `walkStreamChain` opens a provider's stream inside a `try` and treats a
 * throw as the signal to walk to the next provider. Every adapter
 * implements streaming as an async generator, and calling one returns a
 * generator object **without executing any of its body**, so the request
 * that contacts the provider does not happen until the consumer iterates,
 * long after the walker returned.
 *
 * The result was that `streamText` and `streamStructured` never fell back
 * on any released version. The walker saw a healthy open for a dead
 * provider, recorded the attempt, marked the alias authenticated, and
 * returned; the real failure surfaced during consumer iteration with no
 * chain left to walk.
 *
 * The fix is priming: pull the first event inside the walker's try, where
 * a failure can still be acted on, and replay it to the consumer.
 *
 * **These tests fail against the pre-fix implementation.** That is the
 * point. The reason this survived so long is that the existing streaming
 * tests stub providers as arrays, or as generators that yield before
 * failing, and neither shape reproduces the defect: both run the failing
 * line only after the walker has already returned.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRegistryFromEnv,
  ProviderUnavailableError,
  type AdapterRegistration,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1, outputPer1M: 2 };

function basePort(): LLMPort {
  return {
    async generateText() {
      throw new Error("not used");
    },
    async generateStructured() {
      throw new Error("not used");
    },
    async runAgent() {
      throw new Error("not used");
    },
    streamText: async function* () {
      yield "unused";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

/**
 * A provider that fails ON FIRST ITERATION rather than at call time.
 *
 * This is the shape real adapters have and the shape the old tests never
 * produced. `async *` bodies do not run until `next()`, so the throw below
 * lands after the walker would previously have returned.
 */
function deadOnIteration(): LLMPort {
  return {
    ...basePort(),
    streamText: async function* () {
      throw new ProviderUnavailableError("dead", new Error("provider down"));
    },
    streamStructured: async function* () {
      throw new ProviderUnavailableError("dead", new Error("provider down"));
    },
  };
}

function healthyText(text: string): LLMPort {
  return {
    ...basePort(),
    streamText: async function* () {
      yield text;
    },
  };
}

function healthyStructured(value: unknown): LLMPort {
  return {
    ...basePort(),
    streamStructured: async function* () {
      yield value as never;
    },
  };
}

function adapterFor(name: string, port: LLMPort): AdapterRegistration {
  return { name, pricing: { "model-x": PRICING }, createLLMPort: () => port };
}

const ENV_TWO = {
  LLM_PROVIDER_A: "alpha|model-x|req:100/hour",
  LLM_PROVIDER_B: "beta|model-x|req:100/hour",
  LLM_TASK_ROUTE_CHAT: "a,b",
} as const;

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of stream) out.push(v);
  return out;
}

describe("streamText — chain walk on a provider that fails at first iteration", () => {
  it("walks to the healthy provider instead of surfacing the failure", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", deadOnIteration()),
        beta: adapterFor("beta", healthyText("from b")),
      },
      runtimeFallback: "aggressive",
    });

    expect(await collect(registry.getPort().streamText({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
    }))).toEqual(["from b"]);
  });

  it("walks past two dead providers", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "alpha|model-x|req:100/hour",
        LLM_PROVIDER_B: "beta|model-x|req:100/hour",
        LLM_PROVIDER_C: "gamma|model-x|req:100/hour",
        LLM_TASK_ROUTE_CHAT: "a,b,c",
      },
      adapters: {
        alpha: adapterFor("alpha", deadOnIteration()),
        beta: adapterFor("beta", deadOnIteration()),
        gamma: adapterFor("gamma", healthyText("from c")),
      },
      runtimeFallback: "aggressive",
    });

    expect(await collect(registry.getPort().streamText({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
    }))).toEqual(["from c"]);
  });

  it("does NOT mark a provider authenticated when its stream never opened", async () => {
    // Priming moved the first real provider contact inside the walker, so
    // a provider that fails there must not be recorded as having
    // authenticated. Getting this wrong would corrupt the walk-versus-abort
    // decision for every later call on that alias.
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", deadOnIteration()),
        beta: adapterFor("beta", healthyText("from b")),
      },
      runtimeFallback: "aggressive",
    });

    await collect(registry.getPort().streamText({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(registry.hasEverAuthenticated("a")).toBe(false);
    expect(registry.hasEverAuthenticated("b")).toBe(true);
  });

  it("still surfaces the error when every provider is dead", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", deadOnIteration()),
        beta: adapterFor("beta", deadOnIteration()),
      },
      runtimeFallback: "aggressive",
    });

    await expect(
      collect(registry.getPort().streamText({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      })),
    ).rejects.toThrow();
  });
});

describe("streamStructured — same walk", () => {
  it("walks to the healthy provider", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", deadOnIteration()),
        beta: adapterFor("beta", healthyStructured({ ok: true })),
      },
      runtimeFallback: "aggressive",
    });

    const out = await collect(
      registry.getPort().streamStructured<{ ok: boolean }>({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
        schema: z.object({ ok: z.boolean() }),
        schemaName: "t",
      }),
    );
    expect(out).toEqual([{ ok: true }]);
  });
});

describe("priming does not change the happy path", () => {
  it("delivers every chunk in order, including the primed first one", async () => {
    // The buffered first event must be replayed, not dropped. A fix that
    // swallowed it would pass every fallback test above and silently lose
    // the opening token of every stream.
    const registry = createRegistryFromEnv({
      env: { LLM_PROVIDER_A: "alpha|model-x|req:100/hour", LLM_TASK_ROUTE_CHAT: "a" },
      adapters: {
        alpha: adapterFor("alpha", {
          ...basePort(),
          streamText: async function* () {
            yield "one";
            yield "two";
            yield "three";
          },
        }),
      },
    });

    expect(await collect(registry.getPort().streamText({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
    }))).toEqual(["one", "two", "three"]);
  });

  it("handles an empty stream without hanging or inventing a value", async () => {
    const registry = createRegistryFromEnv({
      env: { LLM_PROVIDER_A: "alpha|model-x|req:100/hour", LLM_TASK_ROUTE_CHAT: "a" },
      adapters: {
        alpha: adapterFor("alpha", {
          ...basePort(),
          streamText: async function* () {
            // yields nothing
          },
        }),
      },
    });

    expect(await collect(registry.getPort().streamText({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
    }))).toEqual([]);
  });

  it("propagates a mid-stream failure after the first chunk", async () => {
    // Priming only covers the OPENING failure. A provider that dies after
    // yielding has already been committed to, and the error must reach the
    // consumer rather than being swallowed by the replay wrapper.
    const registry = createRegistryFromEnv({
      env: { LLM_PROVIDER_A: "alpha|model-x|req:100/hour", LLM_TASK_ROUTE_CHAT: "a" },
      adapters: {
        alpha: adapterFor("alpha", {
          ...basePort(),
          streamText: async function* () {
            yield "partial";
            throw new Error("connection reset");
          },
        }),
      },
    });

    await expect(
      collect(registry.getPort().streamText({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      })),
    ).rejects.toThrow(/connection reset/);
  });
});
