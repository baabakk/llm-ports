/**
 * Alpha.29 — SalesCoach task-type case-mismatch fix.
 *
 * Root cause. The env-var parser lowercases + hyphenates suffixes so
 * `LLM_TASK_ROUTE_STRUCTURED_OUTPUT=...` stores the chain under key
 * `"structured-output"`. Pre-alpha.29, both `Registry.selectModel` and
 * `Registry.selectViableChain` did a string-identity lookup against the
 * caller-supplied `taskType`, then silently fell through to `"general"`
 * when the key missed. A caller passing `"STRUCTURED_OUTPUT"` never hit
 * its own configured route.
 *
 * Fix (this file exercises).
 *   1. `Registry.resolveTaskChain(taskType)` normalizes the input the same
 *      way parse does, so uppercase / mixed-case / underscored inputs all
 *      resolve to the same route as the correctly-spelled kebab-case key.
 *   2. When the normalized lookup still misses and the fallback to
 *      `"general"` fires, a warn-once message goes through the shared
 *      `WarningState`. Silent config drift becomes visible.
 *
 * SalesCoach tracker: `TD-LLM-TASKTYPE-CASE-MISMATCH-SILENT-GENERAL-FALLBACK`
 * (their tracker `f7af4eb`, 2026-08-10). Filed here as a llm-ports-side
 * defect; the fix lives upstream so downstream consumers close by bumping
 * to alpha.29 with zero code changes.
 */

import { describe, expect, it } from "vitest";
import {
  createRegistryFromEnv,
  normalizeTaskType,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const HAIKU_PRICING: ModelPricing = { inputPer1M: 0.8, outputPer1M: 4.0 };

function fakePort(modelId: string, alias: string): LLMPort {
  return {
    async generateText(): Promise<GenerateTextResult> {
      return {
        text: `from ${alias}/${modelId}`,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
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

const fakeAnthropic: AdapterRegistration = {
  name: "anthropic",
  pricing: { "claude-haiku-4-5": HAIKU_PRICING },
  createLLMPort: fakePort,
};

// ─── normalizeTaskType — pure helper ────────────────────────────────

describe("normalizeTaskType", () => {
  it("lowercases and converts underscores to hyphens", () => {
    expect(normalizeTaskType("STRUCTURED_OUTPUT")).toBe("structured-output");
  });

  it("passes kebab-case through unchanged", () => {
    expect(normalizeTaskType("structured-output")).toBe("structured-output");
  });

  it("handles mixed-case underscore combinations", () => {
    expect(normalizeTaskType("Structured_Output")).toBe("structured-output");
    expect(normalizeTaskType("code_review")).toBe("code-review");
    expect(normalizeTaskType("SUMMARIZATION")).toBe("summarization");
  });

  it("is idempotent", () => {
    const inputs = ["STRUCTURED_OUTPUT", "structured-output", "Code_Review", "TRIAGE"];
    for (const s of inputs) {
      expect(normalizeTaskType(normalizeTaskType(s))).toBe(normalizeTaskType(s));
    }
  });
});

// ─── Case-insensitive lookup at the Registry ────────────────────────

describe("Registry — case-insensitive task-type lookup", () => {
  it("routes uppercase-underscored taskType to the kebab-case env-configured route", async () => {
    // Configure ONLY structured-output. Verify the caller's uppercase
    // form finds it.
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_STRUCTURED: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_PROVIDER_GENERAL: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_STRUCTURED_OUTPUT: "structured",
        LLM_TASK_ROUTE_GENERAL: "general",
      },
      adapters: { anthropic: fakeAnthropic },
    });
    const llm = registry.getPort();
    const result = await llm.generateText({
      taskType: "STRUCTURED_OUTPUT",
      messages: [{ role: "user" as const, content: "hi" }],
    });
    // If normalization is missing, the STRUCTURED_OUTPUT call would
    // fall through to "general" and land on `general/claude-haiku-4-5`
    // instead of `structured/claude-haiku-4-5`.
    expect(result.providerAlias).toBe("structured");
  });

  it("routes mixed-case (Structured_Output) to the same route", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_STRUCTURED: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_PROVIDER_GENERAL: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_STRUCTURED_OUTPUT: "structured",
        LLM_TASK_ROUTE_GENERAL: "general",
      },
      adapters: { anthropic: fakeAnthropic },
    });
    const llm = registry.getPort();
    const result = await llm.generateText({
      taskType: "Structured_Output",
      messages: [{ role: "user" as const, content: "hi" }],
    });
    expect(result.providerAlias).toBe("structured");
  });

  it("still resolves kebab-case (structured-output) correctly", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_STRUCTURED: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_PROVIDER_GENERAL: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_STRUCTURED_OUTPUT: "structured",
        LLM_TASK_ROUTE_GENERAL: "general",
      },
      adapters: { anthropic: fakeAnthropic },
    });
    const llm = registry.getPort();
    const result = await llm.generateText({
      taskType: "structured-output",
      messages: [{ role: "user" as const, content: "hi" }],
    });
    expect(result.providerAlias).toBe("structured");
  });
});

