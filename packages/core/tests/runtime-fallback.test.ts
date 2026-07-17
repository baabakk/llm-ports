/**
 * Runtime fallback — the registry walks the task's chain on errors matching
 * `shouldFallback`, retrying on the next viable provider.
 *
 * Closes the v0.1 → v0.2 surface gap noted in the v0.1 status doc:
 * "Registry walks the chain on budget gating but does not retry the next
 * provider on runtime errors." Shipped in 0.1.0-alpha.7.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Registry } from "../src/registry/registry.js";
import {
  NoProvidersAvailableError,
  ProviderUnavailableError,
  EmptyResponseError,
} from "../src/errors.js";
import type {
  AgentResult,
  GenerateStructuredResult,
  GenerateTextResult,
  LLMPort,
} from "../src/ports/llm-port.js";
import type { AdapterRegistration } from "../src/registry/registry.js";

// ─── Test fixtures ──────────────────────────────────────────────────

function makeMockPort(behavior: {
  textOk?: string;
  throwTextOn?: () => Error;
  structuredOk?: unknown;
  throwStructuredOn?: () => Error;
}): LLMPort {
  const baseUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const baseCost = { inputUSD: 0, outputUSD: 0, totalUSD: 0.001 };
  const partial = {
    usage: baseUsage,
    cost: baseCost,
    modelId: "m",
    providerAlias: "a",
    latencyMs: 1,
  };
  return {
    async generateText(): Promise<GenerateTextResult> {
      if (behavior.throwTextOn) throw behavior.throwTextOn();
      return { text: behavior.textOk ?? "ok", ...partial };
    },
    async generateStructured<T>(): Promise<GenerateStructuredResult<T>> {
      if (behavior.throwStructuredOn) throw behavior.throwStructuredOn();
      return {
        data: (behavior.structuredOk ?? {}) as T,
        ...partial,
        validationAttempts: 1,
      };
    },
    async *streamText() {
      if (behavior.throwTextOn) throw behavior.throwTextOn();
      yield behavior.textOk ?? "ok";
    },
    async *streamStructured() {
      if (behavior.throwStructuredOn) throw behavior.throwStructuredOn();
      yield {};
    },
    async runAgent(): Promise<AgentResult> {
      if (behavior.throwTextOn) throw behavior.throwTextOn();
      return {
        text: behavior.textOk ?? "ok",
        messages: [],
        toolCalls: [],
        stepsTaken: 1,
        terminationReason: "completed",
        ...partial,
      };
    },
  };
}

function makeAdapter(name: string, port: LLMPort): AdapterRegistration {
  return {
    name,
    pricing: { test: { inputPer1M: 1, outputPer1M: 1 } },
    createLLMPort: () => port,
  };
}

function envFor(taskRoute: string, providers: string[] = ["primary", "fallback"]): Record<string, string> {
  const env: Record<string, string> = {
    LLM_TASK_ROUTE_DEFAULT: taskRoute,
  };
  for (const name of providers) {
    const envKey = `LLM_PROVIDER_${name.toUpperCase().replace(/-/g, "_")}`;
    env[envKey] = `${name}|test|cost:1/day`;
  }
  return env;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Registry runtime fallback (default behavior)", () => {
  it("walks to the next provider when the first throws ProviderUnavailableError", async () => {
    const primaryPort = makeMockPort({
      throwTextOn: () =>
        new ProviderUnavailableError("primary", new Error("503 Service Unavailable")),
    });
    const fallbackPort = makeMockPort({ textOk: "from-fallback" });
    const registry = new Registry({
      env: envFor("primary,fallback"),
      adapters: {
        primary: makeAdapter("primary", primaryPort),
        fallback: makeAdapter("fallback", fallbackPort),
      },
    });
    const result = await registry.getPort().generateText({
      taskType: "default",
      messages: [{ role: "user" as const, content: "hi" }],
    });
    expect(result.text).toBe("from-fallback");
  });

  it("walks past multiple failing providers until one succeeds", async () => {
    const primary = makeMockPort({
      throwTextOn: () => new ProviderUnavailableError("primary", new Error("503")),
    });
    const middle = makeMockPort({
      throwTextOn: () => new ProviderUnavailableError("fallback", new Error("503")),
    });
    const last = makeMockPort({ textOk: "from-last" });
    const registry = new Registry({
      env: envFor("primary,fallback,last-resort", ["primary", "fallback", "last-resort"]),
      adapters: {
        primary: makeAdapter("primary", primary),
        fallback: makeAdapter("fallback", middle),
        "last-resort": makeAdapter("last-resort", last),
      },
    });
    const result = await registry.getPort().generateText({
      taskType: "default",
      messages: [{ role: "user" as const, content: "hi" }],
    });
    expect(result.text).toBe("from-last");
  });

  it("throws NoProvidersAvailableError when every provider in the chain fails", async () => {
    const failing = () =>
      makeMockPort({
        throwTextOn: () => new ProviderUnavailableError("x", new Error("503")),
      });
    const registry = new Registry({
      env: envFor("primary,fallback"),
      adapters: {
        primary: makeAdapter("primary", failing()),
        fallback: makeAdapter("fallback", failing()),
      },
    });
    await expect(
      registry.getPort().generateText({ taskType: "default", messages: [{ role: "user" as const, content: "hi" }] }),
    ).rejects.toThrow(NoProvidersAvailableError);
  });

  it("does NOT walk on errors that are not ProviderUnavailableError", async () => {
    const primary = makeMockPort({
      throwTextOn: () => new TypeError("caller bug — passed bad input"),
    });
    const fallback = makeMockPort({ textOk: "should-not-reach" });
    const registry = new Registry({
      env: envFor("primary,fallback"),
      adapters: {
        primary: makeAdapter("primary", primary),
        fallback: makeAdapter("fallback", fallback),
      },
    });
    await expect(
      registry.getPort().generateText({ taskType: "default", messages: [{ role: "user" as const, content: "hi" }] }),
    ).rejects.toThrow(TypeError);
  });

  it("records cost ONLY on the successful provider", async () => {
    const primary = makeMockPort({
      throwTextOn: () => new ProviderUnavailableError("primary", new Error("503")),
    });
    const fallback = makeMockPort({ textOk: "ok" });
    const costSpy = vi.fn();
    const registry = new Registry({
      env: envFor("primary,fallback"),
      adapters: {
        primary: makeAdapter("primary", primary),
        fallback: makeAdapter("fallback", fallback),
      },
      cost: {
        recordCost: async (alias, usd) => costSpy(alias, usd),
        check: async () => ({ allowed: true }),
      },
    });
    await registry.getPort().generateText({ taskType: "default", messages: [{ role: "user" as const, content: "hi" }] });
    expect(costSpy).toHaveBeenCalledTimes(1);
    expect(costSpy).toHaveBeenCalledWith("fallback", 0.001);
  });
});

describe("Registry runtime fallback (configured)", () => {
  it("runtimeFallback: 'none' preserves v0.1 behavior — no walking on runtime errors", async () => {
    const primary = makeMockPort({
      throwTextOn: () => new ProviderUnavailableError("primary", new Error("503")),
    });
    const fallback = makeMockPort({ textOk: "should-not-reach" });
    const registry = new Registry({
      runtimeFallback: "none",
      env: envFor("primary,fallback"),
      adapters: {
        primary: makeAdapter("primary", primary),
        fallback: makeAdapter("fallback", fallback),
      },
    });
    await expect(
      registry.getPort().generateText({ taskType: "default", messages: [{ role: "user" as const, content: "hi" }] }),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it("custom shouldFallback can opt in to additional error classes (e.g. EmptyResponseError)", async () => {
    const primary = makeMockPort({
      throwStructuredOn: () => new EmptyResponseError("primary", "test-model", "hint"),
    });
    const fallback = makeMockPort({ structuredOk: { ok: true } });
    const registry = new Registry({
      runtimeFallback: {
        shouldFallback: (err) =>
          err instanceof ProviderUnavailableError || err instanceof EmptyResponseError,
      },
      env: envFor("primary,fallback"),
      adapters: {
        primary: makeAdapter("primary", primary),
        fallback: makeAdapter("fallback", fallback),
      },
    });
    const result = await registry.getPort().generateStructured({
      taskType: "default",
      messages: [{ role: "user" as const, content: "hi" }],
      schema: z.object({ ok: z.boolean() }),
      schemaName: "Test",
    });
    expect(result.data).toEqual({ ok: true });
  });
});

describe("Registry runtime fallback: streaming methods", () => {
  // Streaming fallback is narrower in v0.7: it catches failures at the
  // async stream-creation step (the SDK call BEFORE the first yield) but
  // not failures during iteration. Switching providers mid-stream would
  // emit a confusing mix; that's v0.2 scope. The test below verifies the
  // non-mid-stream semantics.
  it("yields from the fallback when the primary's stream-creation throws synchronously", async () => {
    // Build a port whose streamText function throws SYNCHRONOUSLY (not via
    // yield) — this simulates an adapter that does `await client.x()` before
    // yielding any chunks, and that await rejects.
    const primaryPort: LLMPort = {
      ...makeMockPort({}),
      // eslint-disable-next-line @typescript-eslint/require-await
      streamText: () => {
        throw new ProviderUnavailableError("primary", new Error("503"));
      },
    };
    const fallback = makeMockPort({ textOk: "from-fallback" });
    const registry = new Registry({
      env: envFor("primary,fallback"),
      adapters: {
        primary: makeAdapter("primary", primaryPort),
        fallback: makeAdapter("fallback", fallback),
      },
    });
    const chunks: string[] = [];
    for await (const chunk of registry.getPort().streamText({
      taskType: "default",
      messages: [{ role: "user" as const, content: "hi" }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe("from-fallback");
  });
});
