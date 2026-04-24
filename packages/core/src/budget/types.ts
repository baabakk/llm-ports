/**
 * Budget and cost gating types.
 *
 * Two pluggable backends, both optional. Most production users will use
 * the in-memory implementation in dev and a Redis-backed one (in a separate
 * package) in production.
 *
 * See implementation plan v3 §6.6.
 */

// ─── Budget (request-count) gating ───────────────────────────────────

export type BudgetLimit =
  | { kind: "requests"; requestsPerHour: number }
  | { kind: "unlimited" };

export interface BudgetCheckResult {
  allowed: boolean;
  /** Current request count in the active window. */
  current: number;
  /** Limit value (Infinity if unlimited). */
  limit: number;
  /** Reason populated when allowed=false. */
  reason?: string;
}

export interface BudgetBackend {
  /** Increment the request counter for this provider alias. */
  recordRequest(alias: string): Promise<void>;
  /** Check whether another request would exceed the configured limit. */
  check(alias: string, limit: BudgetLimit): Promise<BudgetCheckResult>;
}

// ─── Cost (USD) gating ───────────────────────────────────────────────

export type CostLimit =
  | {
      kind: "usd";
      /** USD ceiling per rolling hour. */
      perHour?: number;
      /** USD ceiling per rolling day (24h). */
      perDay?: number;
      /** USD ceiling per rolling 30-day window. */
      perMonth?: number;
    }
  | { kind: "unlimited" };

export interface CostCheckResult {
  allowed: boolean;
  /** Current spend in the most-restrictive active window, in USD. */
  current: number;
  /** Limit value in USD (Infinity if unlimited). */
  limit: number;
  reason?: string;
}

export interface CostBackend {
  /** Add USD cost to this provider alias's running totals. */
  recordCost(alias: string, usd: number): Promise<void>;
  /** Check whether another request would exceed any configured cost ceiling. */
  check(alias: string, limit: CostLimit): Promise<CostCheckResult>;
}

// ─── Per-model pricing tables ────────────────────────────────────────

/**
 * Pricing for one model, in USD per 1M tokens.
 * Adapters ship pricing tables in `pricing.ts`; users override via registry config.
 */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Anthropic-style prompt caching read price (typically much lower). */
  cacheReadPer1M?: number;
  /** Anthropic-style prompt caching write price. */
  cacheWritePer1M?: number;
  /** Embedding-only models: cost per 1M input tokens (no output). */
  embeddingPer1M?: number;
}
