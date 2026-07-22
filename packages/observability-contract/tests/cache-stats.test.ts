/**
 * CacheStats tests: nested shape, status enums, convenience predicates.
 */

import { describe, expect, it } from "vitest";
import {
  anyCacheHit,
  totalProviderCacheReadTokens,
  type CacheStats,
  type ProviderCacheStats,
  type SemanticCacheStats,
} from "../src/index.js";

describe("CacheStats (§4.5)", () => {
  describe("ProviderCacheStats shape", () => {
    it("compiles a hit with read tokens + provider_reported: true", () => {
      const stats: ProviderCacheStats = {
        status: "hit",
        read_input_tokens: 4000,
        provider_reported: true,
      };
      expect(stats.status).toBe("hit");
      expect(stats.read_input_tokens).toBe(4000);
    });

    it("compiles a miss with no token fields (provider consulted, nothing to bill from cache)", () => {
      const stats: ProviderCacheStats = {
        status: "miss",
        provider_reported: true,
      };
      expect(stats.read_input_tokens).toBeUndefined();
    });

    it("compiles the Anthropic ephemeral 5m + 1h split", () => {
      const stats: ProviderCacheStats = {
        status: "partial",
        read_input_tokens: 8000,
        write_5m_input_tokens: 2000,
        write_1h_input_tokens: 3000,
        provider_reported: true,
      };
      expect(stats.write_5m_input_tokens).toBe(2000);
      expect(stats.write_1h_input_tokens).toBe(3000);
    });

    it("compiles ineligible + not-provider-reported (adapter synthesized)", () => {
      const stats: ProviderCacheStats = {
        status: "ineligible",
        provider_reported: false,
      };
      // Distinguishes "provider reported ineligible" (provider_reported=true)
      // from "adapter synthesized ineligible because we couldn't tell"
      // (provider_reported=false).
      expect(stats.provider_reported).toBe(false);
    });

    it("compiles unknown status", () => {
      const stats: ProviderCacheStats = {
        status: "unknown",
        provider_reported: false,
      };
      expect(stats.status).toBe("unknown");
    });
  });

  describe("SemanticCacheStats shape", () => {
    it("compiles a hit with similarity and key_hash", () => {
      const stats: SemanticCacheStats = {
        status: "hit",
        similarity: 0.95,
        key_hash: "sha256:abc123",
        lookup_latency_ms: 12,
      };
      expect(stats.similarity).toBe(0.95);
    });

    it("compiles a miss with just lookup_latency_ms (cache was consulted)", () => {
      const stats: SemanticCacheStats = {
        status: "miss",
        lookup_latency_ms: 8,
      };
      expect(stats.similarity).toBeUndefined();
    });

    it("compiles bypassed (cache intentionally skipped)", () => {
      const stats: SemanticCacheStats = { status: "bypassed" };
      expect(stats.status).toBe("bypassed");
    });

    it("compiles unknown (no semantic cache composed)", () => {
      const stats: SemanticCacheStats = { status: "unknown" };
      expect(stats.status).toBe("unknown");
    });
  });

  describe("CacheStats envelope", () => {
    it("both sub-objects optional (no cache activity observed)", () => {
      const stats: CacheStats = {};
      expect(stats.provider_cache).toBeUndefined();
      expect(stats.semantic_cache).toBeUndefined();
    });

    it("provider cache only (no semantic cache composed)", () => {
      const stats: CacheStats = {
        provider_cache: { status: "hit", read_input_tokens: 1000, provider_reported: true },
      };
      expect(stats.provider_cache?.status).toBe("hit");
      expect(stats.semantic_cache).toBeUndefined();
    });

    it("semantic cache only (short request, no provider cache eligibility)", () => {
      const stats: CacheStats = {
        semantic_cache: { status: "hit", similarity: 0.92 },
      };
      expect(stats.semantic_cache?.status).toBe("hit");
      expect(stats.provider_cache).toBeUndefined();
    });

    it("both layers populated (semantic hit means provider never called; still record the semantic hit)", () => {
      const stats: CacheStats = {
        provider_cache: { status: "unknown", provider_reported: false },
        semantic_cache: { status: "hit", similarity: 0.99 },
      };
      expect(stats.provider_cache?.status).toBe("unknown");
      expect(stats.semantic_cache?.status).toBe("hit");
    });
  });

  describe("anyCacheHit convenience predicate", () => {
    it("returns false for undefined stats", () => {
      expect(anyCacheHit(undefined)).toBe(false);
    });

    it("returns false for empty stats", () => {
      expect(anyCacheHit({})).toBe(false);
    });

    it("returns true for provider_cache.status: hit", () => {
      expect(anyCacheHit({
        provider_cache: { status: "hit", provider_reported: true },
      })).toBe(true);
    });

    it("returns true for provider_cache.status: partial", () => {
      expect(anyCacheHit({
        provider_cache: { status: "partial", provider_reported: true },
      })).toBe(true);
    });

    it("returns false for provider_cache.status: miss", () => {
      expect(anyCacheHit({
        provider_cache: { status: "miss", provider_reported: true },
      })).toBe(false);
    });

    it("returns true for semantic_cache.status: hit", () => {
      expect(anyCacheHit({
        semantic_cache: { status: "hit" },
      })).toBe(true);
    });

    it("returns false for semantic_cache.status: bypassed", () => {
      expect(anyCacheHit({
        semantic_cache: { status: "bypassed" },
      })).toBe(false);
    });

    it("returns true when EITHER layer hit", () => {
      expect(anyCacheHit({
        provider_cache: { status: "miss", provider_reported: true },
        semantic_cache: { status: "hit" },
      })).toBe(true);
    });
  });

  describe("totalProviderCacheReadTokens convenience", () => {
    it("returns 0 for undefined", () => {
      expect(totalProviderCacheReadTokens(undefined)).toBe(0);
    });

    it("returns 0 for empty stats", () => {
      expect(totalProviderCacheReadTokens({})).toBe(0);
    });

    it("returns 0 for miss (no tokens read)", () => {
      expect(totalProviderCacheReadTokens({
        provider_cache: { status: "miss", provider_reported: true },
      })).toBe(0);
    });

    it("returns the read count for a hit", () => {
      expect(totalProviderCacheReadTokens({
        provider_cache: { status: "hit", read_input_tokens: 4000, provider_reported: true },
      })).toBe(4000);
    });

    it("returns 0 when only semantic cache hit (provider cache not populated)", () => {
      expect(totalProviderCacheReadTokens({
        semantic_cache: { status: "hit" },
      })).toBe(0);
    });
  });
});
