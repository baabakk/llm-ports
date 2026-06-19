/**
 * Cross-adapter observability hooks (alpha.21+).
 *
 * Five fire-and-forget hooks aligned with the OpenTelemetry `gen_ai.*`
 * semantic-conventions taxonomy so downstream pipelines (Honeycomb, Datadog,
 * OTel Collector, custom OTLP exporters) can map them onto spans + metrics
 * without re-deriving fields.
 *
 *   - onCost            : fires after every billable call with a cost breakdown
 *   - onTokenUsage      : fires after every billable call with token counts
 *   - onFallback        : fires when the Registry chain advances to the next provider
 *   - onValidationRetry : fires when retry-with-feedback round-trips on structured output
 *   - onCacheHit        : fires when the provider reports cache hits (cached_tokens > 0)
 *
 * All hooks are sync OR async, called fire-and-forget, with hook errors
 * swallowed. Same contract as the existing `OnRetry` hook (alpha.17+).
 *
 * Why these five hooks and not others?
 *
 *   - Cost and token usage answer "what did this turn me?" — the two most-
 *     asked-for observability signals in production LLM systems.
 *   - Fallback answers "did my primary provider hold up?" — the signal that
 *     drives chain reconfiguration and SLO regression alerts.
 *   - Validation retry answers "was my schema healthy?" — the signal that
 *     surfaces schema drift and provider degradation before cost spikes.
 *   - Cache hit answers "did my prompt-engineering work?" — the signal that
 *     tells you whether `cacheControl` / `prompt_cache_key` are actually firing.
 *
 * The existing `OnRetry` hook (transient-auth, capability-fallback,
 * reasoning-starvation, validation-feedback) stays as-is — it covers the
 * "adapter decided to retry" surface. The new hooks cover the "Registry
 * decided to move on" and "call result is interesting" surfaces, which
 * OnRetry doesn't observe.
 */

import type { TokenUsage, CostUsage } from "./ports/llm-port.js";
import type { BudgetScopeRef } from "./budget/types.js";

/** Cause of a Registry-level fallback advancement. */
export type FallbackCause =
  /** The primary provider raised an error (budget exhausted, 401, 5xx, transient). */
  | "provider-error"
  /** A budget gate (req/min, cost/day, etc.) denied the call on the primary. */
  | "budget-exhausted"
  /** Structured output validation exhausted retries; chain advances to a fallback model. */
  | "validation-exhausted"
  /** The primary returned an empty response after starvation retries gave up. */
  | "empty-response"
  /** The primary's circuit breaker is open. */
  | "circuit-open";

/** Trigger for `onValidationRetry`. */
export type ValidationRetryCause =
  /** The model returned valid JSON that failed Zod validation. Retry with feedback. */
  | "schema-mismatch"
  /** The model returned non-JSON text. Retry with stricter prompt. */
  | "parse-error";

// ─── Event shapes ────────────────────────────────────────────────────

/** OnCost event: per-call cost breakdown. */
export interface CostEvent {
  /** USD spent on input tokens for this call. */
  promptUsd: number;
  /** USD spent on output tokens for this call. */
  completionUsd: number;
  /** USD spent on cache-read tokens (when the provider has a discounted tier). */
  cacheReadUsd?: number;
  /** USD spent on cache-write tokens (Anthropic-style explicit-cache providers). */
  cacheWriteUsd?: number;
  /** USD spent on reasoning tokens (hidden chain-of-thought billed separately). */
  reasoningUsd?: number;
  /** Total USD for this single call. */
  totalUsd: number;
  /** Model that produced the result (may differ from requested when the model serves under an alias). */
  modelId: string;
  /** Adapter alias used (the Registry-side name, e.g. `gptoss-cerebras`). */
  providerAlias: string;
  /** Operation kind. */
  operation: "generateText" | "generateStructured" | "streamText" | "streamStructured" | "runAgent" | "embed" | "rerank";
  /** Optional task-type tag from the call site. */
  taskType?: string;
  /** Optional scope hint passed by the caller for downstream attribution. */
  budgetScope?: BudgetScopeRef;
}

/** OnTokenUsage event: per-call token counts (raw, before cost monetization). */
export interface TokenUsageEvent {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  modelId: string;
  providerAlias: string;
  operation: CostEvent["operation"];
  taskType?: string;
  budgetScope?: BudgetScopeRef;
}

/** OnFallback event: chain advanced to the next provider. */
export interface FallbackEvent {
  /** The alias the call was originally routed to. */
  fromAlias: string;
  /** The alias the call was reassigned to. */
  toAlias: string;
  /** Why the chain advanced. */
  cause: FallbackCause;
  /** Operation kind. */
  operation: CostEvent["operation"];
  /** Optional task type for grouping in observability stacks. */
  taskType?: string;
  /** The error or signal that triggered the advancement, when applicable. */
  reason?: unknown;
}

