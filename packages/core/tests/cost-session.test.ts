/**
 * Tests for CostSession — session-scoped USD cap (issue #16).
 */

import { describe, expect, it } from "vitest";
import { CostSession } from "../src/registry/cost-session.js";
import { SessionBudgetExceededError } from "../src/errors.js";
import type {
  AgentResult,
  GenerateStructuredOptions,
  GenerateStructuredResult,
  GenerateTextOptions,
  GenerateTextResult,
  LLMPort,
  RunAgentOptions,
  StreamStructuredOptions,
  StreamTextOptions,
} from "../src/ports/llm-port.js";

function makeMockPort(costPerCall: number): LLMPort {
  const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 };
  const cost = { inputUSD: 0, outputUSD: 0, totalUSD: costPerCall };
  return {
    async generateText(_o: GenerateTextOptions): Promise<GenerateTextResult> {
      return {
        text: "ok",
        usage,
        cost,
        modelId: "test-model",
        providerAlias: "test",
        latencyMs: 1,
      };
    },
    async generateStructured<T>(
      _o: GenerateStructuredOptions<T>,
    ): Promise<GenerateStructuredResult<T>> {
      return {
        data: {} as T,
        usage,
        cost,
        modelId: "test-model",
        providerAlias: "test",
        latencyMs: 1,
        validationAttempts: 1,
      };
    },
    async *streamText(_o: StreamTextOptions): AsyncIterable<string> {
      yield "ok";
    },
    async *streamStructured<T>(
      _o: StreamStructuredOptions<T>,
    ): AsyncIterable<Partial<T>> {
      yield {} as Partial<T>;
    },
    async runAgent(_o: RunAgentOptions): Promise<AgentResult> {
      return {
        text: "ok",
        usage,
        cost,
        modelId: "test-model",
        providerAlias: "test",
        latencyMs: 1,
        toolCalls: [],
        stepsTaken: 1,
        terminationReason: "completed",
      };
    },
  };
}

describe("CostSession", () => {
  it("tracks cumulative spend across calls", async () => {
    const session = new CostSession(makeMockPort(0.001), { budgetUSD: 0.01 });
    const port = session.getPort();
    await port.generateText({ taskType: "t", prompt: "hi" });
    await port.generateText({ taskType: "t", prompt: "hi" });
    await port.generateText({ taskType: "t", prompt: "hi" });
    expect(session.totalSpentUSD()).toBeCloseTo(0.003, 6);
    expect(session.remainingUSD()).toBeCloseTo(0.007, 6);
  });

  it("throws SessionBudgetExceededError when the next call would exceed the cap", async () => {
    // Budget allows 5 calls at $0.0011 each → 6th call should fail.
    const session = new CostSession(makeMockPort(0.0011), { budgetUSD: 0.005 });
    const port = session.getPort();
    await port.generateText({ taskType: "t", prompt: "hi" });
    await port.generateText({ taskType: "t", prompt: "hi" });
    await port.generateText({ taskType: "t", prompt: "hi" });
    await port.generateText({ taskType: "t", prompt: "hi" });
    await port.generateText({ taskType: "t", prompt: "hi" });
    // Spent ~$0.0055; over budget.
    await expect(port.generateText({ taskType: "t", prompt: "hi" })).rejects.toThrow(
      SessionBudgetExceededError,
    );
  });

  it("does NOT execute the over-budget call against the underlying port", async () => {
    let called = 0;
    const mock: LLMPort = makeMockPort(1.0); // each call would cost $1
    const traced = new Proxy(mock, {
      get(target, prop) {
        if (prop === "generateText") {
          return async (o: GenerateTextOptions) => {
            called++;
            return target.generateText(o);
          };
        }
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    });
    const session = new CostSession(traced, { budgetUSD: 0.5 });
    const port = session.getPort();
    await expect(port.generateText({ taskType: "t", prompt: "hi" })).resolves.toBeDefined();
    expect(called).toBe(1);
    // Second call: budget already exhausted ($1 > $0.50). Should throw BEFORE calling.
    await expect(port.generateText({ taskType: "t", prompt: "hi" })).rejects.toThrow(
      SessionBudgetExceededError,
    );
    expect(called).toBe(1); // underlying was NOT called the second time
  });

  it("close() returns total spent and prevents further calls", async () => {
    const session = new CostSession(makeMockPort(0.002), { budgetUSD: 1 });
    const port = session.getPort();
    await port.generateText({ taskType: "t", prompt: "hi" });
    await port.generateText({ taskType: "t", prompt: "hi" });
    const total = session.close();
    expect(total).toBeCloseTo(0.004, 6);
    await expect(port.generateText({ taskType: "t", prompt: "hi" })).rejects.toThrow(/closed/i);
  });

  it("uses caller-supplied sessionId when provided", () => {
    const session = new CostSession(makeMockPort(0), {
      budgetUSD: 1,
      sessionId: "screen-cap-abc-123",
    });
    expect(session.id).toBe("screen-cap-abc-123");
  });

  it("auto-generates session id when not supplied", () => {
    const session = new CostSession(makeMockPort(0), { budgetUSD: 1 });
    expect(session.id).toMatch(/^cs-/);
  });

  it("rejects non-positive budgetUSD", () => {
    expect(() => new CostSession(makeMockPort(0), { budgetUSD: 0 })).toThrow(/positive finite/i);
    expect(() => new CostSession(makeMockPort(0), { budgetUSD: -1 })).toThrow(/positive finite/i);
    expect(() => new CostSession(makeMockPort(0), { budgetUSD: NaN })).toThrow(/positive finite/i);
  });

  it("SessionBudgetExceededError carries sessionId + budgetUSD + spentUSD", async () => {
    const session = new CostSession(makeMockPort(0.5), {
      budgetUSD: 0.3,
      sessionId: "test-session",
    });
    const port = session.getPort();
    await port.generateText({ taskType: "t", prompt: "hi" });
    try {
      await port.generateText({ taskType: "t", prompt: "hi" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionBudgetExceededError);
      const e = err as SessionBudgetExceededError;
      expect(e.sessionId).toBe("test-session");
      expect(e.budgetUSD).toBe(0.3);
      expect(e.spentUSD).toBeCloseTo(0.5, 6);
    }
  });

  it("runAgent calls are tracked the same way as generateText", async () => {
    // Budget $0.25; each agent call costs $0.1.
    // Pre-check semantics: check fires when spentUSD ALREADY >= budgetUSD.
    //  Call 1: pre-check spent=0 → ok; after: spent=0.1
    //  Call 2: pre-check spent=0.1 → ok; after: spent=0.2
    //  Call 3: pre-check spent=0.2 → ok; after: spent=0.3 (overshoot by $0.05)
    //  Call 4: pre-check spent=0.3 >= 0.25 → THROW
    const session = new CostSession(makeMockPort(0.1), { budgetUSD: 0.25 });
    const port = session.getPort();
    const agentArgs = {
      taskType: "t",
      instructions: "do it",
      messages: [{ role: "user" as const, content: "go" }],
      tools: {},
      maxSteps: 1,
    };
    await port.runAgent(agentArgs);
    await port.runAgent(agentArgs);
    await port.runAgent(agentArgs);
    expect(session.totalSpentUSD()).toBeCloseTo(0.3, 6);
    await expect(port.runAgent(agentArgs)).rejects.toThrow(SessionBudgetExceededError);
  });
});
