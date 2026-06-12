import { describe, expect, it } from "vitest";
import {
  computeChatCost,
  computeEmbeddingCost,
  InMemoryBudget,
  InMemoryCost,
  type ModelPricing,
} from "../src/index.js";

const HAIKU: ModelPricing = { inputPer1M: 0.8, outputPer1M: 4.0 };
const SONNET: ModelPricing = {
  inputPer1M: 3.0,
  outputPer1M: 15.0,
  cacheReadPer1M: 0.3,
  cacheWritePer1M: 3.75,
};
const EMBED: ModelPricing = { inputPer1M: 0, outputPer1M: 0, embeddingPer1M: 0.13 };

describe("computeChatCost", () => {
  it("computes cost from raw input/output tokens", () => {
    const cost = computeChatCost(
      { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 },
      HAIKU,
    );
    expect(cost.inputUSD).toBeCloseTo(0.8, 6);
    expect(cost.outputUSD).toBeCloseTo(2.0, 6);
    expect(cost.totalUSD).toBeCloseTo(2.8, 6);
  });

  it("applies cache pricing when cache tokens are present", () => {
    const cost = computeChatCost(
      {
        inputTokens: 100_000,
        outputTokens: 10_000,
        totalTokens: 110_000,
        cacheReadTokens: 80_000,
      },
      SONNET,
    );
    // regularInput = 100k - 80k = 20k @ $3 → $0.06
    // cacheRead = 80k @ $0.3 → $0.024
    // output = 10k @ $15 → $0.15
    expect(cost.totalUSD).toBeCloseTo(0.234, 6);
    expect(cost.cacheSavingsUSD).toBeGreaterThan(0);
  });
});

describe("computeEmbeddingCost", () => {
  it("uses embeddingPer1M when set", () => {
    const cost = computeEmbeddingCost(1_000_000, EMBED);
    expect(cost.inputUSD).toBeCloseTo(0.13, 6);
    expect(cost.outputUSD).toBe(0);
  });
});

describe("InMemoryBudget", () => {
  it("allows requests under the limit", async () => {
    const budget = new InMemoryBudget();
    const limit = { kind: "requests" as const, requestsPerHour: 5 };
    for (let i = 0; i < 5; i++) {
      const check = await budget.check("alpha", limit);
      expect(check.allowed).toBe(true);
      await budget.recordRequest("alpha");
    }
    const after = await budget.check("alpha", limit);
    expect(after.allowed).toBe(false);
  });

  it("treats unlimited as always allowed", async () => {
    const budget = new InMemoryBudget();
    for (let i = 0; i < 1000; i++) await budget.recordRequest("local");
    const check = await budget.check("local", { kind: "unlimited" });
    expect(check.allowed).toBe(true);
  });

  it("isolates counts per alias", async () => {
    const budget = new InMemoryBudget();
    const limit = { kind: "requests" as const, requestsPerHour: 1 };
    await budget.recordRequest("alpha");
    expect((await budget.check("alpha", limit)).allowed).toBe(false);
    expect((await budget.check("beta", limit)).allowed).toBe(true);
  });
});

describe("InMemoryCost", () => {
  it("blocks once perDay cap is exceeded", async () => {
    const cost = new InMemoryCost();
    const limit = { kind: "usd" as const, perDay: 1.0 };
    await cost.recordCost("premium", 0.6);
    expect((await cost.check("premium", limit)).allowed).toBe(true);
    await cost.recordCost("premium", 0.5);
    const check = await cost.check("premium", limit);
    expect(check.allowed).toBe(false);
    expect(check.current).toBeGreaterThan(1.0);
  });

  it("treats unlimited as always allowed", async () => {
    const cost = new InMemoryCost();
    await cost.recordCost("local", 999_999);
    const check = await cost.check("local", { kind: "unlimited" });
    expect(check.allowed).toBe(true);
  });

  it("enforces the most restrictive of multiple windows", async () => {
    const cost = new InMemoryCost();
    const limit = { kind: "usd" as const, perHour: 0.5, perDay: 100 };
    await cost.recordCost("premium", 0.6);
    const check = await cost.check("premium", limit);
    expect(check.allowed).toBe(false);
    // perHour was the tripping window
    expect(check.limit).toBe(0.5);
  });
});
