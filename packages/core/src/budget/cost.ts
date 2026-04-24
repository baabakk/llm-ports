/**
 * Cost computation: convert TokenUsage + ModelPricing → CostUsage.
 *
 * Adapters call this after every LLM request to compute the dollar cost
 * of the call from token counts and the model's pricing entry. The result
 * goes into both the result object (for caller observability) and the
 * CostBackend (for budget enforcement).
 */

import type { CostUsage, TokenUsage } from "../ports/llm-port.js";
import type { ModelPricing } from "./types.js";

const PER_1M = 1_000_000;

/**
 * Compute USD cost for a chat/text completion call.
 * Cache reads (Anthropic feature) are billed at the discounted rate when present.
 */
export function computeChatCost(usage: TokenUsage, pricing: ModelPricing): CostUsage {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  // Regular input tokens are total input minus what was satisfied from cache reads
  // and what was committed as cache writes. Adapters typically already report this
  // breakdown correctly; if not, regularInput falls back to inputTokens.
  const regularInput = Math.max(0, usage.inputTokens - cacheReadTokens - cacheWriteTokens);

  const inputUSD = (regularInput * pricing.inputPer1M) / PER_1M;
  const outputUSD = (usage.outputTokens * pricing.outputPer1M) / PER_1M;
  const cacheReadUSD = ((pricing.cacheReadPer1M ?? pricing.inputPer1M) * cacheReadTokens) / PER_1M;
  const cacheWriteUSD = ((pricing.cacheWritePer1M ?? pricing.inputPer1M) * cacheWriteTokens) / PER_1M;

  // The "discount" is what the user saved by hitting cache vs paying full input rate.
  const cacheDiscountUSD =
    cacheReadTokens > 0
      ? (pricing.inputPer1M - (pricing.cacheReadPer1M ?? pricing.inputPer1M)) * (cacheReadTokens / PER_1M)
      : undefined;

  const totalUSD = inputUSD + outputUSD + cacheReadUSD + cacheWriteUSD;

  return {
    inputUSD: round6(inputUSD + cacheReadUSD + cacheWriteUSD),
    outputUSD: round6(outputUSD),
    totalUSD: round6(totalUSD),
    ...(cacheDiscountUSD !== undefined ? { cacheDiscountUSD: round6(cacheDiscountUSD) } : {}),
  };
}

/** Compute USD cost for an embedding call (input tokens only). */
export function computeEmbeddingCost(inputTokens: number, pricing: ModelPricing): CostUsage {
  const ratePer1M = pricing.embeddingPer1M ?? pricing.inputPer1M;
  const inputUSD = (inputTokens * ratePer1M) / PER_1M;
  return {
    inputUSD: round6(inputUSD),
    outputUSD: 0,
    totalUSD: round6(inputUSD),
  };
}

/** Round to 6 decimals; sufficient precision for fractions of a cent. */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
