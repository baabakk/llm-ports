/**
 * `onComplete` fires once per call, on success and on failure.
 *
 * Alpha.28 item 2, asked for by ADW and SalesCoach, owed since July. The
 * question it answers is "what did this call cost and how many attempts did it
 * take", which previously meant correlating two other hooks with a count the
 * caller kept itself.
 *
 * **The failure case is the one worth protecting.** A completion hook that
 * only fired on success would describe a healthier system than the real one,
 * and reliability is the reason to turn it on.
 */

import { describe, expect, it } from "vitest";
import {
  createRegistryFromEnv,
  wrapProviderError,
  type AdapterRegistration,
  type CompletionEvent,
  type GenerateTextResult,
  type LLMPort,
} from "../src/index.js";

function answering(alias: string): LLMPort {
  return {
    generateText: async () =>
      ({
        text: "ok",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        cost: { inputUSD: 0.00001, outputUSD: 0.000005, totalUSD: 0.000015 },
        modelId: "m",
        providerAlias: alias,
        latencyMs: 2,
      }) as GenerateTextResult,
  } as unknown as LLMPort;
}

function failing(): LLMPort {
  return {
    generateText: async () => {
      throw wrapProviderError("a", Object.assign(new Error("HTTP 503"), { status: 503 }));
    },
  } as unknown as LLMPort;
}

function adapter(name: string, port: LLMPort): AdapterRegistration {
  return { name, pricing: { m: { inputPer1M: 1, outputPer1M: 1 } }, createLLMPort: () => port };
}

const env = {
  LLM_PROVIDER_A: "alpha|m|req:100/hour",
  LLM_PROVIDER_B: "beta|m|req:100/hour",
  LLM_TASK_ROUTE_CHAT: "a,b",
};
const call = { taskType: "chat", messages: [{ role: "user" as const, content: "hi" }] };

describe("onComplete", () => {
  it("fires exactly once for a successful call, with the aggregate", async () => {
    const seen: CompletionEvent[] = [];
    const registry = createRegistryFromEnv({
      env,
      adapters: { alpha: adapter("alpha", answering("a")), beta: adapter("beta", answering("b")) },
      observability: { onComplete: (e) => void seen.push(e) },
    });

    await registry.getPort().generateText(call);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.ok).toBe(true);
    expect(seen[0]!.operation).toBe("generateText");
    expect(seen[0]!.providerAttempts).toBe(1);
    expect(seen[0]!.providerAlias).toBe("a");
    expect(seen[0]!.usage?.totalTokens).toBe(15);
    expect(seen[0]!.totalUsd).toBeCloseTo(0.000015);
    expect(seen[0]!.taskType).toBe("chat");
    expect(seen[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("counts every provider attempted, not just the one that answered", async () => {
    const seen: CompletionEvent[] = [];
    const registry = createRegistryFromEnv({
      env,
      adapters: { alpha: adapter("alpha", failing()), beta: adapter("beta", answering("b")) },
      observability: { onComplete: (e) => void seen.push(e) },
    });

    await registry.getPort().generateText(call);

    expect(seen).toHaveLength(1);
    // Two attempts: the first provider failed and the chain walked. This is
    // the number the ask was actually about.
    expect(seen[0]!.providerAttempts).toBe(2);
    expect(seen[0]!.providerAlias).toBe("b");
    expect(seen[0]!.ok).toBe(true);
  });

  it("fires on failure too, with the error and the attempt count", async () => {
    const seen: CompletionEvent[] = [];
    const registry = createRegistryFromEnv({
      env,
      adapters: { alpha: adapter("alpha", failing()), beta: adapter("beta", failing()) },
      observability: { onComplete: (e) => void seen.push(e) },
    });

    await expect(registry.getPort().generateText(call)).rejects.toThrow();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.ok).toBe(false);
    expect(seen[0]!.providerAttempts).toBe(2);
    expect(seen[0]!.error).toBeInstanceOf(Error);
    // No cost and no usage on a call that produced neither: absent rather
    // than zero, so a spend total cannot be inflated by failures.
    expect(seen[0]!.totalUsd).toBeUndefined();
    expect(seen[0]!.usage).toBeUndefined();
  });

  it("omits cost when the price is unknown, rather than reporting zero", async () => {
    const unpriced: LLMPort = {
      generateText: async () =>
        ({
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          modelId: "m",
          providerAlias: "a",
          latencyMs: 1,
        }) as GenerateTextResult,
    } as unknown as LLMPort;

    const seen: CompletionEvent[] = [];
    const registry = createRegistryFromEnv({
      env,
      adapters: { alpha: adapter("alpha", unpriced), beta: adapter("beta", answering("b")) },
      observability: { onComplete: (e) => void seen.push(e) },
    });

    await registry.getPort().generateText(call);

    expect(seen[0]!.usage?.totalTokens).toBe(2);
    expect(seen[0]!.totalUsd).toBeUndefined();
  });

  it("does not break the call when the hook itself throws", async () => {
    const registry = createRegistryFromEnv({
      env,
      adapters: { alpha: adapter("alpha", answering("a")), beta: adapter("beta", answering("b")) },
      observability: {
        onComplete: () => {
          throw new Error("the consumer's dashboard is down");
        },
      },
    });

    // Observability never breaks inference. That promise is the reason every
    // hook here is fire-and-forget.
    const result = await registry.getPort().generateText(call);
    expect(result.text).toBe("ok");
  });
});
