/**
 * Anthropic Claude model pricing (USD per 1M tokens).
 *
 * Source: https://docs.anthropic.com/en/docs/about-claude/pricing
 * Last verified: 2026-05-26 by @baabakk
 *
 * Update process: edit this file, bump the "Last verified" date, open a PR
 * with the source URL referenced. Changeset patch bump on adapter-anthropic.
 *
 * Users can override these via the registry's `pricingOverrides` option.
 */

import type { ModelPricing } from "@llm-ports/core";

export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  // Claude Opus 4.x family
  "claude-opus-4-7": {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheReadPer1M: 1.5,
    cacheWritePer1M: 18.75,
  },
  "claude-opus-4": {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheReadPer1M: 1.5,
    cacheWritePer1M: 18.75,
  },

  // Claude Sonnet 4.x family
  "claude-sonnet-4-6-20250514": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
  },
  "claude-sonnet-4-5": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
  },

  // Claude Haiku 4.x family
  "claude-haiku-4-5": {
    inputPer1M: 0.8,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.08,
    cacheWritePer1M: 1.0,
  },
  "claude-haiku-4-5-20251001": {
    inputPer1M: 0.8,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.08,
    cacheWritePer1M: 1.0,
  },
};

/** Lookup with case-insensitive fallback for users who pass slightly different ids. */
export function lookupAnthropicPricing(modelId: string): ModelPricing | undefined {
  return ANTHROPIC_PRICING[modelId] ?? ANTHROPIC_PRICING[modelId.toLowerCase()];
}
