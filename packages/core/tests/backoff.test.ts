/**
 * BackoffConfig + computeBackoffDelay (alpha.17).
 *
 * Pure-function delay computation under four jitter strategies. Adapters
 * consume this when computing sleep duration between retries. The shape
 * matches Genkit's middleware retry config.
 */

import { describe, expect, it } from "vitest";
import { computeBackoffDelay } from "../src/retry.js";

describe("computeBackoffDelay", () => {
  describe("defaults", () => {
    it("uses initialDelayMs=200, maxDelayMs=10000, multiplier=2, jitter=decorrelated", () => {
      // Decorrelated with deterministic rng() = 0.5 and prevDelay=initial
      // → initial + 0.5 * (initial * 3 - initial) = 200 + 0.5 * 400 = 400
      const delay = computeBackoffDelay(0, {}, 200, () => 0.5);
      expect(delay).toBe(400);
    });
  });

  describe("jitter: 'none'", () => {
    it("returns pure exponential without jitter", () => {
      const config = { initialDelayMs: 100, multiplier: 2, jitter: "none" as const };
      expect(computeBackoffDelay(0, config, undefined, () => 0.5)).toBe(100);
      expect(computeBackoffDelay(1, config, undefined, () => 0.5)).toBe(200);
      expect(computeBackoffDelay(2, config, undefined, () => 0.5)).toBe(400);
      expect(computeBackoffDelay(3, config, undefined, () => 0.5)).toBe(800);
    });

    it("caps at maxDelayMs", () => {
      const config = {
        initialDelayMs: 100,
        maxDelayMs: 1000,
        multiplier: 2,
        jitter: "none" as const,
      };
      // 100 * 2^10 = 102400; capped at 1000
      expect(computeBackoffDelay(10, config, undefined, () => 0.5)).toBe(1000);
    });
  });

  describe("jitter: 'full'", () => {
    it("multiplies base delay by rng() in [0, 1)", () => {
      const config = { initialDelayMs: 200, multiplier: 2, jitter: "full" as const };
      expect(computeBackoffDelay(1, config, undefined, () => 0.0)).toBe(0);
      expect(computeBackoffDelay(1, config, undefined, () => 0.5)).toBe(200);
      expect(computeBackoffDelay(1, config, undefined, () => 0.99)).toBe(396);
    });
  });

  describe("jitter: 'equal'", () => {
    it("half base + random(0, half base)", () => {
      const config = { initialDelayMs: 200, multiplier: 2, jitter: "equal" as const };
      // attempt=1: base = 200 * 2 = 400 → 200 + rng() * 200
      expect(computeBackoffDelay(1, config, undefined, () => 0.0)).toBe(200);
      expect(computeBackoffDelay(1, config, undefined, () => 0.5)).toBe(300);
      expect(computeBackoffDelay(1, config, undefined, () => 1.0)).toBe(400);
    });
  });

  describe("jitter: 'decorrelated'", () => {
    it("samples uniformly between initial and 3*prevDelay, capped at max", () => {
      const config = {
        initialDelayMs: 100,
        maxDelayMs: 10000,
        jitter: "decorrelated" as const,
      };
      // prevDelay = 100 → range is [100, 300]; rng() = 0 → 100, rng() = 1 → 300
      expect(computeBackoffDelay(0, config, 100, () => 0)).toBe(100);
      expect(computeBackoffDelay(0, config, 100, () => 1)).toBe(300);
      // prevDelay = 300 → range is [100, 900]; rng() = 0.5 → 500
      expect(computeBackoffDelay(0, config, 300, () => 0.5)).toBe(500);
    });

    it("caps at maxDelayMs", () => {
      const config = {
        initialDelayMs: 100,
        maxDelayMs: 500,
        jitter: "decorrelated" as const,
      };
      // prevDelay = 1000 → range is [100, 3000]; capped at 500
      expect(computeBackoffDelay(0, config, 1000, () => 1)).toBe(500);
    });

    it("falls back to initialDelayMs when prevDelay is undefined", () => {
      const config = { initialDelayMs: 200, jitter: "decorrelated" as const };
      // prevDelay defaults to initial = 200 → range is [200, 600]; rng = 0.5 → 400
      expect(computeBackoffDelay(0, config, undefined, () => 0.5)).toBe(400);
    });
  });

  describe("multiplier customization", () => {
    it("respects multiplier=3 for steeper growth", () => {
      const config = { initialDelayMs: 100, multiplier: 3, jitter: "none" as const };
      expect(computeBackoffDelay(0, config, undefined, () => 0.5)).toBe(100);
      expect(computeBackoffDelay(1, config, undefined, () => 0.5)).toBe(300);
      expect(computeBackoffDelay(2, config, undefined, () => 0.5)).toBe(900);
    });

    it("respects multiplier=1 for constant delay", () => {
      const config = { initialDelayMs: 500, multiplier: 1, jitter: "none" as const };
      expect(computeBackoffDelay(0, config, undefined, () => 0.5)).toBe(500);
      expect(computeBackoffDelay(5, config, undefined, () => 0.5)).toBe(500);
    });
  });
});
