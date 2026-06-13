/**
 * Budget and cost gating types.
 *
 * Two pluggable backends, both optional. Most production users will use
 * the in-memory implementation in dev and a Redis-backed one (in a separate
 * package) in production.
 *
 * See implementation plan v3 §6.6.
 */

// ─── Budget scope (alpha.20+) ────────────────────────────────────────

/**
 * Five-tier scope hierarchy. The caller passes one of these in
 * `budgetScope?: { scope, scopeId }` on any per-call options interface
 * to make the gating storage key per-tenant / per-customer / per-user /
 * per-agent / per-session instead of just per-alias.
 *
 * Tier semantics (from outermost to innermost):
 *   - "tenant"   — the billing org.
 *   - "customer" — the end-customer of a multi-tenant SaaS.
 *   - "user"     — an individual identity.
 *   - "agent"    — a logical agent (workflow, automation, persona).
 *   - "session"  — a bounded run.
 *
 * Shipped in 0.1.0-alpha.20. The Registry composes storage keys as
 * `${alias}|${scope}:${scopeId}` when budgetScope is set; backwards
 * compatible: existing callers who omit budgetScope see identical
 * behavior to alpha.19.1.
 */
export type BudgetScope = "tenant" | "customer" | "user" | "agent" | "session";

/**
 * Per-call hint identifying which scope this call belongs to. Set on any
 * of the five request option types to make gating storage per-scope.
 */
export interface BudgetScopeRef {
  scope: BudgetScope;
  scopeId: string;
}

/**
 * Public type describing a single budget gate the caller can declare
 * programmatically (the documented shape for the next-level budget
 * surface shipping in beta.2 alongside the persistent BudgetBackend).
 * In alpha.20 the env-driven gates are still authoritative.
 */
export interface BudgetGate {
  scope: BudgetScope;
  scopeId: string;
  limitUsd: number;
  window: "minute" | "hour" | "day" | "month" | "session";
  onExceed: "throw" | "downgrade" | "queue";
}

// ─── Budget (request-count) gating ───────────────────────────────────

/**
 * Request-count gating. `kind: "requests"` carries optional per-window caps;
 * any combination is allowed, and the first cap to trip blocks the call.
 *
 * `requestsPerHour` exists for backwards compatibility with alpha.19 — the
 * `parseGating` token `req:N/hour` still writes that field. Backends
 * consume `perHour` if set, else fall back to `requestsPerHour`.
 */
export type BudgetLimit =
  | {
      kind: "requests";
      /**
       * @deprecated alpha.20 — use `perHour` instead. Still populated by
       * `parseGating` when it sees `req:N/hour` so existing env configs
       * keep working. Backends fall back to it when `perHour` is unset.
       */
      requestsPerHour?: number;
      /** Request ceiling per rolling minute window. (alpha.20+) */
      perMinute?: number;
      /** Request ceiling per rolling hour window. (alpha.20+) */
      perHour?: number;
      /**
       * Request ceiling per CostSession. (alpha.20+) Only enforced when a
       * CostSession is open; ignored on direct port calls.
       */
      perSession?: number;
    }
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
      /** USD ceiling per rolling minute. (alpha.20+) */
      perMinute?: number;
      /** USD ceiling per rolling hour. */
      perHour?: number;
      /** USD ceiling per rolling day (24h). */
      perDay?: number;
      /** USD ceiling per rolling 30-day window. */
      perMonth?: number;
      /**
       * USD ceiling per CostSession. (alpha.20+) Only enforced when a
       * CostSession is open; ignored on direct port calls.
       */
      perSession?: number;
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

// ─── Session-grain limits (alpha.20+) ────────────────────────────────

/**
 * Token / tool-call ceilings that apply within a single CostSession. The
 * env-driven `parseGating` tokens `total_tokens:N/session` and
 * `tool_calls:N/session` write to this shape. Only enforced when a
 * CostSession is open; ignored on direct port calls.
 */
export interface SessionGrainLimits {
  /** Total tokens (input + output, including reasoning + cache) per session. */
  totalTokensPerSession?: number;
  /** Tool / function calls per session (runAgent only). */
  toolCallsPerSession?: number;
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
  /**
   * Model-specific capability flags. Adapters consult these to adapt request
   * shape — the right pipeline for an older chat model isn't the same as the
   * right one for a reasoning model. Defaults assume "standard chat":
   * full temperature range, separate system message, JSON mode, streaming,
   * tool use, optional vision. Setting a flag to a non-default tells the
   * adapter to take a divergent path.
   *
   * Unknown future models without flags use the default assumptions plus a
   * runtime error fallback in the adapter (e.g. catch a temperature rejection
   * and retry without it).
   */
  capabilities?: ModelCapabilities;
}

/**
 * Model-specific behavior flags. Each flag describes what a model can do
 * differently from the standard chat-completion baseline. Adapters use these
 * to choose the right pipeline (standard chat, reasoning, etc.) per model.
 */
export interface ModelCapabilities {
  /**
   * Reasoning models (OpenAI o1/o3 family, gpt-5-nano) reject any non-default
   * temperature value. When true, the adapter omits `temperature` from the
   * request entirely, regardless of what the user set or what defaults the
   * capability factory chose.
   */
  temperatureLocked?: boolean;
  /**
   * Some reasoning models reject custom system messages. When true, the adapter
   * folds instructions into the user message instead of sending a separate
   * `system` field. (OpenAI o1-preview historically; later versions accept
   * system messages.)
   */
  systemMessageInUserOnly?: boolean;
  /**
   * Native JSON mode supported (e.g. OpenAI's `response_format: json_object`,
   * Ollama's `format: "json"`). When false or undefined, structured-output
   * capabilities use prompted JSON instead of the native mode. Defaults vary
   * by adapter — typically true for major chat models, false for reasoning
   * models that don't pair JSON mode with their reasoning pipeline.
   */
  jsonMode?: boolean;
  /** Streaming supported. Default: true. */
  streaming?: boolean;
  /** Tool/function calling supported. Default: true. */
  toolUse?: boolean;
  /** Vision input supported. Default: false (text-only is the historical baseline). */
  vision?: boolean;
  /**
   * Reasoning model: the provider's "max output tokens" parameter caps
   * BOTH the model's internal reasoning chain-of-thought AND the visible
   * output. With a small budget, the model can spend all of it on reasoning
   * and emit zero visible text. Adapters that detect this expand the budget
   * automatically — see {@link reasoningHeadroomMultiplier} below for the
   * factor applied. Adapters typically learn this flag at runtime from
   * the first response that reports reasoning_tokens > 0.
   */
  reasoningModel?: boolean;
  /**
   * For reasoning models, the multiplier applied to the user's
   * `maxOutputTokens` to produce the value sent to the provider. Defaults
   * to 10 (chosen so that a request for 20 visible output tokens gets a
   * 200-token total budget, leaving 180 for reasoning). Override per
   * model if you have specific knowledge of its reasoning intensity.
   */
  reasoningHeadroomMultiplier?: number;
}
