/**
 * CacheStats per Plan 58 v0.4 §4.5.
 *
 * The cache-accounting shape carried on `llm.attempt.completed` events
 * and on the terminal result objects returned by the LLMPort methods.
 * Distinguishes provider prompt-cache (Anthropic ephemeral cache,
 * OpenAI prompt cache, Google context caching) from semantic response
 * cache (Redis LangCache, GPTCache).
 *
 * Design principles per the outsider critique §8:
 *
 *   - Nested (`provider_cache` + `semantic_cache` sub-objects), not
 *     flattened. Provider prompt caching and semantic response caching
 *     are different layers; flattening them causes ambiguity.
 *
 *   - Explicit `status` enum on each layer. Required numeric fields
 *     (as in v0.3) made zero ambiguous ("provider reported zero" vs.
 *     "provider doesn't support caching" vs. "adapter didn't expose"
 *     vs. "request ineligible" vs. "stream terminated" vs. "cache
 *     missed"). Status disambiguates.
 *
 *   - `provider_reported: boolean` flag distinguishes "we got the
 *     number from the provider response" from "we synthesized zero
 *     because the field was absent".
 *
 *   - `cache_savings_usd` is deliberately NOT on this shape. Pricing
 *     changes over time; adapters should normalize provider behavior,
 *     not own historical financial calculations. Consumers compute
 *     savings from `read_input_tokens` against a versioned pricing
 *     table on their sink side.
 */

/**
 * Status of the provider prompt-cache layer for this attempt.
 *
 * "hit": at least one token was read from the provider's prompt cache.
 * "miss": provider prompt cache was consulted but returned no hit.
 * "partial": some tokens were served from cache, others were fresh
 *   (Anthropic multi-breakpoint cache, some OpenAI shapes).
 * "ineligible": request was ineligible for provider caching (too short,
 *   below the min-tokens threshold, etc.).
 * "unknown": adapter could not determine cache status. Rare; usually
 *   indicates a provider response shape the adapter didn't recognize.
 */
export type ProviderCacheStatus =
  | "hit"
  | "miss"
  | "partial"
  | "ineligible"
  | "unknown";

/**
 * Status of the semantic response-cache layer (Redis LangCache, GPTCache,
 * consumer-supplied lookups).
 *
 * "hit": the exact-prompt semantic cache returned a result; no provider
 *   call happened for this attempt.
 * "miss": semantic cache was consulted but returned no hit; provider
 *   call happened normally.
 * "bypassed": semantic cache was intentionally skipped for this attempt
 *   (e.g. consumer forced fresh generation, or ineligible task type).
 * "unknown": adapter is not composed with a semantic cache; the layer
 *   is not in play at all.
 */
export type SemanticCacheStatus = "hit" | "miss" | "bypassed" | "unknown";

/**
 * Provider prompt-cache accounting. Adapter-specific field names
 * (Anthropic `cache_creation_input_tokens`, OpenAI `cached_tokens`,
 * Google `cachedContentTokenCount`) map into this canonical shape at
 * the adapter boundary.
 */
export interface ProviderCacheStats {
  /** Status of the provider prompt-cache layer for this attempt. */
  status: ProviderCacheStatus;

  /**
   * Tokens billed at the cache-read rate. Anthropic
   * `cache_read_input_tokens`, OpenAI `cached_tokens`, Google
   * `usage.total_cached_tokens`.
   */
  read_input_tokens?: number;

  /**
   * Tokens billed at the cache-write rate (rarely reported; only
   * Anthropic exposes this today). Includes both 5m and 1h buckets
   * when present.
   */
  write_input_tokens?: number;

  /**
   * Anthropic-specific: tokens billed at the 5-minute ephemeral-write
   * rate (`ephemeral_5m_input_tokens`). Only populated when Anthropic
   * uses the split-write shape.
   */
  write_5m_input_tokens?: number;

  /**
   * Anthropic-specific: tokens billed at the 1-hour ephemeral-write
   * rate (`ephemeral_1h_input_tokens`).
   */
  write_1h_input_tokens?: number;

  /**
   * True when the adapter got these numbers from the provider response
   * body. False when the adapter synthesized zero because the field
   * was absent (e.g. non-supporting provider). Distinguishes "provider
   * reported no cache activity" from "provider does not report cache
   * activity".
   */
  provider_reported: boolean;
}

/**
 * Semantic response-cache accounting. Only populated when the adapter
 * is composed with a semantic cache layer.
 */
export interface SemanticCacheStats {
  /** Status of the semantic cache layer for this attempt. */
  status: SemanticCacheStatus;

  /**
   * Cosine similarity of the closest cache entry, in [0, 1]. Only
   * populated when status = "hit"; consumers use this to track
   * semantic drift over time (declining mean similarity indicates
   * the cache is degrading).
   */
  similarity?: number;

  /**
   * SHA-256 hex digest of the normalized prompt used as the cache key.
   * Content-free; enables cache-hit-rate breakdowns without exposing
   * prompt content.
   */
  key_hash?: string;

  /**
   * Wall-clock time spent looking up the semantic cache, milliseconds.
   * Populated on hit AND miss (both consulted the cache).
   */
  lookup_latency_ms?: number;
}

/**
 * Cache-accounting envelope. Both sub-objects are optional; adapters
 * populate whichever layer(s) are in play for the attempt.
 *
 * When both layers are absent from the event, the consumer knows: no
 * cache activity was observed for this attempt (semantic cache not
 * composed AND provider does not expose cache-usage fields).
 */
export interface CacheStats {
  provider_cache?: ProviderCacheStats;
  semantic_cache?: SemanticCacheStats;
}

/**
 * Convenience predicate: did this attempt read anything from any cache
 * layer? Consumers building "cache hit rate" dashboards use this
 * instead of manually inspecting both nested statuses.
 */
export function anyCacheHit(stats: CacheStats | undefined): boolean {
  if (!stats) return false;
  const p = stats.provider_cache?.status;
  const s = stats.semantic_cache?.status;
  return p === "hit" || p === "partial" || s === "hit";
}

/**
 * Convenience: total tokens read from the provider cache for this
 * attempt (across all Anthropic breakpoints when applicable). Returns
 * 0 when no provider cache read occurred.
 */
export function totalProviderCacheReadTokens(stats: CacheStats | undefined): number {
  return stats?.provider_cache?.read_input_tokens ?? 0;
}
