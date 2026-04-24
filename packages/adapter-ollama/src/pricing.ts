/**
 * Ollama "pricing" — local models incur no API cost.
 *
 * Every model that runs on a local Ollama daemon is priced at $0/1M tokens.
 * This is the right default; users who want to track GPU time as an internal
 * cost can override via the registry's `pricingOverrides`.
 *
 * Why the table exists at all: the registry requires a ModelPricing entry
 * for any model id passed through it. Returning zeros lets cost-based gating
 * still work consistently across local and cloud providers — local just never
 * trips the gate. Without entries here, the registry would refuse the model.
 *
 * Common Ollama model ids you might use:
 *   llama3.3, llama3.3:70b, llama3.2, qwen2.5, qwen2.5:32b,
 *   mistral, mistral-small, codellama, deepseek-r1, deepseek-coder,
 *   phi-3, gemma2, nomic-embed-text, mxbai-embed-large
 *
 * The catch-all default is applied to any model id not in the explicit list,
 * so users don't have to maintain pricing entries for every Ollama model
 * they pull.
 */

import type { ModelPricing } from "@llm-ports/core";

const ZERO: ModelPricing = {
  inputPer1M: 0,
  outputPer1M: 0,
  embeddingPer1M: 0,
};

/** Catch-all pricing applied to any model id (override per-model if needed). */
export const OLLAMA_DEFAULT_PRICING: ModelPricing = ZERO;

/** Explicit entries are optional; included for clarity / IDE autocomplete. */
export const OLLAMA_PRICING: Record<string, ModelPricing> = {
  "llama3.3": ZERO,
  "llama3.3:70b": ZERO,
  "llama3.2": ZERO,
  "qwen2.5": ZERO,
  "qwen2.5:32b": ZERO,
  "mistral": ZERO,
  "mistral-small": ZERO,
  "codellama": ZERO,
  "deepseek-r1": ZERO,
  "deepseek-coder": ZERO,
  "phi-3": ZERO,
  "gemma2": ZERO,
  "nomic-embed-text": ZERO,
  "mxbai-embed-large": ZERO,
};

export function lookupOllamaPricing(modelId: string): ModelPricing {
  return OLLAMA_PRICING[modelId] ?? OLLAMA_DEFAULT_PRICING;
}
