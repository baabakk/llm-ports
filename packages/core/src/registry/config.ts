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
 * Gating tokens:
 *   req:N/hour       -> request-count limit per hour
 *   cost:N/day       -> USD limit per day (also: /hour, /month)
 *   unlimited        -> no gating (useful for local Ollama)
 *
 * See implementation plan v3 §6.6.
 */

import type { BudgetLimit, CostLimit } from "../budget/types.js";
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
      const { budgetLimit, costLimit } = parseGating(gatingStr ?? "unlimited", key);
      providers[alias] = {
        alias,
        adapter: adapter!.trim(),
        modelId: modelId!.trim(),
        budgetLimit,
        costLimit,
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
 * Parse a comma-separated gating string into BudgetLimit + CostLimit.
 * Examples:
 *   "req:200/hour"            -> request-only
 *   "cost:100/day"            -> cost-only
 *   "req:500/hour,cost:50/day" -> both apply (first to trip blocks)
 *   "unlimited"               -> no gating
 */
function parseGating(input: string, envKey: string): {
  budgetLimit: BudgetLimit;
  costLimit: CostLimit;
} {
  let budgetLimit: BudgetLimit = { kind: "unlimited" };
  let costLimit: CostLimit = { kind: "unlimited" };

  if (input.trim() === "unlimited") {
    return { budgetLimit, costLimit };
  }

  const tokens = input
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  for (const token of tokens) {
    if (token.startsWith("req:")) {
      const m = token.match(/^req:(\d+)\/hour$/);
      if (!m) throw new ConfigError(`Invalid request gating in ${envKey}: "${token}" (expected req:N/hour)`);
      budgetLimit = { kind: "requests", requestsPerHour: parseInt(m[1]!, 10) };
    } else if (token.startsWith("cost:")) {
      const m = token.match(/^cost:(\d+(?:\.\d+)?)\/(hour|day|month)$/);
      if (!m) {
        throw new ConfigError(
          `Invalid cost gating in ${envKey}: "${token}" (expected cost:N/{hour|day|month})`,
        );
      }
      const amount = parseFloat(m[1]!);
      const window = m[2] as "hour" | "day" | "month";
      const existing = costLimit.kind === "usd" ? costLimit : { kind: "usd" as const };
      costLimit = {
        ...existing,
        kind: "usd",
        ...(window === "hour" ? { perHour: amount } : {}),
        ...(window === "day" ? { perDay: amount } : {}),
        ...(window === "month" ? { perMonth: amount } : {}),
      };
    } else if (token === "unlimited") {
      // explicit unlimited; do nothing
    } else {
      throw new ConfigError(`Unknown gating token in ${envKey}: "${token}"`);
    }
  }

  return { budgetLimit, costLimit };
}