// ─── Warn-once on unknown task type ─────────────────────────────────

describe("Registry — warn-once on unknown task type", () => {
  it("warns once when a caller-supplied taskType falls through to the general chain", async () => {
    const messages: string[] = [];
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_GENERAL: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_GENERAL: "general",
      },
      adapters: { anthropic: fakeAnthropic },
      deprecationWarningHandler: (msg) => messages.push(msg),
    });
    const llm = registry.getPort();

    await llm.generateText({ taskType: "MADE_UP_TASK", messages: [{ role: "user" as const, content: "hi" }] });

    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("MADE_UP_TASK");
    expect(messages[0]).toContain("made-up-task");
    expect(messages[0]).toContain("general");
  });

  it("dedups: two calls with the same unknown taskType warn only once", async () => {
    const messages: string[] = [];
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_GENERAL: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_GENERAL: "general",
      },
      adapters: { anthropic: fakeAnthropic },
      deprecationWarningHandler: (msg) => messages.push(msg),
    });
    const llm = registry.getPort();

    await llm.generateText({ taskType: "MADE_UP_TASK", messages: [{ role: "user" as const, content: "hi" }] });
    await llm.generateText({ taskType: "MADE_UP_TASK", messages: [{ role: "user" as const, content: "again" }] });
    await llm.generateText({ taskType: "made-up-task", messages: [{ role: "user" as const, content: "and again" }] });

    // Dedup is on the normalized key, so all three collapse to one.
    expect(messages.length).toBe(1);
  });

  it("does NOT warn when the taskType is a known route (case-insensitively)", async () => {
    const messages: string[] = [];
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_STRUCTURED: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_PROVIDER_GENERAL: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_STRUCTURED_OUTPUT: "structured",
        LLM_TASK_ROUTE_GENERAL: "general",
      },
      adapters: { anthropic: fakeAnthropic },
      deprecationWarningHandler: (msg) => messages.push(msg),
    });
    const llm = registry.getPort();

    await llm.generateText({ taskType: "STRUCTURED_OUTPUT", messages: [{ role: "user" as const, content: "hi" }] });
    await llm.generateText({ taskType: "structured-output", messages: [{ role: "user" as const, content: "hi" }] });
    await llm.generateText({ taskType: "Structured_Output", messages: [{ role: "user" as const, content: "hi" }] });

    expect(messages.length).toBe(0);
  });

  it("does NOT warn when the caller explicitly passes the general taskType", async () => {
    const messages: string[] = [];
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_GENERAL: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_GENERAL: "general",
      },
      adapters: { anthropic: fakeAnthropic },
      deprecationWarningHandler: (msg) => messages.push(msg),
    });
    const llm = registry.getPort();

    await llm.generateText({ taskType: "general", messages: [{ role: "user" as const, content: "hi" }] });
    await llm.generateText({ taskType: "GENERAL", messages: [{ role: "user" as const, content: "hi" }] });

    // Both hit the "general" route via normalization; no fallback fires.
    expect(messages.length).toBe(0);
  });
});
