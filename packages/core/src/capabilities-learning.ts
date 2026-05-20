/**
 * Runtime capability discovery utility — shared across all adapters.
 *
 * Providers don't expose programmatic capability discovery (no API endpoint
 * tells you "this model rejects custom temperature" or "this model doesn't
 * support response_format: json_object"). Hardcoded capability tables go
 * stale every time a new model ships.
 *
 * The pattern that works:
 *
 *   1. The adapter tries the call with the parameter included.
 *   2. If the provider returns a 400 matching a known "deprecated parameter"
 *      shape, the adapter calls `learner.remember(modelId, { ... })`.
 *   3. The adapter strips the parameter and retries the call.
 *   4. Every subsequent call in this process applies the learned constraint
 *      up front. No re-discovery.
 *
 * Each adapter contributes its own error classifiers (which provider error
 * shape signals which capability rejection) and its own static catalog of
 * known rejectors (so first-call discovery can be skipped for models we
 * already know reject the parameter). The pattern itself — the Map, the
 * accumulation, the user-override layering, the static-catalog seeding — is
 * what this module provides.
 *
 * Hoisted from adapter-openai's per-adapter copy in alpha.3 so every adapter
 * shares the same discovery machinery.
 */

import type { ModelCapabilities } from "./budget/types.js";

/**
 * One entry in the static "we already know this model rejects X" catalog.
 *
 * Adapters maintain their own catalog (the exact model patterns are
 * provider-specific) and pass it to `learner.seedFromCatalog(modelId, catalog)`
 * at port creation time. Matching entries pre-seed the learned-constraint
 * Map so the first call skips the discovery round-trip.
 */
export interface KnownModelConstraint {
  /** Regex matched against the model id, e.g. `/^claude-opus-4-5/`. */
  pattern: RegExp;
  /** The constraint to remember when the pattern matches. */
  constraints: Partial<ModelCapabilities>;
}

/**
 * Per-process learner of per-model capability constraints. Each call to
 * `createCapabilityLearner()` returns a fresh learner with its own Map.
 *
 * Adapters create one learner per adapter context (typically per LLMPort
 * instance) and reference it in their retry loops. The learner is internal
 * state of the adapter; it's not part of any port's public surface.
 */
export interface CapabilityLearner {
  /**
   * Resolve the effective capabilities for a model. User-supplied
   * capabilities (passed via `pricingOverrides[modelId].capabilities`)
   * override learned ones; learned ones override defaults.
   */
  get(modelId: string, userSupplied?: ModelCapabilities): ModelCapabilities;

  /**
   * Record a discovered constraint after the provider returns an error that
   * signals the capability rejection. Accumulates: subsequent calls add more
   * constraints to the same model entry without losing prior ones.
   */
  remember(modelId: string, constraints: Partial<ModelCapabilities>): void;

  /**
   * Test-only: clear all learned state. Should not be used in production code.
   */
  _reset(): void;

  /**
   * Seed the learner with static "we already know this model rejects X"
   * entries. Adapters call this at port creation with their per-provider
   * catalog. Pre-seeding skips the first-call discovery round-trip.
   *
   * Idempotent: re-seeding the same catalog adds the same constraints. The
   * underlying Map is set-based; duplicate entries are harmless.
   */
  seedFromCatalog(modelId: string, catalog: readonly KnownModelConstraint[]): void;

  /**
   * True if the learner has already learned (or been seeded with) a given
   * capability flag for a model. Used by `emitFirstLearningWarning` to fire
   * the click-to-file URL once per modelId per process.
   */
  hasLearned(modelId: string, capabilityFlag: keyof ModelCapabilities): boolean;
}

/** Factory: returns a fresh capability learner with no learned state. */
export function createCapabilityLearner(): CapabilityLearner {
  const learnedConstraints = new Map<string, ModelCapabilities>();

  return {
    get(modelId, userSupplied) {
      const learned = learnedConstraints.get(modelId) ?? {};
      return { ...learned, ...userSupplied };
    },

    remember(modelId, constraints) {
      const existing = learnedConstraints.get(modelId) ?? {};
      learnedConstraints.set(modelId, { ...existing, ...constraints });
    },

    _reset() {
      learnedConstraints.clear();
    },

    seedFromCatalog(modelId, catalog) {
      for (const entry of catalog) {
        if (entry.pattern.test(modelId)) {
          this.remember(modelId, entry.constraints);
        }
      }
    },

    hasLearned(modelId, capabilityFlag) {
      const learned = learnedConstraints.get(modelId);
      if (!learned) return false;
      return learned[capabilityFlag] !== undefined;
    },
  };
}
