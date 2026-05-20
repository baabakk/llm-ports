/**
 * Tests for `createCapabilityLearner` — the shared per-process learner that
 * every adapter uses to track per-model parameter rejections.
 */

import { describe, it, expect } from "vitest";
import { createCapabilityLearner } from "../src/capabilities-learning.js";

describe("createCapabilityLearner", () => {
  it("returns empty ModelCapabilities for an unknown model", () => {
    const learner = createCapabilityLearner();
    expect(learner.get("unknown-model")).toEqual({});
  });

  it("user-supplied capabilities override learned ones", () => {
    const learner = createCapabilityLearner();
    learner.remember("m", { temperatureLocked: true });
    const effective = learner.get("m", { temperatureLocked: false });
    expect(effective.temperatureLocked).toBe(false);
  });

  it("remembers across calls within the same learner", () => {
    const learner = createCapabilityLearner();
    learner.remember("m", { temperatureLocked: true });
    expect(learner.get("m").temperatureLocked).toBe(true);
  });

  it("accumulates constraints on the same model", () => {
    const learner = createCapabilityLearner();
    learner.remember("m", { temperatureLocked: true });
    learner.remember("m", { jsonMode: false });
    const eff = learner.get("m");
    expect(eff.temperatureLocked).toBe(true);
    expect(eff.jsonMode).toBe(false);
  });

  it("_reset clears all learned state", () => {
    const learner = createCapabilityLearner();
    learner.remember("m", { temperatureLocked: true });
    learner._reset();
    expect(learner.get("m")).toEqual({});
  });

  it("two learners do not share state", () => {
    const a = createCapabilityLearner();
    const b = createCapabilityLearner();
    a.remember("m", { temperatureLocked: true });
    expect(a.get("m").temperatureLocked).toBe(true);
    expect(b.get("m").temperatureLocked).toBeUndefined();
  });

  describe("seedFromCatalog", () => {
    it("seeds matching patterns into the learned constraints", () => {
      const learner = createCapabilityLearner();
      learner.seedFromCatalog("claude-opus-4-5-20251001", [
        { pattern: /^claude-opus-4-5/, constraints: { temperatureLocked: true } },
        { pattern: /^claude-sonnet-4-5/, constraints: { temperatureLocked: true } },
      ]);
      expect(learner.get("claude-opus-4-5-20251001").temperatureLocked).toBe(true);
    });

    it("does not seed unmatched models", () => {
      const learner = createCapabilityLearner();
      learner.seedFromCatalog("gpt-4o-mini", [
        { pattern: /^claude-opus-4-5/, constraints: { temperatureLocked: true } },
      ]);
      expect(learner.get("gpt-4o-mini")).toEqual({});
    });

    it("seeding is idempotent", () => {
      const learner = createCapabilityLearner();
      const catalog = [{ pattern: /^m$/, constraints: { temperatureLocked: true } }];
      learner.seedFromCatalog("m", catalog);
      learner.seedFromCatalog("m", catalog);
      expect(learner.get("m").temperatureLocked).toBe(true);
    });
  });

  describe("hasLearned", () => {
    it("returns false for unknown models", () => {
      const learner = createCapabilityLearner();
      expect(learner.hasLearned("m", "temperatureLocked")).toBe(false);
    });

    it("returns true after the constraint is remembered", () => {
      const learner = createCapabilityLearner();
      learner.remember("m", { temperatureLocked: true });
      expect(learner.hasLearned("m", "temperatureLocked")).toBe(true);
    });

    it("returns false for constraints that were not learned", () => {
      const learner = createCapabilityLearner();
      learner.remember("m", { temperatureLocked: true });
      expect(learner.hasLearned("m", "jsonMode")).toBe(false);
    });
  });
});