/** OnValidationRetry event: retry-with-feedback round-trip on structured output. */
export interface ValidationRetryEvent {
  /** 0-indexed retry number (0 = first retry after the initial call). */
  attempt: number;
  /** Maximum attempts the adapter is configured to make in total. */
  maxAttempts: number;
  modelId: string;
  providerAlias: string;
  /** Why this retry fired. */
  cause: ValidationRetryCause;
  /** Validation issues (Zod issues, parse error message, etc.). */
  issues?: unknown;
  /** Operation kind. */
  operation: "generateStructured" | "streamStructured";
}

/** OnCacheHit event: provider reported cached prompt tokens. */
export interface CacheHitEvent {
  /** Tokens served from cache (matches the provider's `cached_tokens` field). */
  cachedTokens: number;
  /** Total input tokens this call would have billed without the cache hit. */
  inputTokensTotal: number;
  /** Computed hit ratio = cachedTokens / inputTokensTotal. */
  hitRatio: number;
  /** USD saved by the cache hit. Only populated when the provider has a discounted cache-read tier. */
  savingsUsd?: number;
  modelId: string;
  providerAlias: string;
  operation: CostEvent["operation"];
  taskType?: string;
}

// ─── Hook function types ─────────────────────────────────────────────

/** Fired after every billable call with cost breakdown. Fire-and-forget. */
export type OnCost = (event: CostEvent) => void | Promise<void>;

/** Fired after every billable call with raw token counts. Fire-and-forget. */
export type OnTokenUsage = (event: TokenUsageEvent) => void | Promise<void>;

/** Fired when the Registry's provider chain advances. Fire-and-forget. */
export type OnFallback = (event: FallbackEvent) => void | Promise<void>;

/** Fired when retry-with-feedback round-trips on structured output. Fire-and-forget. */
export type OnValidationRetry = (event: ValidationRetryEvent) => void | Promise<void>;

/** Fired when the provider reports cache hits. Fire-and-forget. */
export type OnCacheHit = (event: CacheHitEvent) => void | Promise<void>;

/**
 * Bundle of optional observability hooks passed at Registry construction
 * (alpha.21+). Each field is independently optional; pass only the ones the
 * downstream pipeline needs.
 */
export interface ObservabilityHooks {
  onCost?: OnCost;
  onTokenUsage?: OnTokenUsage;
  onFallback?: OnFallback;
  onValidationRetry?: OnValidationRetry;
  onCacheHit?: OnCacheHit;
}

// ─── Emit helpers ────────────────────────────────────────────────────
//
// Each emit helper is fire-and-forget with hook errors swallowed. Same
// contract as `emitRetryEvent` in retry-emit.ts.

function safeEmit<T>(hook: ((event: T) => void | Promise<void>) | undefined, event: T): void {
  if (!hook) return;
  try {
    const result = hook(event);
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch(() => {
        // Swallow async hook errors. Hooks are observability only;
        // never let them break the call.
      });
    }
  } catch {
    // Swallow sync hook errors.
  }
}

export function emitCost(hook: OnCost | undefined, event: CostEvent): void {
  safeEmit(hook, event);
}

export function emitTokenUsage(hook: OnTokenUsage | undefined, event: TokenUsageEvent): void {
  safeEmit(hook, event);
}

export function emitFallback(hook: OnFallback | undefined, event: FallbackEvent): void {
  safeEmit(hook, event);
}

export function emitValidationRetry(hook: OnValidationRetry | undefined, event: ValidationRetryEvent): void {
  safeEmit(hook, event);
}

export function emitCacheHit(hook: OnCacheHit | undefined, event: CacheHitEvent): void {
  safeEmit(hook, event);
}

/**
 * Compute cache-hit metadata from a TokenUsage. Returns null when the usage
 * has no cache hit to emit (cachedInputTokens missing or 0). Adapters call
 * this after a successful call to determine whether to emit `onCacheHit`.
 */
export function deriveCacheHit(usage: TokenUsage, cost: CostUsage | undefined): {
  cachedTokens: number;
  inputTokensTotal: number;
  hitRatio: number;
  savingsUsd?: number;
} | null {
  const cached = usage.cacheReadTokens ?? 0;
  if (cached <= 0) return null;
  const total = usage.inputTokens || 0;
  const hitRatio = total > 0 ? cached / total : 0;
  if (cost && cost.cacheSavingsUSD !== undefined) {
    return {
      cachedTokens: cached,
      inputTokensTotal: total,
      hitRatio,
      savingsUsd: cost.cacheSavingsUSD,
    };
  }
  return {
    cachedTokens: cached,
    inputTokensTotal: total,
    hitRatio,
  };
}
