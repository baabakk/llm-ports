/**
 * `generateChat` routes like every other call, and skips providers that
 * cannot serve it.
 *
 * The method is optional on the port, which creates a failure mode the other
 * methods do not have: a chain can name a provider whose adapter does not
 * implement it. Attempting that provider would fail with a missing-function
 * error from deep inside the call, naming nothing useful. The registry
 * therefore filters the chain first and, when nothing survives, says so by
 * alias.
 *
 * Alpha.35, from `TD-LLMPORTS-NO-NONSTREAMING-CHAT-WITH-TOOLS`.
 */

import { describe, expect, it } from "vitest";
import {
  createRegistryFromEnv,
  NoProvidersAvailableError,
  wrapProviderError,
  type AdapterRegistration,
  type ChatResult,
  type LLMPort,
} from "../src/index.js";

function chatResult(alias: string): ChatResult {
  return {
    text: "",
    toolCalls: [{ toolCallId: "c1", toolName: "get_weather", args: { city: "Lisbon" }, rawArguments: '{"city":"Lisbon"}' }],
    stopReason: "tool_calls",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    // A real adapter computes cost from its own pricing table, so the stub
    // does too: the registry passes it through rather than producing it.
    cost: { inputUSD: 0.00001, outputUSD: 0.000004, totalUSD: 0.000014 },
    modelId: "m",
    providerAlias: alias,
    latencyMs: 1,
  };
}

/** An adapter that serves generateChat. */
function chatCapable(alias: string, behaviour?: () => Promise<ChatResult>): AdapterRegistration {
  return {
    name: alias,
    pricing: { m: { inputPer1M: 1, outputPer1M: 1 } },
    createLLMPort: (_modelId: string, resolvedAlias: string) =>
      ({
        generateChat: behaviour ?? (async () => chatResult(resolvedAlias)),
      }) as unknown as LLMPort,
  };
}

/** An adapter that does not implement the optional method. */
function chatIncapable(alias: string): AdapterRegistration {
  return {
    name: alias,
    pricing: { m: { inputPer1M: 1, outputPer1M: 1 } },
    createLLMPort: () => ({ generateText: async () => ({}) }) as unknown as LLMPort,
  };
}

const env = {
  LLM_PROVIDER_A: "alpha|m|req:100/hour",
  LLM_PROVIDER_B: "beta|m|req:100/hour",
  LLM_TASK_ROUTE_CHAT: "a,b",
};
const call = { taskType: "chat", messages: [{ role: "user" as const, content: "weather?" }] };

describe("generateChat through the registry", () => {
  it("routes to a capable provider and returns its result", async () => {
    const registry = createRegistryFromEnv({
      env,
      adapters: { alpha: chatCapable("alpha"), beta: chatCapable("beta") },
    });

    const result = await registry.getPort().generateChat!(call);

    expect(result.providerAlias).toBe("a");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.stopReason).toBe("tool_calls");
    // The adapter computes cost; the registry passes it through and records it
    // against the provider's running total, as for every other method.
    expect(result.cost?.totalUSD).toBeGreaterThan(0);
  });

  it("skips a provider whose adapter does not implement it", async () => {
    // The first provider in the chain cannot serve this method. It must be
    // stepped over rather than attempted, because attempting it fails with a
    // missing-function error that names nothing a caller can act on.
    const registry = createRegistryFromEnv({
      env,
      adapters: { alpha: chatIncapable("alpha"), beta: chatCapable("beta") },
    });

    const result = await registry.getPort().generateChat!(call);

    expect(result.providerAlias).toBe("b");
  });

  it("says which providers could not serve it when none can", async () => {
    const registry = createRegistryFromEnv({
      env,
      adapters: { alpha: chatIncapable("alpha"), beta: chatIncapable("beta") },
    });

    const error = await registry
      .getPort()
      .generateChat!(call)
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(NoProvidersAvailableError);
    const reasons = (error as NoProvidersAvailableError).reasons;
    // Both aliases are named, each with the reason, rather than one opaque
    // failure from whichever was tried first.
    expect(Object.keys(reasons).sort()).toEqual(["a", "b"]);
    expect(reasons.a).toContain("generateChat");
  });

  it("falls over to the next provider when a capable one fails", async () => {
    const registry = createRegistryFromEnv({
      env,
      adapters: {
        alpha: chatCapable("alpha", async () => {
          // What an adapter actually throws for a provider outage. A bare
          // Error would not walk, and rightly so.
          throw wrapProviderError("a", Object.assign(new Error("HTTP 503"), { status: 503 }));
        }),
        beta: chatCapable("beta"),
      },
    });

    const result = await registry.getPort().generateChat!(call);
    expect(result.providerAlias).toBe("b");
  });

  it("honours forceProviderAlias", async () => {
    const registry = createRegistryFromEnv({
      env,
      adapters: { alpha: chatCapable("alpha"), beta: chatCapable("beta") },
    });
    const result = await registry.getPort().generateChat!({ ...call, forceProviderAlias: "b" });
    expect(result.providerAlias).toBe("b");
  });
});
