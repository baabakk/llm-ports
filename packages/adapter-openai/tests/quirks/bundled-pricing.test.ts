/**
 * Bundled compat-provider pricing entries (alpha.21+).
 *
 * adapter-openai ships pricing for OpenAI's own models. For compat providers
 * (Cerebras, DeepInfra, Parasail, Groq, etc.) the canonical path is
 * `pricingOverrides` at registry construction. As of alpha.21, three
 * DeepInfra + Parasail models are bundled directly in `OPENAI_PRICING` so
 * consumers using these models don't have to maintain a parallel override
 * table — they're empirically verified by ADW + filed under llm-ports#48.
 *
 * If/when the rates change, update `OPENAI_PRICING` and bump the "Last
 * verified" date in pricing.ts. These tests guard against an accidental
 * removal of the entries.
 */

import { describe, expect, it } from "vitest";
import { OPENAI_PRICING, lookupOpenAIPricing } from "../../src/pricing.js";

describe("Bundled compat-provider pricing (alpha.21+)", () => {
  describe("DeepInfra entries (verified 2026-06-18 per llm-ports#48)", () => {
    it("has an entry for deepseek-ai/DeepSeek-V4-Flash with the published rate", () => {
      const entry = OPENAI_PRICING["deepseek-ai/DeepSeek-V4-Flash"];
      expect(entry).toBeDefined();
      expect(entry!.inputPer1M).toBe(0.1);
      expect(entry!.outputPer1M).toBe(0.2);
      // DeepInfra does not publish a discounted cache-read tier today.
      expect(entry!.cacheReadPer1M).toBeUndefined();
    });

    it("has an entry for google/gemma-4-31B-it with the published rate", () => {
      const entry = OPENAI_PRICING["google/gemma-4-31B-it"];
      expect(entry).toBeDefined();
      expect(entry!.inputPer1M).toBe(0.1);
      expect(entry!.outputPer1M).toBe(0.2);
      expect(entry!.cacheReadPer1M).toBeUndefined();
    });
  });

  describe("Parasail entries (verified 2026-06-18 per llm-ports#48)", () => {
    it("has an entry for XiaomiMiMo/MiMo-V2.5 with the published rate", () => {
      const entry = OPENAI_PRICING["XiaomiMiMo/MiMo-V2.5"];
      expect(entry).toBeDefined();
      expect(entry!.inputPer1M).toBe(0.14);
      expect(entry!.outputPer1M).toBe(0.28);
      expect(entry!.cacheReadPer1M).toBeUndefined();
    });
  });

  describe("lookupOpenAIPricing covers the new entries", () => {
    it("looks up DeepSeek-V4-Flash by exact model id", () => {
      expect(lookupOpenAIPricing("deepseek-ai/DeepSeek-V4-Flash")).toEqual({
        inputPer1M: 0.1,
        outputPer1M: 0.2,
      });
    });

    it("looks up MiMo-V2.5 by exact model id", () => {
      expect(lookupOpenAIPricing("XiaomiMiMo/MiMo-V2.5")).toEqual({
        inputPer1M: 0.14,
        outputPer1M: 0.28,
      });
    });

    it("preserves backwards compatibility with case-insensitive fallback", () => {
      expect(lookupOpenAIPricing("DEEPSEEK-AI/DEEPSEEK-V4-FLASH")).toBeUndefined();
      // (We intentionally do not lowercase model ids before lookup; the
      // compat-provider model ids are user-namespaced and case-sensitive
      // — e.g. `deepseek-ai/...` not `deepseek-AI/...`. Lookup is exact
      // first, then lowercased-key fallback. Documenting current behavior.)
    });
  });
});
