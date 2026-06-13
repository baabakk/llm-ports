/**
 * Env config parser for the registry.
 *
 * Reads `LLM_PROVIDER_*` and `LLM_TASK_ROUTE_*` entries from a record
 * (typically `process.env`) and returns a structured config the registry
 * uses for routing.
 *
 * Format:
 *   LLM_PROVIDER_<ALIAS>=<adapter>|<modelId>|<gating>[,<gating>...]
 *   LLM_TASK_ROUTE_<TASK>=<alias>[,<alias>...]
 *
 * Gating tokens (alpha.20):
 *   req:N/{minute|hour|session}                       -> request-count limit
 *   cost:N/{minute|hour|day|month|session}            -> USD limit
 *   total_tokens:N/session                            -> tokens per CostSession
 *   tool_calls:N/session                              -> tool calls per CostSession
 *   unlimited                                         -> no gating (useful for local Ollama)
 *
 * Backwards compatible: `req:N/hour` and `cost:N/{hour|day|month}` from
 * alpha.19 keep working unchanged. `req:N/hour` still writes the legacy
 * `requestsPerHour` field for backend backwards compat.
 *
 * See docs/concepts/task-routing for the full design rationale.
 */

import type { BudgetLimit, CostLimit, SessionGrainLimits } from "../budget/types.js";
import { ConfigError } from "../errors.js";

export interface ProviderEntry {
  /** User-chosen alias (lowercase, derived from env var name). */
  alias: string;
  /** Which adapter implementation this alias uses ("anthropic", "openai", "ollama", "vercel"). */
  adapter: string;
  /** Provider-specific model id. */
  modelId: string;
  budgetLimit: BudgetLimit;
  costLimit: CostLimit;
  /** Session-grain limits (token + tool-call ceilings). Enforced by CostSession. (alpha.20+) */
  sessionLimits?: SessionGrainLimits;
}

export interface RegistryConfig {
  providers: Record<string, ProviderEntry>;
  /** Maps task type -> ordered fallback chain of provider aliases. */
  taskRoutes: Record<string, string[]>;
}

export interface ParseConfigOptions {
  /** Env var prefix. Default: "LLM_". */
  envPrefix?: string;
  /** Source record. Default: process.env. */
  env?: Record<string, string | undefined>;
}

export function parseRegistryConfig(opts: ParseConfigOptions = {}): RegistryConfig {
  const prefix = opts.envPrefix ?? "LLM_";
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});

  const providers: Record<string, ProviderEntry> = {};
  const taskRoutes: Record<string, string[]> = {};

  for (const [key, rawValue] of Object.entries(env)) {
    if (!rawValue) continue;
    const value = rawValue.trim();

    if (key.startsWith(`${prefix}PROVIDER_`)) {
      const alias = key.slice(`${prefix}PROVIDER_`.length).toLowerCase().replace(/_/g, "-");
      const parts = value.split("|");
      if (parts.length < 3) {
        throw new ConfigError(
          `Invalid ${key}: expected "<adapter>|<modelId>|<gating>[,<gating>...]", got "${value}"`,
        );
      }
      const [adapter, modelId, gatingStr] = parts;
      const { budgetLimit, costLimit, sessionLimits } = parseGating(gatingStr ?? "unlimited", key);
      providers[alias] = {
        alias,
        adapter: adapter!.trim(),
        modelId: modelId!.trim(),
        budgetLimit,
        costLimit,
        ...(sessionLimits ? { sessionLimits } : {}),
      };
    } else if (key.startsWith(`${prefix}TASK_ROUTE_`)) {
      const taskName = key.slice(`${prefix}TASK_ROUTE_`.length).toLowerCase().replace(/_/g, "-");
      const chain = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (chain.length === 0) {
        throw new ConfigError(`Invalid ${key}: empty fallback chain`);
      }
      taskRoutes[taskName] = chain;
    }
  }

  return { providers, taskRoutes };
}

