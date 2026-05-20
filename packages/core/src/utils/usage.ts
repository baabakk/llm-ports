/**
 * Token-usage helpers shared across adapters.
 *
 * Each adapter has its own `parseUsage(response)` because provider response
 * shapes differ. But once parsed into a `TokenUsage` value, the math (adding
 * usage across multiple turns of an agent loop, or across multiple retries
 * of a structured-output call) is identical.
 *
 * Hoisted from per-adapter copies in alpha.3.
 */

import type { TokenUsage } from "../ports/llm-port.js";

/**
 * Add two `TokenUsage` values. Preserves the optional `cacheReadTokens` and
 * `reasoningTokens` fields when at least one operand has them.
 *
 * Used by adapters in `runAgent` (each tool-use step contributes usage) and
 * in `generateStructured` (when retry-with-feedback fires; each attempt
 * contributes usage).
 */
export function mergeTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const hasCacheRead = a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined;
  const hasCacheWrite = a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined;
  const hasReasoning = a.reasoningTokens !== undefined || b.reasoningTokens !== undefined;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(hasCacheRead
      ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }
      : {}),
    ...(hasCacheWrite
      ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) }
      : {}),
    ...(hasReasoning
      ? { reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) }
      : {}),
  };
}
