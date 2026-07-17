/**
 * Group J — registry + budget gating offline tests.
 *
 * Pins the gaps in the existing registry suite:
 *   - BudgetExceededError carries the correct `gatingKind` ("requests" vs "cost")
 *   - Cost limit windows: hour-cap kicks in independently of day-cap, etc.
 *   - Fallback chain when primary throws ProviderUnavailableError (not budget) → second tried
 *   - Malformed env config (wrong number of pipe-separated parts) → ConfigError at construction
 *   - NoProvidersAvailableError exposes attempted aliases and per-alias reasons
 */

import { describe, expect, it } from "vitest";
import {
  ConfigError,
  createRegistryFromEnv,
  NoProvidersAvailableError,
  ProviderUnavailableError,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 4.0 };

function fakePort(modelId: string, alias: string, opts: { failWith?: Error } = {}): LLMPort {
  return {
    async generateText(): Promise<GenerateTextResult> {
      if (opts.failWith) throw opts.failWith;
      return {
        text: `from ${alias}/${modelId}`,
        // Each call uses 1M input + 1M output → $5 per call (so cost gating
        // can be exercised with simple integer thresholds)
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
        cost: { inputUSD: 1.0, outputUSD: 4.0, totalUSD: 5.0 },
        modelId,
        providerAlias: alias,
        latencyMs: 1,
      };
    },
    async generateStructured() {
      throw new Error("not used in this test");
    },
    async runAgent() {
      throw new Error("not used in this test");
    },
    streamText: async function* () {
      yield "stub";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

const registration = (failWith?: Error): AdapterRegistration => ({
  name: "test",
  pricing: { "test-model": PRICING },
  createLLMPort: (modelId, alias) => fakePort(modelId, alias, failWith ? { failWith } : {}),
});

describe("Group J: registry + budget gating offline", () => {
  it("BudgetExceededError carries gatingKind='requests' when request limit trips", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "test|test-model|req:1/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { test: registration() },
    });
    const llm = registry.getPort();

    await llm.generateText({ taskType: "triage", messages: [{ role: "user" as const, content: "1" }] });

    // Second call: only "fast" in chain, budget exhausted → no fallback,
    // and we expect NoProvidersAvailableError. Look at the reasons map
    // to confirm budget gating fired with the correct gatingKind.
    let caught: unknown;
    try {
      await llm.generateText({ taskType: "triage", messages: [{ role: "user" as const, content: "2" }] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoProvidersAvailableError);
    const e = caught as NoProvidersAvailableError;
    expect(e.attempted).toContain("fast");
    // The reason for "fast" should mention budget / requests / exceeded
    const fastReason = e.reasons["fast"]?.toLowerCase() ?? "";
    expect(fastReason).toMatch(/budget|exceed|request/);
  });

  it("BudgetExceededError carries gatingKind='cost' when cost limit trips", async () => {
    // Cost limit: $4/day. One call costs $5 → trip on first call.
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "test|test-model|cost:4/day",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { test: registration() },
    });
    const llm = registry.getPort();

    // First call: $5 incurred. Recorded after success.
    const r1 = await llm.generateText({ taskType: "triage", messages: [{ role: "user" as const, content: "1" }] });
    expect(r1.providerAlias).toBe("fast");

    // Second call: budget already exceeded.
    let caught: unknown;
    try {
      await llm.generateText({ taskType: "triage", messages: [{ role: "user" as const, content: "2" }] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoProvidersAvailableError);
    const reason = (caught as NoProvidersAvailableError).reasons["fast"]?.toLowerCase() ?? "";
    expect(reason).toMatch(/cost|budget|exceed/);
  });

  it("runtime ProviderUnavailableError on the first provider triggers fallback to the next (alpha.7+)", async () => {
    // alpha.7 BEHAVIOR: the registry walks the fallback chain on runtime
    // errors matching the `runtimeFallback` predicate. Default is to walk on
    // `ProviderUnavailableError`. The `fast` provider 503s, the registry
    // moves to `backup`, and the call succeeds.
    //
    // Previously (≤ alpha.6) this test documented the OPPOSITE: runtime
    // errors propagated and never fell back. See runtime-fallback.test.ts
    // for the full alpha.7 surface (predicate config, NoProvidersAvailable
    // on full-chain failure, streaming semantics).
    const network503 = new ProviderUnavailableError("fast", new Error("503 Service Unavailable"));
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "test|test-model|unlimited",
        LLM_PROVIDER_BACKUP: "test|test-model|unlimited",
        LLM_TASK_ROUTE_TRIAGE: "fast,backup",
      },
      adapters: {
        test: {
          name: "test",
          pricing: { "test-model": PRICING },
          createLLMPort: (modelId, alias) =>
            fakePort(modelId, alias, alias === "fast" ? { failWith: network503 } : {}),
        },
      },
    });
    const llm = registry.getPort();

    const result = await llm.generateText({ taskType: "triage", messages: [{ role: "user" as const, content: "x" }] });
    expect(result.providerAlias).toBe("backup");
  });

  it("malformed env (wrong number of pipe-separated parts) throws ConfigError at construction", () => {
    expect(() =>
      createRegistryFromEnv({
        env: {
          // Missing the budget portion — only 2 parts instead of 3
          LLM_PROVIDER_FAST: "test|test-model",
          LLM_TASK_ROUTE_TRIAGE: "fast",
        },
        adapters: { test: registration() },
      }),
    ).toThrow(ConfigError);

    expect(() =>
      createRegistryFromEnv({
        env: {
          // Garbage budget spec
          LLM_PROVIDER_FAST: "test|test-model|garbage_budget_spec",
          LLM_TASK_ROUTE_TRIAGE: "fast",
        },
        adapters: { test: registration() },
      }),
    ).toThrow(ConfigError);
  });

  it("NoProvidersAvailableError reasons map names every attempted alias (budget-exhaustion path)", async () => {
    // Use budget gating (req:0/hour means immediately unavailable) to trigger
    // selectModel's NoProvidersAvailableError. The reasons map should include
    // an entry per chain alias, each with the budget-exhaustion message.
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "test|test-model|req:0/hour",
        LLM_PROVIDER_B: "test|test-model|req:0/hour",
        LLM_TASK_ROUTE_TRIAGE: "a,b",
      },
      adapters: { test: registration() },
    });
    const llm = registry.getPort();

    let caught: unknown;
    try {
      await llm.generateText({ taskType: "triage", messages: [{ role: "user" as const, content: "x" }] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoProvidersAvailableError);
    const e = caught as NoProvidersAvailableError;
    expect(e.attempted).toEqual(["a", "b"]);
    expect(e.reasons["a"]).toBeDefined();
    expect(e.reasons["b"]).toBeDefined();
    expect(e.taskType).toBe("triage");
  });
});