/**
 * Parse a comma-separated gating string into BudgetLimit + CostLimit +
 * SessionGrainLimits. Examples:
 *
 *   "req:200/hour"                         -> request-only
 *   "cost:100/day"                         -> cost-only
 *   "req:30/minute,cost:50/day"            -> minute-grain rate limit + daily USD cap
 *   "req:500/hour,cost:50/day"             -> both apply (first to trip blocks)
 *   "cost:1.00/session,total_tokens:50000/session,tool_calls:8/session"
 *                                          -> session-grain ceilings (enforced by CostSession)
 *   "unlimited"                            -> no gating
 *
 * Backwards compatible: `req:N/hour` from alpha.19 still writes the legacy
 * `requestsPerHour` field so existing backend wiring keeps working.
 */
function parseGating(input: string, envKey: string): {
  budgetLimit: BudgetLimit;
  costLimit: CostLimit;
  sessionLimits?: SessionGrainLimits;
} {
  let budgetLimit: BudgetLimit = { kind: "unlimited" };
  let costLimit: CostLimit = { kind: "unlimited" };
  let sessionLimits: SessionGrainLimits | undefined;

  if (input.trim() === "unlimited") {
    return { budgetLimit, costLimit };
  }

  const tokens = input
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  function ensureRequests(): Extract<BudgetLimit, { kind: "requests" }> {
    if (budgetLimit.kind !== "requests") {
      budgetLimit = { kind: "requests" };
    }
    return budgetLimit;
  }

  function ensureUsd(): Extract<CostLimit, { kind: "usd" }> {
    if (costLimit.kind !== "usd") {
      costLimit = { kind: "usd" };
    }
    return costLimit;
  }

  function ensureSession(): SessionGrainLimits {
    if (!sessionLimits) sessionLimits = {};
    return sessionLimits;
  }

  for (const token of tokens) {
    if (token.startsWith("req:")) {
      const m = token.match(/^req:(\d+)\/(minute|hour|session)$/);
      if (!m) {
        throw new ConfigError(
          `Invalid request gating in ${envKey}: "${token}" (expected req:N/{minute|hour|session})`,
        );
      }
      const amount = parseInt(m[1]!, 10);
      const window = m[2] as "minute" | "hour" | "session";
      const next = ensureRequests();
      if (window === "minute") next.perMinute = amount;
      else if (window === "hour") {
        next.perHour = amount;
        // Backwards-compat: legacy field still populated so older backends
        // that haven't been upgraded to read `perHour` keep working.
        next.requestsPerHour = amount;
      } else if (window === "session") next.perSession = amount;
    } else if (token.startsWith("cost:")) {
      const m = token.match(/^cost:(\d+(?:\.\d+)?)\/(minute|hour|day|month|session)$/);
      if (!m) {
        throw new ConfigError(
          `Invalid cost gating in ${envKey}: "${token}" (expected cost:N/{minute|hour|day|month|session})`,
        );
      }
      const amount = parseFloat(m[1]!);
      const window = m[2] as "minute" | "hour" | "day" | "month" | "session";
      const next = ensureUsd();
      if (window === "minute") next.perMinute = amount;
      else if (window === "hour") next.perHour = amount;
      else if (window === "day") next.perDay = amount;
      else if (window === "month") next.perMonth = amount;
      else if (window === "session") next.perSession = amount;
    } else if (token.startsWith("total_tokens:")) {
      const m = token.match(/^total_tokens:(\d+)\/session$/);
      if (!m) {
        throw new ConfigError(
          `Invalid session-grain gating in ${envKey}: "${token}" (expected total_tokens:N/session)`,
        );
      }
      ensureSession().totalTokensPerSession = parseInt(m[1]!, 10);
    } else if (token.startsWith("tool_calls:")) {
      const m = token.match(/^tool_calls:(\d+)\/session$/);
      if (!m) {
        throw new ConfigError(
          `Invalid session-grain gating in ${envKey}: "${token}" (expected tool_calls:N/session)`,
        );
      }
      ensureSession().toolCallsPerSession = parseInt(m[1]!, 10);
    } else if (token === "unlimited") {
      // explicit unlimited; do nothing
    } else {
      throw new ConfigError(`Unknown gating token in ${envKey}: "${token}"`);
    }
  }

  return sessionLimits ? { budgetLimit, costLimit, sessionLimits } : { budgetLimit, costLimit };
}
