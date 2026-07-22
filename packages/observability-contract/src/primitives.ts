/**
 * Shared primitive shapes carried by observability event payloads.
 *
 * These mirror the runtime shapes in @llm-ports/core (`TokenUsage`,
 * `CostUsage`) but are defined here as standalone types so this package
 * has no core dependency (Plan 58 v0.4 §4.13 standalone data contract
 * commitment). Consumers routing through the port find the same shape
 * on the port's return types.
 */

/**
 * Token accounting for a single LLM attempt or an aggregate operation.
 * All fields are counts of tokens (integer, non-negative).
 */
export interface TokenUsage {
  /** Prompt / input tokens counted by the provider on the request side. */
  inputTokens: number;

  /** Completion / output tokens counted by the provider on the response side. */
  outputTokens: number;

  /**
   * Convenience `inputTokens + outputTokens`. Providers rarely report a
   * separate total; consumers may compute it client-side.
   */
  totalTokens: number;

  /**
   * Reasoning-model output tokens (thinking tokens) when the provider
   * exposes them separately. Included in `outputTokens` when present.
   */
  reasoningTokens?: number;

  /**
   * Tokens billed at the cache-read rate (Anthropic `cache_read_input_tokens`,
   * OpenAI `cached_tokens`, Google `cachedContentTokenCount`). Included
   * in `inputTokens` when present.
   */
  cachedInputTokens?: number;
}

/**
 * Cost in USD for a single attempt or an aggregate operation. Adapters
 * multiply token counts by pricing tables to produce these values.
 */
export interface CostUsage {
  /** USD cost for input tokens (including cached read discount). */
  inputUSD: number;

  /** USD cost for output tokens (including reasoning surcharge). */
  outputUSD: number;

  /** `inputUSD + outputUSD`. */
  totalUSD: number;

  /**
   * Optional: how much cost was saved by the cache-read discount vs.
   * the counterfactual uncached rate. When present, `totalUSD` is the
   * actual billed amount; `savingsUSD` is the reduction from what an
   * uncached call would have cost.
   */
  savingsUSD?: number;
}

/**
 * The "priority" hint on an LLM call. Higher priority calls bypass some
 * gating layers (session budget caps, cost gates). Consumers with SLO
 * requirements set this; observability events carry the value verbatim.
 */
export type LLMPriority = 0 | 1 | 2 | 3;
