/**
 * Bundled pricing for the OpenAI / Anthropic / Google models commonly used
 * through Vercel AI SDK's `@ai-sdk/openai`, `@ai-sdk/anthropic`, and
 * `@ai-sdk/google` packages. Values mirror the direct adapters' bundled
 * tables (`OPENAI_PRICING`, `ANTHROPIC_PRICING`, `GEMINI_PRICING`) since the
 * underlying providers charge the same per-model rates regardless of SDK
 * layering.
 *
 * Why this exists: pre-alpha.8 the Vercel adapter required users to supply
 * a `pricing` map themselves — inconsistent with the other adapters which
 * ship pricing tables. For the most common `@ai-sdk/*` provider combinations,
 * we now default to the matching direct-adapter table.
 *
 * Coverage caveats:
 *   - This is opt-in via `createVercelAdapter({ pricing: VERCEL_PRICING })`
 *     OR auto-merged when the user supplies `pricingOverrides` (just like
 *     the direct adapters' merge pattern).
 *   - Vercel's `@ai-sdk/*` ecosystem is broader than ours — LMStudio,
 *     OpenRouter, perplexity-ai, and others aren't in this table. For
 *     those, users still need to supply pricing.
 *   - Pricing source: official provider pricing pages, verified 2026-05.
 */

import type { ModelPricing } from "@llm-ports/core";

export const VERCEL_PRICING: Record<string, ModelPricing> = {
  // ─── OpenAI (via @ai-sdk/openai) ─────────────────────────────────
  "gpt-5": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-5-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.2 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  o3: { inputPer1M: 15.0, outputPer1M: 60.0 },
  "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },

  // ─── Anthropic (via @ai-sdk/anthropic) ───────────────────────────
  "claude-opus-4-5": {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheReadPer1M: 1.5,
    cacheWritePer1M: 18.75,
  },
  "claude-sonnet-4-6-20250514": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
  },
  "claude-haiku-4-5": {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    cacheReadPer1M: 0.1,
    cacheWritePer1M: 1.25,
  },

  // ─── Google Gemini (via @ai-sdk/google) ───────────────────────────
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 5.0, cacheReadPer1M: 0.3125 },
  "gemini-2.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3, cacheReadPer1M: 0.01875 },
  "gemini-2.5-flash-lite": {
    inputPer1M: 0.0375,
    outputPer1M: 0.15,
    cacheReadPer1M: 0.009375,
  },
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4, cacheReadPer1M: 0.025 },
  "gemini-2.0-flash-lite": { inputPer1M: 0.075, outputPer1M: 0.3 },
};

export function lookupVercelPricing(modelId: string): ModelPricing | undefined {
  return VERCEL_PRICING[modelId];
}
