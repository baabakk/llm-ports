/**
 * Alpha.30 — Auth track §2.1.1 (Registry.hasEverAuthenticated) +
 * §2.1.2 (ctx-aware defaultShouldFallback / aggressiveShouldFallback).
 *
 * Verifies the mechanism SalesCoach's TD-LLM-AUTH-ERROR-KILLS-THE-WHOLE-CHAIN
 * called out: a first-time-failed AuthenticationError now walks the chain,
 * while a mid-flight auth failure (on a provider that previously
 * authenticated in the same process) keeps its abort behavior.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  AuthenticationError,
  aggressiveShouldFallback,
  createRegistryFromEnv,
  defaultShouldFallback,
  ProviderUnavailableError,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
  type ShouldFallbackContext,
} from "../src/index.js";

const HAIKU_PRICING: ModelPricing = { inputPer1M: 0.8, outputPer1M: 4.0 };
const GPT_PRICING: ModelPricing = { inputPer1M: 2.5, outputPer1M: 10 };

// ─── Pure-function policy tests (no Registry needed) ────────────────

describe("defaultShouldFallback — ctx-aware AuthenticationError semantics", () => {
  const err = new AuthenticationError("openai", new Error("Incorrect API key"));

  it("returns false when ctx is undefined (backwards-compat abort behavior)", () => {
    expect(defaultShouldFallback(err)).toBe(false);
  });

  it("returns true when ctx says the provider has never authenticated (walk)", () => {
    const ctx: ShouldFallbackContext = { providerAlias: "openai", hasEverAuthenticated: false };
    expect(defaultShouldFallback(err, ctx)).toBe(true);
  });

  it("returns false when ctx says the provider HAS authenticated (mid-flight — abort)", () => {
    const ctx: ShouldFallbackContext = { providerAlias: "openai", hasEverAuthenticated: true };
    expect(defaultShouldFallback(err, ctx)).toBe(false);
  });

  it("ctx does NOT affect non-auth errors (they use their existing walk-table verdict)", () => {
    const rateLimit = new (class extends Error {
      constructor() {
        super("rate");
        this.name = "RateLimitError";
      }
    })();
    // RateLimitError is walk-worthy regardless of ctx.
    // (Using a duck-typed instance instead of the real class here — the point
    // is that the ctx doesn't change non-auth verdicts.)
    const ctx: ShouldFallbackContext = { providerAlias: "any", hasEverAuthenticated: false };
    expect(defaultShouldFallback(rateLimit, ctx)).toBe(defaultShouldFallback(rateLimit));
  });
});

describe("aggressiveShouldFallback — same ctx-aware AuthenticationError semantics", () => {
  const err = new AuthenticationError("openai", new Error("Incorrect API key"));

  it("returns false when ctx is undefined (backwards-compat)", () => {
    expect(aggressiveShouldFallback(err)).toBe(false);
  });

  it("returns true when ctx says never-authenticated (walk)", () => {
    expect(aggressiveShouldFallback(err, { providerAlias: "x", hasEverAuthenticated: false })).toBe(true);
  });

  it("returns false when ctx says has-authenticated (abort)", () => {
    expect(aggressiveShouldFallback(err, { providerAlias: "x", hasEverAuthenticated: true })).toBe(false);
  });
});

// ─── Registry integration: state + fallback behavior ────────────────

function fakeGoodPort(modelId: string, alias: string): LLMPort {
  return {
    async generateText(): Promise<GenerateTextResult> {
      return {
        text: `from ${alias}/${modelId}`,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        modelId,
        providerAlias: alias,
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
}

function fakeAuthFailingPort(_modelId: string, alias: string): LLMPort {
  const err = () => new AuthenticationError(alias, new Error("Incorrect API key"));
  return {
    async generateText() {
      throw err();
    },
    async generateStructured() {
      throw err();
    },
    async runAgent() {
      throw err();
    },
    streamText: async function* () {
      yield "";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

/**
 * A port that succeeds the first call and 401s every call after. Simulates
 * "credential valid at deploy time, revoked mid-day."
 *
 * The counter is shared across every port instance for the same alias
 * (module-level Map). Registry creates a fresh port per attempt from
 * `AdapterRegistration.createLLMPort`, so port-local state would reset
 * every attempt; keying by alias in a shared Map gives the "one
 * conceptual provider whose credential goes bad" behavior the test wants.
 */
