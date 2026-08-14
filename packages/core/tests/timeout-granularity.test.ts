/**
 * Alpha.30 — Timeout track §2.2.1 (TaskConfig.defaultPerAttemptTimeoutMs)
 * + §2.2.2 (per-call perAttemptTimeoutMs override).
 *
 * SalesCoach's TD-CALLPLAN-CHAIN-TIMEOUT-STARVATION documented that the
 * single Registry-level `perAttemptTimeoutMs` was starving legitimately-
 * slow providers on a chain where only Cerebras (fast) fit under the 15s
 * global cap. This test suite verifies the four-step precedence chain
 * that closes the gap: call → task → Registry → undefined.
 *
 * The Registry-level and per-attempt-timeout mechanism itself (the
 * AbortController wrap) is already covered by the pre-existing
 * `tests/per-attempt-timeout.test.ts`. This suite tests the resolver
 * that decides WHICH value the mechanism uses.
 */

import { describe, expect, it } from "vitest";
import {
  createRegistryFromEnv,
  declareTasks,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const HAIKU_PRICING: ModelPricing = { inputPer1M: 0.8, outputPer1M: 4.0 };

// A port that never resolves — lets us test the timeout mechanism from
// the outside (an actual timeout fire is the only escape).
function stallingPort(_modelId: string, alias: string): LLMPort {
  return {
    async generateText(options): Promise<GenerateTextResult> {
      // Await the signal indefinitely; only the timeout / caller-signal
      // aborts this.
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
      // Unreachable — the abort rejects first.
      return {
        text: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
        modelId: "unused",
        providerAlias: alias,
        latencyMs: 0,
      };
    },
    async generateStructured() {
      throw new Error("not used");
    },
    async runAgent() {
      throw new Error("not used");
    },
    streamText: async function* () {
      yield "";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

const stallingAdapter: AdapterRegistration = {
  name: "stalling",
  pricing: { m: { inputPer1M: 0, outputPer1M: 0 } },
  createLLMPort: stallingPort,
};

// ─── Resolver semantics (unit-level, no timing) ─────────────────────

describe("Registry.resolvePerAttemptTimeoutMs — precedence chain", () => {
  it("returns undefined when no source is set", () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "stalling|m|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { stalling: stallingAdapter },
    });
    expect(registry.resolvePerAttemptTimeoutMs()).toBeUndefined();
    expect(registry.resolvePerAttemptTimeoutMs("triage")).toBeUndefined();
    expect(registry.resolvePerAttemptTimeoutMs(undefined, undefined)).toBeUndefined();
  });

  it("returns Registry-level when only Registry is set", () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "stalling|m|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { stalling: stallingAdapter },
      perAttemptTimeoutMs: 5000,
    });
    expect(registry.resolvePerAttemptTimeoutMs("triage")).toBe(5000);
    expect(registry.resolvePerAttemptTimeoutMs()).toBe(5000);
  });

  it("task-level overrides Registry-level for the matching taskType", () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "stalling|m|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { stalling: stallingAdapter },
      perAttemptTimeoutMs: 5000,
      taskDefaults: {
        "triage": { defaultPerAttemptTimeoutMs: 15000 },
      },
    });
    expect(registry.resolvePerAttemptTimeoutMs("triage")).toBe(15000);
    // Unmatched task falls through to Registry.
    expect(registry.resolvePerAttemptTimeoutMs("something-else")).toBe(5000);
  });

  it("call-level overrides both task-level and Registry-level", () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "stalling|m|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { stalling: stallingAdapter },
      perAttemptTimeoutMs: 5000,
      taskDefaults: {
        "triage": { defaultPerAttemptTimeoutMs: 15000 },
      },
    });
    expect(registry.resolvePerAttemptTimeoutMs("triage", 60000)).toBe(60000);
  });

  it("call-level 0 is honored (means 'no timeout' if caller wanted to override)", () => {
    // Note: 0 is a truthy-in-``?? `` sense — nullish coalescing preserves 0.
    // So call-level 0 wins over task-level and Registry-level.
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "stalling|m|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { stalling: stallingAdapter },
      perAttemptTimeoutMs: 5000,
    });
    expect(registry.resolvePerAttemptTimeoutMs("triage", 0)).toBe(0);
  });

  it("taskDefaults keys are normalized (SCREAMING_SNAKE and kebab-case share)", () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "stalling|m|req:100/hour",
        LLM_TASK_ROUTE_STRUCTURED_OUTPUT: "a",
      },
      adapters: { stalling: stallingAdapter },
      taskDefaults: {
        "STRUCTURED_OUTPUT": { defaultPerAttemptTimeoutMs: 30000 },
      },
    });
    // Registered as SCREAMING_SNAKE; caller passes kebab-case; still resolves.
    expect(registry.resolvePerAttemptTimeoutMs("structured-output")).toBe(30000);
    expect(registry.resolvePerAttemptTimeoutMs("STRUCTURED_OUTPUT")).toBe(30000);
    expect(registry.resolvePerAttemptTimeoutMs("Structured_Output")).toBe(30000);
  });

  it("taskDefaults with undefined defaultPerAttemptTimeoutMs falls through to Registry", () => {
    // A task declared with other config fields but no timeout should behave
    // as if there's no task-level default.
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "stalling|m|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { stalling: stallingAdapter },
      perAttemptTimeoutMs: 5000,
      taskDefaults: {
        "triage": { defaultTemperature: 0.5 }, // no timeout set
      },
    });
    expect(registry.resolvePerAttemptTimeoutMs("triage")).toBe(5000);
  });

  it("integrates with declareTasks pattern via .__meta", () => {
    const tasks = declareTasks({
      "call-plan": { defaultPerAttemptTimeoutMs: 60000 },
      "classify": { defaultPerAttemptTimeoutMs: 5000 },
    });
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "stalling|m|req:100/hour",
        LLM_TASK_ROUTE_CALL_PLAN: "a",
        LLM_TASK_ROUTE_CLASSIFY: "a",
      },
      adapters: { stalling: stallingAdapter },
      taskDefaults: tasks.__meta,
    });
    expect(registry.resolvePerAttemptTimeoutMs(tasks["call-plan"])).toBe(60000);
    expect(registry.resolvePerAttemptTimeoutMs(tasks["classify"])).toBe(5000);
  });
});

// ─── End-to-end: the timeout actually fires ─────────────────────────

describe("Registry — per-call perAttemptTimeoutMs override actually enforces the timeout", () => {
  it("a per-call override triggers the AbortController when the Registry global is looser", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "stalling|m|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { stalling: stallingAdapter },
      perAttemptTimeoutMs: 30000, // 30s global — would win without the override
    });
    // Per-call 50ms should fire quickly.
    const start = Date.now();
    await expect(
      registry.getPort().generateText({
        taskType: "triage",
        messages: [{ role: "user", content: "hi" }],
        perAttemptTimeoutMs: 50,
      }),
    ).rejects.toBeDefined();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000); // fired well within the 30s global
  });

  it("a task-default triggers when call override is omitted", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "stalling|m|req:100/hour",
        LLM_TASK_ROUTE_QUICK_TASK: "a",
      },
      adapters: { stalling: stallingAdapter },
      perAttemptTimeoutMs: 30000, // 30s global
      taskDefaults: {
        "quick-task": { defaultPerAttemptTimeoutMs: 50 }, // task-declared tight
      },
    });
    const start = Date.now();
    await expect(
      registry.getPort().generateText({
        taskType: "quick-task",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeDefined();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });
});
