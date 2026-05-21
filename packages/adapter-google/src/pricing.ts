/**
 * Bundled pricing for Google Gemini models.
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing (verified 2026-05).
 * Override per model via `pricingOverrides` on the adapter options.
 *
 * Gemini pricing has separate tiers for prompts under 200k tokens vs over
 * 200k tokens (the "long-context premium"). The bundled values are the
 * UNDER-200k-token rates, which dominate typical usage. For long-context
 * workloads, supply `pricingOverrides` with the over-200k rates.
 */

import type { ModelPricing } from "@llm-ports/core";

export const GEMINI_PRICING: Record<string, ModelPricing> = {
  // Gemini 2.5 family (2026-05 GA pricing)
  "gemini-2.5-pro": {
    inputPer1M: 1.25,
    outputPer1M: 5.0,
    cacheReadPer1M: 0.3125,
  },
  "gemini-2.5-flash": {
    inputPer1M: 0.075,
    outputPer1M: 0.3,
    cacheReadPer1M: 0.01875,
  },
  "gemini-2.5-flash-lite": {
    inputPer1M: 0.0375,
    outputPer1M: 0.15,
    cacheReadPer1M: 0.009375,
  },
  // Gemini 2.0 family (still available)
  "gemini-2.0-flash": {
    inputPer1M: 0.1,
    outputPer1M: 0.4,
    cacheReadPer1M: 0.025,
  },
  "gemini-2.0-flash-lite": {
    inputPer1M: 0.075,
    outputPer1M: 0.3,
  },
};

export function lookupGeminiPricing(modelId: string): ModelPricing | undefined {
  return GEMINI_PRICING[modelId];
}
