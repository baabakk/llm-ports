/**
 * OpenAI model pricing (USD per 1M tokens).
 *
 * Source: https://openai.com/api/pricing/
 * Last verified: 2026-04-10 by @baabakk
 *
 * Update process: edit this file, bump the "Last verified" date, open a PR
 * with the source URL referenced. Changeset patch bump on adapter-openai.
 *
 * Users can override these via the registry's `pricingOverrides` option,
 * which is the daily-use escape hatch when prices change between releases
 * or when an enterprise has negotiated rates.
 *
 * Note: This same adapter serves OpenAI-compatible providers (Groq, Together
 * AI, Fireworks, DeepInfra, Perplexity, Cerebras, LiteLLM proxy, etc.) via
 * the `baseURL` option. Those providers have their own pricing — supply it
 * via `pricingOverrides`.
 */

import type { ModelPricing } from "@llm-ports/core";

// Note: this table contains pricing only — no capability flags.
//
// Why no hardcoded capabilities: OpenAI does not expose programmatic
// capability discovery (the `/v1/models` endpoint returns names + ownership,
// no schema for "which params does this model accept"). A hardcoded list of
// "gpt-5-nano is reasoning, gpt-4o is standard" goes stale every time
// OpenAI ships a new model. Instead, the adapter discovers constraints at
// runtime: it catches the specific OpenAI error (e.g. `unsupported_value`
// for `temperature`), learns the constraint, and remembers it for the rest
// of the process so subsequent calls don't pay the discovery cost.
//
// Users who already know their model's constraints and want to skip
// discovery can still supply `capabilities` via pricingOverrides — that's
// what the field is for.

export const OPENAI_PRICING: Record<string, ModelPricing> = {
  // GPT-5 family
  "gpt-5": {
    inputPer1M: 2.5,
    outputPer1M: 10.0,
    cacheReadPer1M: 0.25,
  },
  "gpt-5-mini": {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    cacheReadPer1M: 0.075,
  },
  "gpt-5-nano": {
    inputPer1M: 0.05,
    outputPer1M: 0.2,
    cacheReadPer1M: 0.025,
  },

  // GPT-4o family
  "gpt-4o": {
    inputPer1M: 2.5,
    outputPer1M: 10.0,
    cacheReadPer1M: 1.25,
  },
  "gpt-4o-mini": {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    cacheReadPer1M: 0.075,
  },
  "gpt-4o-audio-preview": {
    inputPer1M: 2.5,
    outputPer1M: 10.0,
  },

  // o-series reasoning models
  "o3": {
    inputPer1M: 15.0,
    outputPer1M: 60.0,
    cacheReadPer1M: 7.5,
  },
  "o3-mini": {
    inputPer1M: 1.1,
    outputPer1M: 4.4,
    cacheReadPer1M: 0.55,
  },

  // Embeddings
  "text-embedding-3-small": {
    inputPer1M: 0,
    outputPer1M: 0,
    embeddingPer1M: 0.02,
  },
  "text-embedding-3-large": {
    inputPer1M: 0,
    outputPer1M: 0,
    embeddingPer1M: 0.13,
  },
};

export function lookupOpenAIPricing(modelId: string): ModelPricing | undefined {
  return OPENAI_PRICING[modelId] ?? OPENAI_PRICING[modelId.toLowerCase()];
}