const authGoesBadCallCounts = new Map<string, number>();
function fakeAuthGoesBadPort(modelId: string, alias: string): LLMPort {
  return {
    async generateText(): Promise<GenerateTextResult> {
      const n = (authGoesBadCallCounts.get(alias) ?? 0) + 1;
      authGoesBadCallCounts.set(alias, n);
      if (n === 1) {
        return {
          text: `from ${alias}/${modelId}`,
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
          modelId,
          providerAlias: alias,
          latencyMs: 1,
        };
      }
      throw new AuthenticationError(alias, new Error("Incorrect API key"));
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

const goodAnthropic: AdapterRegistration = {
  name: "anthropic",
  pricing: { "claude-haiku-4-5": HAIKU_PRICING },
  createLLMPort: fakeGoodPort,
};

const authFailingOpenai: AdapterRegistration = {
  name: "openai",
  pricing: { "gpt-4o": GPT_PRICING },
  createLLMPort: fakeAuthFailingPort,
};

const authGoesBadOpenai: AdapterRegistration = {
  name: "openai",
  pricing: { "gpt-4o": GPT_PRICING },
  createLLMPort: fakeAuthGoesBadPort,
};

// ─── hasEverAuthenticated state machine ─────────────────────────────

describe("Registry.hasEverAuthenticated — state machine", () => {
  beforeEach(() => {
    authGoesBadCallCounts.clear();
  });

  it("returns false initially for any alias", () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: goodAnthropic },
    });
    expect(registry.hasEverAuthenticated("a")).toBe(false);
    expect(registry.hasEverAuthenticated("nonexistent")).toBe(false);
  });

  it("becomes true after a successful attempt against that alias", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: goodAnthropic },
    });
    expect(registry.hasEverAuthenticated("a")).toBe(false);
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(registry.hasEverAuthenticated("a")).toBe(true);
  });

  it("is per-alias: success on A does not set the bit for B", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_PROVIDER_B: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: goodAnthropic },
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(registry.hasEverAuthenticated("a")).toBe(true);
    expect(registry.hasEverAuthenticated("b")).toBe(false);
  });

  it("stays true across subsequent failures on the same alias", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "openai|gpt-4o|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { openai: authGoesBadOpenai },
    });
    // First call: succeeds → bit set.
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(registry.hasEverAuthenticated("a")).toBe(true);
    // Second call: 401. Bit stays set (never-reset semantics).
    await expect(
      registry.getPort().generateText({
        taskType: "triage",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeDefined();
    expect(registry.hasEverAuthenticated("a")).toBe(true);
  });

  it("is set on the forced-provider short-circuit path too", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: goodAnthropic },
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
      forceProviderAlias: "a",
    });
    expect(registry.hasEverAuthenticated("a")).toBe(true);
  });
});

// ─── Registry integration: end-to-end fallback behavior ─────────────

describe("Registry — auth-error walks the chain when the failing provider never authenticated", () => {
  it("with runtimeFallback: 'aggressive', a first-time 401 at position 1 falls through to position 2", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: { openai: authFailingOpenai, anthropic: goodAnthropic },
      runtimeFallback: "aggressive",
    });
    const result = await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.providerAlias).toBe("backup"); // walked past the dead key
    expect(registry.hasEverAuthenticated("primary")).toBe(false); // never established
    expect(registry.hasEverAuthenticated("backup")).toBe(true);
  });

  it("with the default preset, a first-time 401 also walks (ctx-aware default)", async () => {
    // Alpha.30 change: the default preset (opt === undefined) is now
    // ctx-aware too — it walks on AuthenticationError iff !hasEverAuthenticated.
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: { openai: authFailingOpenai, anthropic: goodAnthropic },
      // no runtimeFallback: default preset
    });
    const result = await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.providerAlias).toBe("backup");
  });

  it("with runtimeFallback: { shouldFallback: defaultShouldFallback }, first-time 401 walks", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: { openai: authFailingOpenai, anthropic: goodAnthropic },
      runtimeFallback: { shouldFallback: defaultShouldFallback },
    });
    const result = await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.providerAlias).toBe("backup");
  });
});

describe("Registry — mid-flight auth failure still aborts", () => {
  beforeEach(() => {
    authGoesBadCallCounts.clear();
  });

  it("provider that authenticated once then fails does NOT walk on the second call", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: { openai: authGoesBadOpenai, anthropic: goodAnthropic },
      runtimeFallback: "aggressive",
    });
    // Call 1: succeeds on primary; bit set for primary.
    const first = await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(first.providerAlias).toBe("primary");
    expect(registry.hasEverAuthenticated("primary")).toBe(true);
    // Call 2: primary 401s. Because it has authenticated before, this is
    // treated as mid-flight and the chain aborts rather than walking.
    await expect(
      registry.getPort().generateText({
        taskType: "triage",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});

// ─── Backwards-compat: custom classifier without ctx still works ────

describe("Registry — custom classifier not consuming ctx still works", () => {
  it("a caller-supplied (err) => boolean sees no behavior change", async () => {
    // Custom classifier that walks on ProviderUnavailableError only —
    // does NOT walk on AuthenticationError even if ctx would allow it.
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: { openai: authFailingOpenai, anthropic: goodAnthropic },
      runtimeFallback: {
        shouldFallback: (err) => err instanceof ProviderUnavailableError,
      },
    });
    // Auth error is not walk-worthy for this classifier → chain aborts.
    await expect(
      registry.getPort().generateText({
        taskType: "triage",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});
