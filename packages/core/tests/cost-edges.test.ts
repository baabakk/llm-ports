/**
 * Group G — cost-math edge cases.
 *
 * Pins the cost-precision and pricing-flow corner cases that bit us during
 * Phase 2 and that a future refactor could silently regress:
 *   - Cache read tokens reduce cost via cacheReadPer1M
 *   - Reasoning tokens (subset of outputTokens) billed at output rate
 *   - Embedding cost with split inputPer1M=0 / embeddingPer1M=0.02
 *   - Tiny costs (<1e-6 USD) preserved at 10-decimal precision
 *   - Cache discount math
 */

import { describe, expect, it } from "vitest";
import {
  computeChatCost,
  computeEmbeddingCost,
  type ModelPricing,
} from "../src/index.js";

const SONNET: ModelPricing = {
  inputPer1M: 3.0,
  outputPer1M: 15.0,
  cacheReadPer1M: 0.3,
  cacheWritePer1M: 3.75,
};
const NANO: ModelPricing = { inputPer1M: 0.05, outputPer1M: 0.2 };
const EMBED_SPLIT: ModelPricing = {
  inputPer1M: 0,
  outputPer1M: 0,
  embeddingPer1M: 0.02,
};

describe("Group G: cost-math edges", () => {
  it("cache reads reduce total cost via cacheReadPer1M, not inputPer1M", () => {
    const noCache = computeChatCost(
      { inputTokens: 100_000, outputTokens: 1000, totalTokens: 101_000 },
      SONNET,
    );
    const withCache = computeChatCost(
      {
        inputTokens: 100_000,
        outputTokens: 1000,
        totalTokens: 101_000,
        cacheReadTokens: 80_000,
      },
      SONNET,
    );
    // 80k cache reads at $0.30 instead of $3.00 saves (3.0 - 0.3) * 0.08 = $0.216
    expect(noCache.totalUSD - withCache.totalUSD).toBeCloseTo(0.216, 6);
    expect(withCache.cacheDiscountUSD).toBeCloseTo(0.216, 6);
  });

  it("reasoning tokens are billed at output rate (they're a subset of outputTokens)", () => {
    // Cost math should NOT double-count reasoning tokens. They're already
    // included in outputTokens; reasoningTokens is just informational breakdown.
    const cost = computeChatCost(
      {
        inputTokens: 10,
        outputTokens: 100, // includes 90 reasoning + 10 visible
        totalTokens: 110,
        reasoningTokens: 90,
      },
      NANO,
    );
    // 100 output × $0.20/1M = $0.00002, NOT 100 + 90 = 190
    expect(cost.outputUSD).toBeCloseTo(0.00002, 10);
    expect(cost.totalUSD).toBeCloseTo(10 * 0.05 / 1e6 + 100 * 0.2 / 1e6, 10);
  });

  it("embedding cost with inputPer1M=0 and embeddingPer1M=0.02 returns positive value", () => {
    const cost = computeEmbeddingCost(1_000_000, EMBED_SPLIT);
    expect(cost.totalUSD).toBeCloseTo(0.02, 6);
    expect(cost.inputUSD).toBeCloseTo(0.02, 6);
    expect(cost.outputUSD).toBe(0);
  });

  it("tiny costs (5 tokens × $0.02/1M = $1e-7) preserved, not rounded to 0", () => {
    // The bug we discovered in Phase 2: with 6-decimal precision,
    // computeEmbeddingCost(5, {embeddingPer1M: 0.02}) returns 0.
    // After bumping to 10-decimal precision, it returns 1e-7.
    const cost = computeEmbeddingCost(5, EMBED_SPLIT);
    expect(cost.totalUSD).toBeGreaterThan(0);
    expect(cost.totalUSD).toBeCloseTo(1e-7, 11);
  });

  it("zero tokens → zero cost, no NaN, no negative", () => {
    const cost = computeChatCost(
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      SONNET,
    );
    expect(cost.inputUSD).toBe(0);
    expect(cost.outputUSD).toBe(0);
    expect(cost.totalUSD).toBe(0);
  });
});
