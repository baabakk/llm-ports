/**
 * Alpha.29 — Registry-level instrumentation integration tests.
 *
 * Covers the wire-up between the Registry and the shared instrumentation
 * service. When `RegistryOptions.instrumentation` is supplied, every call
 * to `generateText` / `generateStructured` / `runAgent` should emit the
 * full contract lifecycle: operation.started, per-attempt started +
 * completed/failed, fallback.selected on chain advancement, and
 * operation.completed / .failed / .cancelled at the outer boundary.
 *
 * These are integration-level. Unit-level behavior of the wrappers
 * themselves lives in `tests/instrumentation.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  createCollectingSink,
  type EventSource,
  type ObservabilityEvent,
} from "@llm-ports/observability-contract";
import {
  createRegistryFromEnv,
  ProviderUnavailableError,
  type AdapterRegistration,
  type AgentResult,
  type GenerateStructuredResult,
  type GenerateTextResult,
  type Instrumentation,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const HAIKU_PRICING: ModelPricing = { inputPer1M: 0.8, outputPer1M: 4.0 };
const testSource: EventSource = { library: "test", library_version: "0.0.0" };

function collectingInstrumentation(): {
  instr: Instrumentation;
  sink: ReturnType<typeof createCollectingSink>;
} {
  const sink = createCollectingSink();
  return {
    instr: { config: { sink, source: testSource } },
    sink,
  };
}

// A fake port that succeeds. Returns synthetic usage + cost.
function successPort(modelId: string, alias: string): LLMPort {
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
    async generateStructured<T>(): Promise<GenerateStructuredResult<T>> {
      return {
        data: { hello: "world" } as unknown as T,
        text: '{"hello":"world"}',
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
        cost: { inputUSD: 0.0005, outputUSD: 0.001, totalUSD: 0.0015 },
        modelId,
        providerAlias: alias,
        latencyMs: 1,
      };
    },
    async runAgent(): Promise<AgentResult> {
      return {
        text: `agent from ${alias}`,
        messages: [{ role: "user", content: "hi" }],
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
        cost: { inputUSD: 0.01, outputUSD: 0.02, totalUSD: 0.03 },
        modelId,
        providerAlias: alias,
        latencyMs: 1,
        stepsTaken: 1,
        terminationReason: "completed",
      };
    },
    streamText: async function* () {
      yield "stub";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

// A fake port that always fails with ProviderUnavailableError. Used to
// exercise the fallback chain — the Registry's default `shouldFallback`
// walks on this class.
function failingPort(_modelId: string, alias: string): LLMPort {
  const err = () => new ProviderUnavailableError(alias, new Error("stub down"));
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
      throw err();
    },
    streamStructured: async function* () {
      yield {} as never;
      throw err();
    },
  };
}

const goodAnthropic: AdapterRegistration = {
  name: "anthropic",
  pricing: { "claude-haiku-4-5": HAIKU_PRICING },
  createLLMPort: successPort,
};

const failingAdapter: AdapterRegistration = {
  name: "openai",
  pricing: { "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 } },
  createLLMPort: failingPort,
};

// ─── Happy path: single successful attempt ──────────────────────────

describe("Registry instrumentation — single successful attempt", () => {
  it("emits the standard 4-event happy path for generateText", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: goodAnthropic },
      instrumentation: instr,
    });
    const llm = registry.getPort();
    await llm.generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });

    const types = sink.events.map((e) => e.event_type);
    expect(types).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "llm.attempt.completed",
      "llm.operation.completed",
    ]);
  });

  it("stamps method + provider_chain + task_type on operation.started", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: goodAnthropic },
      instrumentation: instr,
    });
    await registry.getPort().generateStructured({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
      schema: {} as never,
    });
    const started = sink.events[0]! as ObservabilityEvent<
      "llm.operation.started",
      { task_type: string; method: string; provider_chain: string[] }
    >;
    expect(started.data.task_type).toBe("triage");
    expect(started.data.method).toBe("generateStructured");
    expect(started.data.provider_chain).toEqual(["fast"]);
  });

  it("propagates usage + cost into aggregate_usage + aggregate_cost", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_AGENT: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_AGENT_TASK: "agent",
      },
      adapters: { anthropic: goodAnthropic },
      instrumentation: instr,
    });
    await registry.getPort().runAgent({
      taskType: "agent-task",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
    });
    const completed = sink.events[sink.events.length - 1]! as ObservabilityEvent<
      "llm.operation.completed",
      {
        aggregate_usage: { totalTokens: number };
        aggregate_cost: { totalUSD: number };
        attempts_made: number;
        final_provider_alias: string;
      }
    >;
    expect(completed.data.aggregate_usage.totalTokens).toBe(300);
    expect(completed.data.aggregate_cost.totalUSD).toBeCloseTo(0.03);
    expect(completed.data.attempts_made).toBe(1);
    expect(completed.data.final_provider_alias).toBe("agent");
  });
});

// ─── Fallback chain: attempt.failed → fallback.selected → attempt.started ──

describe("Registry instrumentation — fallback chain", () => {
  it("emits attempt.failed, then fallback.selected, then attempt.started on the next provider", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: { openai: failingAdapter, anthropic: goodAnthropic },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    const types = sink.events.map((e) => e.event_type);
    expect(types).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "llm.attempt.failed",
      "llm.fallback.selected",
      "llm.attempt.started",
      "llm.attempt.completed",
      "llm.operation.completed",
    ]);
  });

  it("fallback.selected carries from + to + cause fields", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: { openai: failingAdapter, anthropic: goodAnthropic },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    const fb = sink.events.find((e) => e.event_type === "llm.fallback.selected") as
      | ObservabilityEvent<"llm.fallback.selected", { from_provider_alias: string; to_provider_alias: string; cause: string }>
      | undefined;
    expect(fb).toBeDefined();
    expect(fb!.data.from_provider_alias).toBe("primary");
    expect(fb!.data.to_provider_alias).toBe("backup");
    expect(fb!.data.cause).toBe("provider_unavailable");
  });

  it("all events share one operation_id across the fallback", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: { openai: failingAdapter, anthropic: goodAnthropic },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    const opIds = new Set(sink.events.map((e) => e.operation_id));
    expect(opIds.size).toBe(1);
  });

  it("the second attempt.started carries is_fallback=true", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: { openai: failingAdapter, anthropic: goodAnthropic },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    const started = sink.events.filter(
      (e) => e.event_type === "llm.attempt.started",
    ) as ObservabilityEvent<"llm.attempt.started", { is_fallback: boolean; provider_alias: string }>[];
    expect(started[0]!.data.is_fallback).toBe(false);
    expect(started[0]!.data.provider_alias).toBe("primary");
    expect(started[1]!.data.is_fallback).toBe(true);
    expect(started[1]!.data.provider_alias).toBe("backup");
  });
});

// ─── No instrumentation ─────────────────────────────────────────────

describe("Registry instrumentation — opt-out", () => {
  it("emits nothing when instrumentation is not configured", async () => {
    // Same setup as the happy-path test but no `instrumentation:` key.
    // No sink is available to inspect, so this test just verifies the
    // call completes normally without observability wired.
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: goodAnthropic },
      // No instrumentation.
    });
    const result = await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toContain("fast/claude-haiku-4-5");
  });
});

// ─── Full failure ───────────────────────────────────────────────────

describe("Registry instrumentation — full failure (no viable provider)", () => {
  it("emits operation.failed with attempts_made + providers_tried when every chain member fails", async () => {
    const { instr, sink } = collectingInstrumentation();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_B: "openai|gpt-4o|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a,b",
      },
      adapters: { openai: failingAdapter },
      instrumentation: instr,
    });
    await expect(
      registry.getPort().generateText({
        taskType: "triage",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeDefined();

    const failedOp = sink.events.find((e) => e.event_type === "llm.operation.failed") as
      | ObservabilityEvent<
          "llm.operation.failed",
          { providers_tried: string[]; attempts_made: number; error: { message: string } }
        >
      | undefined;
    expect(failedOp).toBeDefined();
    expect(failedOp!.data.attempts_made).toBe(2);
    expect(failedOp!.data.providers_tried).toEqual(["a", "b"]);
  });
});
