/**
 * Alpha.20 verification tests.
 *
 * Covers the four acceptance criteria from the master plan §4.4:
 *
 *   1. BudgetScope tests cover all 5 axes (tenant / customer / user / agent / session).
 *   2. Minute-grain tests prove Cerebras 30 RPM is now expressible
 *      (closes TD-LLMPORTS-GATING-MINUTE).
 *   3. Session-window tests cover all 4 new gating tokens
 *      (cost:N/session, req:N/session, total_tokens:N/session, tool_calls:N/session).
 *   4. `parseGating` accepts the new tokens and writes the right fields.
 *
 * Plus: scoped storage-key composition + per-scope counter isolation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  CostSession,
  InMemoryBudget,
  InMemoryCost,
  Registry,
  SessionBudgetExceededError,
  parseRegistryConfig,
  type AdapterRegistration,
  type AgentResult,
  type BudgetScope,
  type GenerateStructuredOptions,
  type GenerateStructuredResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type LLMPort,
  type RunAgentOptions,
  type StreamStructuredOptions,
  type StreamTextOptions,
} from "../src/index.js";
import { z } from "zod";

// ─── parseGating: alpha.20 token coverage ────────────────────────────

describe("parseGating — alpha.20 token grammar", () => {
  it("accepts req:N/minute and writes BudgetLimit.perMinute", () => {
    const config = parseRegistryConfig({
      env: { LLM_PROVIDER_FAST: "anthropic|claude-haiku|req:30/minute" },
    });
    expect(config.providers["fast"]?.budgetLimit).toMatchObject({
      kind: "requests",
      perMinute: 30,
    });
  });

  it("accepts cost:N/minute and writes CostLimit.perMinute", () => {
    const config = parseRegistryConfig({
      env: { LLM_PROVIDER_FAST: "anthropic|claude-haiku|cost:0.50/minute" },
    });
    expect(config.providers["fast"]?.costLimit).toMatchObject({
      kind: "usd",
      perMinute: 0.5,
    });
  });

  it("accepts cost:N/session and writes CostLimit.perSession", () => {
    const config = parseRegistryConfig({
      env: { LLM_PROVIDER_FAST: "anthropic|claude-haiku|cost:1.00/session" },
    });
    expect(config.providers["fast"]?.costLimit).toMatchObject({
      kind: "usd",
      perSession: 1.0,
    });
  });

  it("accepts req:N/session and writes BudgetLimit.perSession", () => {
    const config = parseRegistryConfig({
      env: { LLM_PROVIDER_FAST: "anthropic|claude-haiku|req:50/session" },
    });
    expect(config.providers["fast"]?.budgetLimit).toMatchObject({
      kind: "requests",
      perSession: 50,
    });
  });

  it("accepts total_tokens:N/session and writes SessionGrainLimits.totalTokensPerSession", () => {
    const config = parseRegistryConfig({
      env: { LLM_PROVIDER_FAST: "anthropic|claude-haiku|total_tokens:50000/session" },
    });
    expect(config.providers["fast"]?.sessionLimits).toEqual({
      totalTokensPerSession: 50000,
    });
  });

  it("accepts tool_calls:N/session and writes SessionGrainLimits.toolCallsPerSession", () => {
    const config = parseRegistryConfig({
      env: { LLM_PROVIDER_FAST: "anthropic|claude-haiku|tool_calls:8/session" },
    });
    expect(config.providers["fast"]?.sessionLimits).toEqual({
      toolCallsPerSession: 8,
    });
  });

  it("composes multiple new tokens in one gating string", () => {
    const config = parseRegistryConfig({
      env: {
        LLM_PROVIDER_FAST:
          "anthropic|claude-haiku|req:30/minute,cost:0.50/minute,cost:1.00/session,total_tokens:50000/session,tool_calls:8/session",
      },
    });
    const entry = config.providers["fast"];
    expect(entry?.budgetLimit).toMatchObject({ kind: "requests", perMinute: 30 });
    expect(entry?.costLimit).toMatchObject({
      kind: "usd",
      perMinute: 0.5,
      perSession: 1.0,
    });
    expect(entry?.sessionLimits).toEqual({
      totalTokensPerSession: 50000,
      toolCallsPerSession: 8,
    });
  });

  it("alpha.19 syntax keeps working unchanged (req:N/hour, cost:N/day)", () => {
    const config = parseRegistryConfig({
      env: { LLM_PROVIDER_FAST: "anthropic|claude-haiku|req:500/hour,cost:50/day" },
    });
    expect(config.providers["fast"]?.budgetLimit).toMatchObject({
      kind: "requests",
      requestsPerHour: 500,
      perHour: 500,
    });
    expect(config.providers["fast"]?.costLimit).toMatchObject({
      kind: "usd",
      perDay: 50,
    });
  });

  it("rejects invalid req window", () => {
    expect(() =>
      parseRegistryConfig({
        env: { LLM_PROVIDER_FAST: "anthropic|claude-haiku|req:30/decade" },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects invalid session-grain token format", () => {
    expect(() =>
      parseRegistryConfig({
        env: { LLM_PROVIDER_FAST: "anthropic|claude-haiku|total_tokens:50000/hour" },
      }),
    ).toThrow(ConfigError);
  });
});

// ─── Acceptance: Cerebras 30 RPM minute-grain expressibility ─────────

describe("Acceptance: Cerebras 30 RPM minute-grain (closes TD-LLMPORTS-GATING-MINUTE)", () => {
  it("InMemoryBudget enforces req:30/minute by allowing 30 then blocking the 31st", async () => {
    const budget = new InMemoryBudget();
    const limit = { kind: "requests" as const, perMinute: 30 };
    for (let i = 0; i < 30; i++) {
      const check = await budget.check("cerebras", limit);
      expect(check.allowed).toBe(true);
      await budget.recordRequest("cerebras");
    }
    const finalCheck = await budget.check("cerebras", limit);
    expect(finalCheck.allowed).toBe(false);
    expect(finalCheck.current).toBe(30);
    expect(finalCheck.limit).toBe(30);
    expect(finalCheck.reason).toMatch(/30\/minute/);
  });

  it("after the minute window passes, the 31st request is allowed again", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-06-13T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    try {
      const budget = new InMemoryBudget();
      const limit = { kind: "requests" as const, perMinute: 30 };
      for (let i = 0; i < 30; i++) await budget.recordRequest("cerebras");
      expect((await budget.check("cerebras", limit)).allowed).toBe(false);

      // Advance 61 seconds; the minute window slides past every recorded call.
      vi.setSystemTime(t0 + 61_000);
      expect((await budget.check("cerebras", limit)).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── BudgetScope: per-scope storage-key isolation ────────────────────

describe("BudgetScope — all 5 axes hash into independent storage keys", () => {
  const axes: BudgetScope[] = ["tenant", "customer", "user", "agent", "session"];

  for (const axis of axes) {
    it(`scope="${axis}" — two different scopeIds get independent counters`, async () => {
      const budget = new InMemoryBudget();
      const limit = { kind: "requests" as const, perHour: 5 };

      // Saturate scopeId="A".
      for (let i = 0; i < 5; i++) {
        await budget.recordRequest(`gpt5|${axis}:A`);
      }
      expect((await budget.check(`gpt5|${axis}:A`, limit)).allowed).toBe(false);

      // scopeId="B" is unaffected.
      expect((await budget.check(`gpt5|${axis}:B`, limit)).allowed).toBe(true);
    });
  }

  it("Registry.scopedKey composes alias|scope:scopeId", async () => {
    const registry = await makeRegistry({
      env: { LLM_PROVIDER_GPT5: "fake|fake-model|unlimited", LLM_TASK_ROUTE_GENERAL: "gpt5" },
    });
    expect(registry.scopedKey("gpt5")).toBe("gpt5");
    expect(registry.scopedKey("gpt5", { scope: "tenant", scopeId: "acme" })).toBe("gpt5|tenant:acme");
    expect(registry.scopedKey("gpt5", { scope: "session", scopeId: "cs-001" })).toBe("gpt5|session:cs-001");
  });

  it("per-tenant cost cap: tenant A trips the cap; tenant B still has full budget", async () => {
    const registry = await makeRegistry({
      env: {
        LLM_PROVIDER_GPT5: "fake|fake-model|cost:0.05/hour",
        LLM_TASK_ROUTE_GENERAL: "gpt5",
      },
      enqueueText: (n) => Array.from({ length: n }, () => ({ text: "ok", cost: 0.02 })),
    });
    const port = registry.getPort();

    // Tenant A: per-call cost $0.02, cap $0.05/hour.
    // Call 1 (spent=0 < 0.05) succeeds → spent=0.02.
    // Call 2 (spent=0.02 < 0.05) succeeds → spent=0.04.
    // Call 3 (spent=0.04 < 0.05) succeeds → spent=0.06.
    // Call 4 (spent=0.06 ≥ 0.05) blocked.
    await port.generateText({ taskType: "general", messages: [{ role: "user" as const, content: "hi" }], budgetScope: { scope: "tenant", scopeId: "A" } });
    await port.generateText({ taskType: "general", messages: [{ role: "user" as const, content: "hi" }], budgetScope: { scope: "tenant", scopeId: "A" } });
    await port.generateText({ taskType: "general", messages: [{ role: "user" as const, content: "hi" }], budgetScope: { scope: "tenant", scopeId: "A" } });
    // Registry wraps the cost-cap failure as NoProvidersAvailableError with the
    // per-provider reason carrying "Cost cap exceeded".
    const err = await port
      .generateText({ taskType: "general", messages: [{ role: "user" as const, content: "hi" }], budgetScope: { scope: "tenant", scopeId: "A" } })
      .catch((e) => e);
    expect(err).toMatchObject({ name: "NoProvidersAvailableError" });
    expect((err as { reasons: Record<string, string> }).reasons["gpt5"]).toMatch(/Cost cap exceeded/);

    // Tenant B starts at zero — call succeeds.
    const resB = await port.generateText({
      taskType: "general",
      messages: [{ role: "user" as const, content: "hi" }],
      budgetScope: { scope: "tenant", scopeId: "B" },
    });
    expect(resB.text).toBe("ok");
  });
});

// ─── CostSession: session-grain caps ─────────────────────────────────

describe("CostSession — session-window grain enforcement (4 alpha.20 tokens)", () => {
  function makeFakePort(perCallCost: number, perCallTokens: number, toolCallsPerRun = 0): LLMPort {
    const baseUsage = { inputTokens: perCallTokens / 2, outputTokens: perCallTokens / 2, totalTokens: perCallTokens };
    const baseCost = { inputUSD: perCallCost / 2, outputUSD: perCallCost / 2, totalUSD: perCallCost };
    const port: LLMPort = {
      async generateText(_options: GenerateTextOptions): Promise<GenerateTextResult> {
        return {
          text: "ok",
          usage: baseUsage,
          cost: baseCost,
          modelId: "fake-model",
          providerAlias: "fake",
          latencyMs: 1,
        };
      },
      async generateStructured<T>(options: GenerateStructuredOptions<T>): Promise<GenerateStructuredResult<T>> {
        const parsed = options.schema.parse({ ok: true });
        return {
          data: parsed as T,
          usage: baseUsage,
          cost: baseCost,
          modelId: "fake-model",
          providerAlias: "fake",
          latencyMs: 1,
          validationAttempts: 1,
        };
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamText(_options: StreamTextOptions): AsyncIterable<string> {
        yield "ok";
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamStructured<T>(_options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
        yield { ok: true } as Partial<T>;
      },
      async runAgent(_options: RunAgentOptions): Promise<AgentResult> {
        const toolCalls = Array.from({ length: toolCallsPerRun }, (_, i) => ({
          name: `tool${i}`,
          input: {},
          output: null,
        }));
        return {
          text: "ok",
          messages: [],
          toolCalls,
          usage: baseUsage,
          cost: baseCost,
          modelId: "fake-model",
          providerAlias: "fake",
          latencyMs: 1,
          stepsTaken: 1,
          terminationReason: "completed",
        };
      },
    };
    return port;
  }

  it("cost:N/session — budgetUSD enforces the USD cap (legacy behavior unchanged)", async () => {
    const session = new CostSession(makeFakePort(0.04, 100), { budgetUSD: 0.1 });
    const port = session.getPort();
    await port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] });
    await port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] });
    // 2 calls × $0.04 = $0.08; next call would push to $0.12 > $0.10
    await port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] });
    expect(session.totalSpentUSD()).toBeCloseTo(0.12, 4);
    await expect(port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] })).rejects.toThrow(SessionBudgetExceededError);
  });

  it("req:N/session — maxRequests trips on the (N+1)th call", async () => {
    const session = new CostSession(makeFakePort(0.001, 10), { budgetUSD: 100, maxRequests: 3 });
    const port = session.getPort();
    await port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] });
    await port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] });
    await port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] });
    expect(session.requestsMade()).toBe(3);
    const err = await port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(SessionBudgetExceededError);
    expect((err as SessionBudgetExceededError).grain).toMatch(/^requests/);
  });

  it("total_tokens:N/session — maxTokens trips when accumulated tokens exceed the cap", async () => {
    const session = new CostSession(makeFakePort(0.001, 500), { budgetUSD: 100, maxTokens: 1000 });
    const port = session.getPort();
    await port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] }); // 500
    await port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] }); // 1000
    expect(session.tokensUsed()).toBe(1000);
    const err = await port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(SessionBudgetExceededError);
    expect((err as SessionBudgetExceededError).grain).toMatch(/^tokens/);
  });

  it("tool_calls:N/session — maxToolCalls trips when tool-call total exceeds cap", async () => {
    const session = new CostSession(makeFakePort(0.001, 10, 2), { budgetUSD: 100, maxToolCalls: 5 });
    const port = session.getPort();
    await port.runAgent({
      taskType: "x",
      instructions: "go",
      messages: [],
      tools: {},
    }); // +2 tool calls
    await port.runAgent({
      taskType: "x",
      instructions: "go",
      messages: [],
      tools: {},
    }); // +2 → 4
    await port.runAgent({
      taskType: "x",
      instructions: "go",
      messages: [],
      tools: {},
    }); // +2 → 6 (already accepted; next call sees 6 >= 5)
    expect(session.toolCallsMade()).toBe(6);
    const err = await port
      .runAgent({ taskType: "x", instructions: "go", messages: [], tools: {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SessionBudgetExceededError);
    expect((err as SessionBudgetExceededError).grain).toMatch(/^tool_calls/);
  });

  it("requestsMade / tokensUsed / toolCallsMade getters reflect accumulated state", async () => {
    const session = new CostSession(makeFakePort(0.005, 100, 1), { budgetUSD: 100 });
    const port = session.getPort();
    await port.generateText({ taskType: "x", messages: [{ role: "user" as const, content: "hi" }] });
    await port.runAgent({ taskType: "x", instructions: "go", messages: [], tools: {} });
    expect(session.requestsMade()).toBe(2);
    expect(session.tokensUsed()).toBe(200);
    expect(session.toolCallsMade()).toBe(1);
  });
});

// ─── Test helpers ────────────────────────────────────────────────────

async function makeRegistry(opts: {
  env: Record<string, string>;
  enqueueText?: (n: number) => Array<{ text: string; cost: number }>;
}): Promise<Registry> {
  const fakeQueue = opts.enqueueText?.(100) ?? [];
  let qi = 0;
  const fakePort: LLMPort = {
    async generateText(): Promise<GenerateTextResult> {
      const next = fakeQueue[qi++];
      if (!next) throw new Error("queue exhausted");
      return {
        text: next.text,
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: next.cost },
        modelId: "fake-model",
        providerAlias: "gpt5",
        latencyMs: 1,
      };
    },
    async generateStructured<T>(options: GenerateStructuredOptions<T>): Promise<GenerateStructuredResult<T>> {
      const parsed = options.schema.parse({ ok: true });
      return {
        data: parsed as T,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
        modelId: "fake-model",
        providerAlias: "gpt5",
        latencyMs: 1,
        validationAttempts: 1,
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamText() {
      yield "ok";
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamStructured() {
      yield {};
    },
    async runAgent(): Promise<AgentResult> {
      return {
        text: "",
        messages: [],
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
        modelId: "fake-model",
        providerAlias: "gpt5",
        latencyMs: 1,
        stepsTaken: 0,
        terminationReason: "completed",
      };
    },
  };

  const adapter: AdapterRegistration = {
    name: "fake",
    createLLMPort: () => fakePort,
    pricing: { "fake-model": { inputPer1M: 0, outputPer1M: 0 } },
  };

  return new Registry({
    env: opts.env,
    adapters: { fake: adapter },
    budget: new InMemoryBudget(),
    cost: new InMemoryCost(),
  });
}

void z; // keep zod import for the type-side schema use in fakePort.generateStructured.
